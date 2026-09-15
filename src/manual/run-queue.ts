import { execFileSync } from 'node:child_process';
import { loadConfig, loadDotEnv } from '../config.js';
import { warmUpImageUrl } from '../image.js';
import { deleteRelease } from './github.js';
import { PUBLISHERS } from './publish.js';
import {
  PLATFORMS,
  PLATFORM_LABELS,
  formatJst,
  listLocalItems,
  moveLocalItemToDone,
  summarize,
  writeLocalItem,
} from './queue.js';

/**
 * 予定時刻を過ぎた予約を投稿する（GitHub Actions の manual-post.yml から15分ごとに実行）。
 *
 * 二重投稿を防ぐため、投稿する前に「投稿処理中」を記録して push する。
 * push できなかった（投稿画面で取り消された等）ときは投稿しない。
 */

loadDotEnv();

/**
 * 「投稿処理中」のまま、これより長く経っていたら途中で止まったとみなす。
 * ワークフローの timeout-minutes（45分）より長くしておくこと。
 */
const STALE_MS = 60 * 60 * 1000;

const dryRun = process.argv.includes('--dry-run');
const inActions = process.env.GITHUB_ACTIONS === 'true';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** queue/ の変更をコミットして push する。push できなかったら false。 */
function commitQueue(message: string): boolean {
  if (!inActions) {
    console.log(`（GitHub Actions ではないのでコミットしません: ${message}）`);
    return true;
  }
  git(['add', '-A', 'queue']);
  if (!git(['status', '--porcelain', 'queue']).trim()) return true;
  git([
    '-c',
    'user.name=github-actions[bot]',
    '-c',
    'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit',
    '-m',
    `${message} [skip ci]`,
  ]);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      git(['push']);
      return true;
    } catch {
      console.warn(`  push に失敗しました（${attempt + 1}回目）。最新の変更を取り込んで再試行します。`);
      try {
        git(['pull', '--rebase']);
      } catch {
        console.error('  最新の変更と食い違いました（投稿画面で予約が削除・変更された可能性があります）。');
        try {
          git(['rebase', '--abort']);
        } catch {
          /* rebase 中でなければ何もしない */
        }
        return false;
      }
    }
  }
  return false;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const repo = process.env.GITHUB_REPOSITORY || config.manualPost.repo;
  const now = Date.now();
  const entries = listLocalItems();

  // 1. 途中で止まった投稿を「失敗」にする。投稿されたか分からないので、自動では再投稿しない。
  let staleFound = false;
  for (const entry of entries) {
    for (const result of Object.values(entry.item.platforms)) {
      if (result?.status !== 'in_progress') continue;
      if (now - Date.parse(result.at ?? entry.item.scheduledAt) < STALE_MS) continue;
      result.status = 'failed';
      result.error =
        '前回の投稿処理が途中で止まりました。二重投稿を避けるため自動では再投稿していません。' +
        'このSNSに投稿されているか確認し、されていなければ再試行してください。';
      result.at = new Date().toISOString();
      writeLocalItem(entry);
      staleFound = true;
    }
  }
  if (staleFound && !dryRun) commitQueue('予約投稿: 途中で止まった投稿を失敗扱いにする');

  const due = entries.filter(
    (e) =>
      Date.parse(e.item.scheduledAt) <= now &&
      Object.values(e.item.platforms).some((r) => r?.status === 'pending'),
  );
  console.log(`予約データ ${entries.length} 件のうち、投稿する時刻を過ぎたもの ${due.length} 件`);

  if (dryRun) {
    for (const { item } of due) {
      const targets = PLATFORMS.filter((p) => item.platforms[p]?.status === 'pending');
      console.log(`- ${item.id}（予定 ${formatJst(item.scheduledAt)}）→ ${targets.map((p) => PLATFORM_LABELS[p]).join('、')}`);
    }
    console.log('dry-run のため、投稿も記録もしていません。');
    return;
  }

  let anyFailed = false;
  for (const entry of due) {
    const { item } = entry;
    const targets = PLATFORMS.filter((p) => item.platforms[p]?.status === 'pending');

    for (const p of targets) item.platforms[p] = { status: 'in_progress', at: new Date().toISOString() };
    writeLocalItem(entry);
    if (!commitQueue(`予約投稿を開始 ${item.id}`)) {
      console.error('MANUAL_POST_FAILED 予約データを更新できなかったため、投稿を中止しました。');
      process.exitCode = 1;
      return;
    }

    console.log('');
    console.log(`=== ${item.id}（予定 ${formatJst(item.scheduledAt)}）===`);

    let cached: Buffer | undefined;
    const loadMedia = async (): Promise<Buffer> => {
      if (!item.media) throw new Error('添付ファイルがありません。');
      if (!cached) {
        const response = await fetch(item.media.url);
        if (!response.ok) throw new Error(`添付ファイルを取得できませんでした（HTTP ${response.status}）。`);
        cached = Buffer.from(await response.arrayBuffer());
      }
      return cached;
    };

    let publicImageUrl: string | undefined;
    for (const platform of targets) {
      console.log(`${PLATFORM_LABELS[platform]} へ投稿しています...`);
      try {
        const result = await PUBLISHERS[platform]({ text: item.text, media: item.media, loadMedia, publicImageUrl });
        item.platforms[platform] = { status: 'done', uri: result.uri, at: new Date().toISOString() };
        console.log(`  成功: ${result.uri}`);
        if (result.publicImageUrl && !publicImageUrl) {
          publicImageUrl = result.publicImageUrl;
          // 後続のSNSが取りに行く前に、CDNで画像が生成されるのを待つ
          await warmUpImageUrl(publicImageUrl);
        }
      } catch (error) {
        const message = (error as Error).message;
        item.platforms[platform] = { status: 'failed', error: message, at: new Date().toISOString() };
        anyFailed = true;
        console.error(`  失敗: ${message}`);
      }
      writeLocalItem(entry);
    }

    if (summarize(item) === 'done') {
      if (item.media) {
        try {
          await deleteRelease(repo, item.media.releaseTag);
          console.log('GitHub に置いていた一時ファイルを削除しました。');
        } catch (error) {
          console.warn(`一時ファイルを削除できませんでした: ${(error as Error).message}`);
        }
      }
      moveLocalItemToDone(entry);
    }

    if (!commitQueue(`予約投稿の結果を記録 ${item.id}`)) {
      console.error('MANUAL_POST_FAILED 投稿の結果を記録できませんでした。');
      process.exitCode = 1;
      return;
    }
  }

  if (anyFailed) {
    console.error('MANUAL_POST_FAILED 一部のSNSへの投稿に失敗しました。投稿画面の予約一覧で内容を確認できます。');
    process.exitCode = 1;
  }
}

main().catch((error: Error) => {
  console.error('MANUAL_POST_FAILED', error.message);
  process.exitCode = 1;
});
