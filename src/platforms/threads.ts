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
        throw new Error('Threads には画像の公開URLが必要ですが、渡されていません。');
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

      let container: Record<string, unknown>;
      try {
        // 代替テキストはアクセシビリティ上必ず付けたいので、まず alt_text ありで試す
        container = await callThreadsApi(`${userId}/threads`, {
          ...baseParams,
          alt_text: payload.altText,
        });
      } catch (error) {
        console.warn(
          `  alt_text 付きでの作成に失敗したため、alt_text なしで再試行します: ${(error as Error).message}`,
        );
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

      return { platform: this.name, ok: true, uri: `https://www.threads.net/post/${postId}` };
    } catch (error) {
      return { platform: this.name, ok: false, error: (error as Error).message };
    }
  }
}
