import { requireEnv } from '../config.js';
import { graphGet, graphPost, resolveInstagramUserId, resolvePage, sleep } from './meta.js';
import type { PostAdapter, PostPayload, PostResult } from './types.js';

/** Instagram のキャプションは2200文字まで。 */
const MAX_CAPTION_LENGTH = 2200;

/** コンテナの処理完了を待つ間隔と最大待ち時間。 */
const POLL_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 90_000;

/**
 * Instagram への投稿。
 *
 * 前提:
 * - Instagram が「プロアカウント（ビジネスまたはクリエイター）」であること
 * - そのアカウントが Facebookページと連携されていること
 *
 * 注意: Instagram のキャプション内のURLはリンクにならない（タップできない）ため、
 * 商品ページのURLは載せず、ハッシュタグ付きの本文だけを使う。
 * また **画像は JPEG のみ**（PNG は不可）。
 */
export class InstagramAdapter implements PostAdapter {
  readonly name = 'instagram';

  async post(payload: PostPayload): Promise<PostResult> {
    try {
      const token = requireEnv('META_PAGE_ACCESS_TOKEN');

      if (!payload.imagePublicUrl) {
        throw new Error(
          'Instagram には画像の公開URLが必要ですが、渡されていません。' +
            'config.json の enabledPlatforms で bluesky を有効にしてください。',
        );
      }

      const page = await resolvePage(token);
      const igUserId = await resolveInstagramUserId(page.id, token);
      console.log(`  Instagram ユーザーID: ${igUserId}`);

      const caption = (payload.captionWithoutLink ?? payload.text).slice(0, MAX_CAPTION_LENGTH);

      // 1. メディアコンテナを作る
      const baseParams: Record<string, string> = {
        image_url: payload.imagePublicUrl,
        caption,
        access_token: token,
      };

      let container: { id?: string };
      try {
        container = await graphPost(`${igUserId}/media`, {
          ...baseParams,
          alt_text: payload.altText,
        });
      } catch (error) {
        console.warn(
          `  alt_text 付きでの作成に失敗したため、alt_text なしで再試行します: ${(error as Error).message}`,
        );
        container = await graphPost(`${igUserId}/media`, baseParams);
      }

      const creationId = container.id;
      if (!creationId) throw new Error('コンテナIDを取得できませんでした。');

      // 2. 画像の処理が終わるまで待つ
      await this.waitUntilReady(creationId, token);

      // 3. 公開する
      const published = await graphPost<{ id?: string }>(`${igUserId}/media_publish`, {
        creation_id: creationId,
        access_token: token,
      });
      const mediaId = published.id;
      if (!mediaId) throw new Error('公開後のIDを取得できませんでした。');

      // 4. 閲覧用URLを取得する
      let permalink: string | undefined;
      try {
        const info = await graphGet<{ permalink?: string }>(mediaId, {
          fields: 'permalink',
          access_token: token,
        });
        permalink = info.permalink;
      } catch {
        /* URLが取れなくても投稿自体は成功しているので無視する */
      }

      return { platform: this.name, ok: true, uri: permalink ?? `投稿ID ${mediaId}` };
    } catch (error) {
      return { platform: this.name, ok: false, error: (error as Error).message };
    }
  }

  /** コンテナの status_code が FINISHED になるまで待つ。 */
  private async waitUntilReady(creationId: string, token: string): Promise<void> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const status = await graphGet<{ status_code?: string; status?: string }>(creationId, {
        fields: 'status_code,status',
        access_token: token,
      });
      if (status.status_code === 'FINISHED') return;
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new Error(`画像の処理に失敗しました: ${status.status ?? status.status_code}`);
      }
      console.log(`  画像を処理中です（${status.status_code ?? '状態不明'}）...`);
    }
    throw new Error('画像の処理が時間内に終わりませんでした。');
  }
}
