import { requireEnv } from '../config.js';
import type { PostAdapter, PostPayload, PostResult } from './types.js';

const API = 'https://graph.threads.net/v1.0';

/** Threads は本文500文字まで。 */
const MAX_TEXT_LENGTH = 500;

/**
 * コンテナを作ってから公開するまでに置く待ち時間。
 * Meta は「平均30秒待ってから公開すること」を推奨している。
 */
const PUBLISH_DELAY_MS = 35_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function callThreadsApi(
  path: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = (data.error as { message?: string } | undefined)?.message ?? JSON.stringify(data);
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }
  return data;
}

/** トークンから投稿先のユーザーIDを引く（IDを別途 Secrets に置かなくて済むように）。 */
async function fetchUserId(token: string): Promise<string> {
  const response = await fetch(`${API}/me?fields=id,username&access_token=${encodeURIComponent(token)}`);
  const data = (await response.json().catch(() => ({}))) as {
    id?: string;
    username?: string;
    error?: { message?: string };
  };
  if (!response.ok || !data.id) {
    throw new Error(
      `Threads のユーザー情報を取得できませんでした: ${data.error?.message ?? `HTTP ${response.status}`}`,
    );
  }
  console.log(`  Threads アカウント: @${data.username ?? '(不明)'}`);
  return data.id;
}

/** 公開した投稿の閲覧用URLを取得する。失敗しても投稿自体は成功しているので例外にしない。 */
async function fetchPermalink(postId: string, token: string): Promise<string | null> {
  try {
    const response = await fetch(
      `${API}/${postId}?fields=permalink&access_token=${encodeURIComponent(token)}`,
    );
    const data = (await response.json()) as { permalink?: string };
    return data.permalink ?? null;
  } catch {
    return null;
  }
}

/**
 * Threads への投稿。
 *
 * 画像はバイナリを送れず、公開された JPEG / PNG の URL しか受け付けない。
 * SUZURI の画像URLの末尾を .jpg にすると JPEG がそのまま返るので、それをそのまま渡している
 * （src/image.ts の toPublicJpegUrl を参照。自前で画像をホストする必要はない）。
 */
export class ThreadsAdapter implements PostAdapter {
  readonly name = 'threads';

  async post(payload: PostPayload): Promise<PostResult> {
    try {
      const token = requireEnv('THREADS_ACCESS_TOKEN');

      if (!payload.imagePublicUrl) {
        throw new Error(
          'Threads には画像の公開URLが必要ですが、渡されていません。' +
            'この URL は Bluesky への投稿が成功したときに得られるため、' +
            'config.json の enabledPlatforms で bluesky を threads より前に有効にしてください。',
        );
      }
      const text =
        payload.text.length > MAX_TEXT_LENGTH
          ? `${payload.text.slice(0, MAX_TEXT_LENGTH - 1)}…`
          : payload.text;

      const userId = await fetchUserId(token);

      // 1. メディアコンテナを作る
      const baseParams = {
        media_type: 'IMAGE',
        image_url: payload.imagePublicUrl,
        text,
        access_token: token,
      };

      // 代替テキストは必ず付けたいので、失敗しても間を空けて2回まで同じ内容で再試行する
      // （画像の取得失敗は一時的なことが多いため）。それでも駄目なときだけ alt_text を外す。
      const withAlt = { ...baseParams, alt_text: payload.altText };
      let container: Record<string, unknown> | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          container = await callThreadsApi(`${userId}/threads`, withAlt);
          break;
        } catch (error) {
          console.warn(`  コンテナの作成に失敗しました（${attempt + 1}回目）: ${(error as Error).message}`);
          if (attempt < 2) await sleep(10_000);
        }
      }
      if (!container) {
        console.warn('  代替テキストなしで最後の再試行をします。');
        container = await callThreadsApi(`${userId}/threads`, baseParams);
      }

      const creationId = container.id;
      if (typeof creationId !== 'string') {
        throw new Error(`コンテナIDを取得できませんでした: ${JSON.stringify(container)}`);
      }

      // 2. Meta の推奨に従って待つ
      console.log(`  コンテナを作成しました。${PUBLISH_DELAY_MS / 1000}秒待ってから公開します。`);
      await sleep(PUBLISH_DELAY_MS);

      // 3. 公開する
      const published = await callThreadsApi(`${userId}/threads_publish`, {
        creation_id: creationId,
        access_token: token,
      });

      const postId = published.id;
      if (typeof postId !== 'string') {
        throw new Error(`公開後のIDを取得できませんでした: ${JSON.stringify(published)}`);
      }

      // 投稿IDから閲覧用URLは組み立てられない（別の短い符号が使われる）ので、APIに問い合わせる
      const permalink = await fetchPermalink(postId, token);
      return { platform: this.name, ok: true, uri: permalink ?? `投稿ID ${postId}` };
    } catch (error) {
      return { platform: this.name, ok: false, error: (error as Error).message };
    }
  }
}
