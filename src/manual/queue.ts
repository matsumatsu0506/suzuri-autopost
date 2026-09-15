import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 手動投稿・予約投稿の「予約データ」。
 *
 * 1件の投稿を `queue/posts/{id}.json` の1ファイルで表す。
 * 投稿画面（自分のPC）が GitHub API でこのファイルを作り、
 * GitHub Actions（manual-post.yml）が予定時刻を過ぎたものを投稿して結果を書き戻す。
 * すべてのSNSで成功したら `queue/done/{年-月}/` に移す。
 */

/**
 * 投稿する順番。
 * 画像は Bluesky に投稿すると CDN の公開URLが得られ、Meta 側はその URL なら確実に取りに行けるので、
 * Bluesky を必ず先にする（src/index.ts の PLATFORM_ORDER と同じ理由）。
 */
export const PLATFORMS = ['bluesky', 'threads', 'instagram', 'facebook'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const PLATFORM_LABELS: Record<Platform, string> = {
  bluesky: 'Bluesky',
  threads: 'Threads',
  instagram: 'Instagram',
  facebook: 'Facebookページ',
};

export function isPlatform(value: string): value is Platform {
  return (PLATFORMS as readonly string[]).includes(value);
}

/**
 * - pending: まだ投稿していない
 * - in_progress: 投稿処理中（途中で止まった場合に二重投稿しないための目印）
 * - done: 成功
 * - failed: 失敗（投稿画面から再試行できる）
 */
export type PlatformStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface PlatformResult {
  status: PlatformStatus;
  /** 投稿の閲覧用URL */
  uri?: string;
  error?: string;
  /** 状態が変わった日時（ISO8601） */
  at?: string;
}

export interface QueueMedia {
  kind: 'image' | 'video';
  fileName: string;
  mimeType: string;
  bytes: number;
  width: number;
  height: number;
  durationSec?: number;
  /** 代替テキスト。画像では必須。 */
  alt: string;
  /** GitHub Release に一時的に置いたファイルの公開URL */
  url: string;
  /** 投稿後に削除する Release のタグ */
  releaseTag: string;
}

export interface QueueItem {
  version: 1;
  id: string;
  createdAt: string;
  /** 投稿する日時（ISO8601・UTC）。「今すぐ投稿」は作成時刻が入る。 */
  scheduledAt: string;
  text: string;
  media: QueueMedia | null;
  platforms: Partial<Record<Platform, PlatformResult>>;
}

export const QUEUE_DIR = 'queue/posts';
export const DONE_DIR = 'queue/done';

export type ItemSummary = 'scheduled' | 'posting' | 'done' | 'failed' | 'partial';

export const SUMMARY_LABELS: Record<ItemSummary, string> = {
  scheduled: '予約中',
  posting: '投稿処理中',
  done: '投稿済み',
  failed: '失敗',
  partial: '一部失敗',
};

export function summarize(item: QueueItem): ItemSummary {
  const statuses = Object.values(item.platforms).map((p) => p?.status);
  if (statuses.includes('in_progress')) return 'posting';
  if (statuses.includes('pending')) return 'scheduled';
  if (statuses.every((s) => s === 'done')) return 'done';
  if (statuses.every((s) => s === 'failed')) return 'failed';
  return 'partial';
}

/** 日本時間の日時を含むID（例 20260915-183000-k3f9）。ファイル名順＝作成順になる。 */
export function newItemId(date = new Date()): string {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString();
  const stamp = jst.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const random = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${stamp}-${random}`;
}

/** 例: 9月16日(水) 9:00 */
export function formatJst(iso: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function itemPath(id: string): string {
  return `${QUEUE_DIR}/${id}.json`;
}

export function serializeItem(item: QueueItem): string {
  return `${JSON.stringify(item, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// ここから下は GitHub Actions 用。チェックアウトしたファイルを直接読み書きする。
// ---------------------------------------------------------------------------

export interface LocalItem {
  path: string;
  item: QueueItem;
}

export function listLocalItems(root = process.cwd()): LocalItem[] {
  const dir = resolve(root, QUEUE_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      return { path, item: JSON.parse(readFileSync(path, 'utf8')) as QueueItem };
    });
}

export function writeLocalItem(entry: LocalItem): void {
  writeFileSync(entry.path, serializeItem(entry.item), 'utf8');
}

/** すべてのSNSで成功した予約を queue/done/{年-月}/ に移す。 */
export function moveLocalItemToDone(entry: LocalItem, root = process.cwd()): void {
  const month = entry.item.scheduledAt.slice(0, 7);
  const dir = resolve(root, DONE_DIR, month);
  mkdirSync(dir, { recursive: true });
  writeLocalItem(entry);
  renameSync(entry.path, join(dir, `${entry.item.id}.json`));
}
