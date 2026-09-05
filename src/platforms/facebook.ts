import { requireEnv } from '../config.js';
import { graphPost, resolvePage } from './meta.js';
import type { PostAdapter, PostPayload, PostResult } from './types.js';

/**
 * Facebookページへの投稿。
 *
 * 個人プロフィールにはAPIから投稿できない（2018年に廃止された）ため、投稿先はページのみ。
 * 画像は公開URLで渡す（Bluesky に投稿した画像のURLを使う）。
 */
export class FacebookPageAdapter implements PostAdapter {
  readonly name = 'facebook';

  async post(payload: PostPayload): Promise<PostResult> {
    try {
      const token = requireEnv('META_PAGE_ACCESS_TOKEN');

      if (!payload.imagePublicUrl) {
        throw new Error(
          'Facebook には画像の公開URLが必要ですが、渡されていません。' +
            'config.json の enabledPlatforms で bluesky を有効にしてください。',
        );
      }

      const page = await resolvePage(token);
      console.log(`  Facebookページ: ${page.name}`);

      const params: Record<string, string> = {
        url: payload.imagePublicUrl,
        message: payload.text,
        published: 'true',
        access_token: token,
      };

      let result: { id?: string; post_id?: string };
      try {
        // 代替テキストを付けて試す
        result = await graphPost(`${page.id}/photos`, {
          ...params,
          alt_text_custom: payload.altText,
        });
      } catch (error) {
        console.warn(
          `  代替テキスト付きでの投稿に失敗したため、なしで再試行します: ${(error as Error).message}`,
        );
        result = await graphPost(`${page.id}/photos`, params);
      }

      const postId = result.post_id ?? result.id;
      if (!postId) throw new Error('投稿IDを取得できませんでした。');

      return {
        platform: this.name,
        ok: true,
        uri: `https://www.facebook.com/${postId}`,
      };
    } catch (error) {
      return { platform: this.name, ok: false, error: (error as Error).message };
    }
  }
}
