import { execFile } from 'node:child_process';
import { basename } from 'node:path';

/**
 * GitHub とのやり取り。すべて gh コマンド経由で行う。
 *
 * - 自分のPC: `gh auth login` 済みの認証をそのまま使う（トークンをこのプログラムで扱わない）
 * - GitHub Actions: 環境変数 GH_TOKEN に github.token を渡す
 */

export const MANUAL_WORKFLOW = 'manual-post.yml';

function gh(args: string[], input?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'gh',
      args,
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim();
          reject(new Error(`gh ${args.slice(0, 2).join(' ')} に失敗しました: ${detail}`));
          return;
        }
        resolvePromise(stdout);
      },
    );
    child.stdin?.end(input ?? '');
  });
}

function isNotFound(error: unknown): boolean {
  return /HTTP 404|not found/i.test((error as Error).message);
}

export interface RemoteFile {
  path: string;
  sha: string;
  text: string;
}

export async function checkGhReady(): Promise<void> {
  try {
    await gh(['auth', 'status']);
  } catch {
    throw new Error(
      'gh コマンドで GitHub にログインしていません。コマンドプロンプトで gh auth login を実行してください。',
    );
  }
}

export async function getFile(repo: string, path: string): Promise<RemoteFile | null> {
  try {
    const out = await gh(['api', `repos/${repo}/contents/${path}`]);
    const data = JSON.parse(out) as { path: string; sha: string; content: string };
    return { path: data.path, sha: data.sha, text: Buffer.from(data.content, 'base64').toString('utf8') };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function listDir(
  repo: string,
  path: string,
): Promise<{ name: string; path: string; sha: string }[]> {
  try {
    const out = await gh(['api', `repos/${repo}/contents/${path}`]);
    const data = JSON.parse(out) as { name: string; path: string; sha: string; type: string }[];
    return Array.isArray(data) ? data.filter((d) => d.type === 'file') : [];
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
}

/** ファイルを作成・更新する。更新のときは sha が必要（他の人の変更を上書きしないため）。 */
export async function putFile(
  repo: string,
  path: string,
  text: string,
  message: string,
  sha?: string,
): Promise<void> {
  const body = {
    message,
    content: Buffer.from(text, 'utf8').toString('base64'),
    ...(sha ? { sha } : {}),
  };
  await gh(['api', '-X', 'PUT', `repos/${repo}/contents/${path}`, '--input', '-'], JSON.stringify(body));
}

export async function deleteFile(repo: string, path: string, sha: string, message: string): Promise<void> {
  await gh(
    ['api', '-X', 'DELETE', `repos/${repo}/contents/${path}`, '--input', '-'],
    JSON.stringify({ message, sha }),
  );
}

/**
 * 画像・動画を GitHub Release に一時的に置き、公開URLを返す。
 * Threads / Instagram はファイルを直接受け取らず、公開URLしか受け付けないため。
 */
export async function createRelease(repo: string, tag: string, filePath: string): Promise<string> {
  await gh([
    'release',
    'create',
    tag,
    filePath,
    '--repo',
    repo,
    '--title',
    `予約投稿用の一時ファイル ${tag}`,
    '--notes',
    '予約投稿用の一時ファイルです。投稿が終わると自動で削除されます。',
    '--prerelease',
    '--latest=false',
  ]);
  return `https://github.com/${repo}/releases/download/${tag}/${basename(filePath)}`;
}

/** Release とタグを削除する。既に無ければ何もしない。 */
export async function deleteRelease(repo: string, tag: string): Promise<void> {
  try {
    await gh(['release', 'delete', tag, '--repo', repo, '--yes', '--cleanup-tag']);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/** 予約投稿のワークフローをすぐに動かす（「今すぐ投稿」と「再試行」で使う）。 */
export async function triggerManualRun(repo: string): Promise<void> {
  await gh(['workflow', 'run', MANUAL_WORKFLOW, '--repo', repo]);
}
