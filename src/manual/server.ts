import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { loadConfig } from '../config.js';
import * as github from './github.js';
import { prepareMedia } from './media-prepare.js';
import {
  PLATFORMS,
  PLATFORM_LABELS,
  QUEUE_DIR,
  SUMMARY_LABELS,
  formatJst,
  isPlatform,
  itemPath,
  newItemId,
  serializeItem,
  summarize,
  type QueueItem,
  type QueueMedia,
} from './queue.js';
import { LIMITS, validateDraft } from './validate.js';

/**
 * 投稿画面（自分のPCだけで動くWebサーバー）。
 *
 *   npm run ui
 *
 * 予約データは GitHub に保存するので、この画面を閉じても・PCの電源を切っても予約は実行される。
 * 他のWebサイトから勝手に投稿されないよう、127.0.0.1 でだけ待ち受け、
 * 操作には画面に埋め込んだ合言葉（CSRFトークン）を必須にしている。
 */

const config = loadConfig();
const { repo, port } = config.manualPost;
const csrfToken = randomBytes(24).toString('hex');
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

/** 変換前の動画も受け取るので、100MB より大きめにしておく（変換後に100MBで判定する）。 */
const MAX_REQUEST_BYTES = 300 * 1024 * 1024;

const pageTemplate = readFileSync(new URL('./page.html', import.meta.url), 'utf8');

class UserError extends Error {
  constructor(
    readonly messages: string[],
    readonly status = 400,
  ) {
    super(messages.join('\n'));
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function renderPage(): string {
  const bootstrap = {
    csrfToken,
    platforms: PLATFORMS.map((id) => ({ id, label: PLATFORM_LABELS[id], account: config.manualPost.accounts[id] ?? '' })),
    limits: {
      bluesky: LIMITS.blueskyText,
      threads: LIMITS.threadsText,
      instagram: LIMITS.instagramText,
      facebook: LIMITS.facebookText,
    },
  };
  // </script> で閉じられないように < をエスケープして埋め込む
  const json = JSON.stringify(bootstrap).replace(/</g, '\\u003c');
  return pageTemplate.replace('/*BOOTSTRAP*/null', json);
}

/** datetime-local の値（日本時間）を ISO8601 に変換する。 */
function jstInputToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}:00+09:00`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function guessKind(file: File): 'image' | 'video' | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'avif', 'tif', 'tiff'].includes(ext)) return 'image';
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'wmv', 'mpg', 'mpeg', '3gp'].includes(ext)) return 'video';
  return null;
}

async function readForm(req: IncomingMessage): Promise<FormData> {
  const length = Number(req.headers['content-length'] ?? 0);
  if (length > MAX_REQUEST_BYTES) throw new UserError(['添付ファイルが大きすぎます（300MBまで）。'], 413);
  const request = new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] ?? '' },
    body: Readable.toWeb(req) as ReadableStream,
    duplex: 'half',
  } as RequestInit);
  return request.formData();
}

async function loadQueue() {
  const files = await github.listDir(repo, QUEUE_DIR);
  const items = await Promise.all(
    files
      .filter((f) => f.name.endsWith('.json'))
      .map(async (f) => {
        const file = await github.getFile(repo, f.path);
        if (!file) return null;
        const item = JSON.parse(file.text) as QueueItem;
        const summary = summarize(item);
        return { ...item, summary, summaryLabel: SUMMARY_LABELS[summary] };
      }),
  );
  return items
    .filter((i): i is NonNullable<typeof i> => i !== null)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

async function createPost(req: IncomingMessage) {
  const form = await readForm(req);
  const now = new Date();
  const text = String(form.get('text') ?? '').replace(/\r\n/g, '\n').trim();
  const selected = form.getAll('platforms').map(String);
  const platforms = PLATFORMS.filter((p) => selected.includes(p));
  const postNow = form.get('postNow') === '1';
  const alt = String(form.get('alt') ?? '').trim();
  const fileEntry = form.get('file');
  const file = fileEntry instanceof File && fileEntry.size > 0 ? fileEntry : null;

  const errors: string[] = [];
  let scheduledAt = now.toISOString();
  if (!postNow) {
    const iso = jstInputToIso(String(form.get('scheduledAt') ?? ''));
    if (!iso) errors.push('予約する日時を入力するか、「今すぐ投稿」を選んでください。');
    else if (Date.parse(iso) < now.getTime() - 60_000) errors.push('過去の日時は予約できません。');
    else scheduledAt = iso;
  }
  const kind = file ? guessKind(file) : null;
  if (file && !kind) errors.push('添付できるのは画像か動画だけです。');

  // 重い動画変換の前に、文字数などを先に確認する
  errors.push(...validateDraft({ text, platforms, media: kind ? { kind, bytes: 0, alt } : null }));
  if (errors.length) throw new UserError([...new Set(errors)]);

  const id = newItemId(now);
  let media: QueueMedia | null = null;
  let converted = false;

  if (file && kind) {
    console.log(`${kind === 'video' ? '動画' : '画像'}を準備しています: ${file.name}`);
    const prepared = await prepareMedia(Buffer.from(await file.arrayBuffer()), kind, id);
    try {
      const mediaErrors = validateDraft({
        text,
        platforms,
        media: { kind: prepared.kind, bytes: prepared.bytes, durationSec: prepared.durationSec, alt },
      });
      if (mediaErrors.length) throw new UserError(mediaErrors);

      console.log('GitHub に一時ファイルを置いています...');
      const releaseTag = `manual-${id}`;
      const url = await github.createRelease(repo, releaseTag, prepared.filePath);
      converted = prepared.kind === 'video' && prepared.converted;
      media = {
        kind: prepared.kind,
        fileName: prepared.fileName,
        mimeType: prepared.mimeType,
        bytes: prepared.bytes,
        width: prepared.width,
        height: prepared.height,
        ...(prepared.durationSec !== undefined ? { durationSec: prepared.durationSec } : {}),
        alt,
        url,
        releaseTag,
      };
    } finally {
      await prepared.cleanup();
    }
  }

  const item: QueueItem = {
    version: 1,
    id,
    createdAt: now.toISOString(),
    scheduledAt,
    text,
    media,
    platforms: Object.fromEntries(platforms.map((p) => [p, { status: 'pending' }])),
  };

  try {
    await github.putFile(repo, itemPath(id), serializeItem(item), `予約投稿を追加 ${id}`);
  } catch (error) {
    if (media) await github.deleteRelease(repo, media.releaseTag).catch(() => {});
    throw error;
  }

  const notes: string[] = [];
  if (converted) notes.push('動画は投稿できる形式に変換しました。');
  if (postNow) {
    await github.triggerManualRun(repo);
    notes.unshift('投稿を受け付けました。数分以内に投稿されます。');
  } else {
    notes.unshift(`${formatJst(scheduledAt)} に予約しました。予約時刻から15〜30分ほど遅れることがあります。`);
  }
  console.log(`予約を保存しました: ${id}`);
  return { id, message: notes.join('') };
}

async function loadItemForChange(id: string) {
  if (!/^[\w-]+$/.test(id)) throw new UserError(['予約のIDが正しくありません。']);
  const file = await github.getFile(repo, itemPath(id));
  if (!file) throw new UserError(['この予約は見つかりませんでした。投稿済みか、既に削除されています。'], 404);
  const item = JSON.parse(file.text) as QueueItem;
  if (summarize(item) === 'posting') {
    throw new UserError(['いま投稿処理中のため操作できません。数分待ってから一覧を更新してください。'], 409);
  }
  return { file, item };
}

async function deletePost(id: string) {
  const { file, item } = await loadItemForChange(id);
  await github.deleteFile(repo, file.path, file.sha, `予約投稿を削除 ${id}`);
  if (item.media) await github.deleteRelease(repo, item.media.releaseTag);
  return { message: '削除しました。' };
}

async function retryPost(id: string) {
  const { file, item } = await loadItemForChange(id);
  const failed = PLATFORMS.filter((p) => item.platforms[p]?.status === 'failed');
  if (failed.length === 0) throw new UserError(['失敗したSNSはありません。']);
  for (const p of failed) item.platforms[p] = { status: 'pending' };
  item.scheduledAt = new Date().toISOString();
  await github.putFile(repo, file.path, serializeItem(item), `予約投稿を再試行 ${id}`, file.sha);
  await github.triggerManualRun(repo);
  return {
    message: `${failed.map((p) => PLATFORM_LABELS[p]).join('、')} への投稿をやり直します。数分以内に投稿されます。`,
  };
}

const server = createServer(async (req, res) => {
  try {
    // 他のサイトからの DNS リバインディング対策
    if (!allowedHosts.has(req.headers.host ?? '')) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' blob: data:; media-src blob:",
        'X-Frame-Options': 'DENY',
      });
      res.end(renderPage());
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers['x-csrf-token'] !== csrfToken) {
        sendJson(res, 403, { errors: ['画面を開き直してから、もう一度操作してください。'] });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/queue') {
        sendJson(res, 200, { items: await loadQueue() });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/posts') {
        sendJson(res, 200, await createPost(req));
        return;
      }
      const match = url.pathname.match(/^\/api\/posts\/([\w-]+)\/(delete|retry)$/);
      if (req.method === 'POST' && match) {
        sendJson(res, 200, match[2] === 'delete' ? await deletePost(match[1]) : await retryPost(match[1]));
        return;
      }
    }

    res.writeHead(404);
    res.end('Not Found');
  } catch (error) {
    if (error instanceof UserError) {
      sendJson(res, error.status, { errors: error.messages });
    } else {
      console.error(error);
      sendJson(res, 500, { errors: [`処理中にエラーが起きました: ${(error as Error).message}`] });
    }
  }
});

github.checkGhReady().catch((error: Error) => console.warn(`⚠️ ${error.message}`));

server.listen(port, '127.0.0.1', () => {
  const address = `http://127.0.0.1:${port}/`;
  console.log(`投稿画面を開きました: ${address}`);
  console.log('終わるときは、この画面で Ctrl + C を押してください。');
  if (process.platform === 'win32' && !process.argv.includes('--no-open')) {
    execFile('cmd', ['/c', 'start', '', address], { windowsHide: true });
  }
});
