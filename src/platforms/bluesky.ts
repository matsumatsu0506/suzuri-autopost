import { AtpAgent, RichText } from '@atproto/api';
import { requireEnv } from '../config.js';
import type { PostAdapter, PostPayload, PostResult } from './types.js';

/**
 * Bluesky への投稿。
 *
 * 注意: 画像（app.bsky.embed.images）を添付すると、本文中の URL のリンクカード
 * （app.bsky.embed.external）は表示されません。これは AT Protocol の仕様であって
 * 不具合ではありません。URL は RichText の facets によってリンクにはなります。
 */
export class BlueskyAdapter implements PostAdapter {
  readonly name = 'bluesky';

  async post(payload: PostPayload): Promise<PostResult> {
    try {
      const identifier = requireEnv('BLUESKY_IDENTIFIER');
      const password = requireEnv('BLUESKY_APP_PASSWORD');

      const agent = new AtpAgent({ service: 'https://bsky.social' });
      await agent.login({ identifier, password });

      const uploaded = await agent.uploadBlob(payload.imageBuffer, {
        encoding: payload.imageMimeType,
      });

      const rt = new RichText({ text: payload.text });
      await rt.detectFacets(agent);

      const response = await agent.post({
        text: rt.text,
        facets: rt.facets,
        langs: ['ja'],
        embed: {
          $type: 'app.bsky.embed.images',
          images: [
            {
              image: uploaded.data.blob,
              alt: payload.altText,
              aspectRatio: { width: payload.imageWidth, height: payload.imageHeight },
            },
          ],
        },
        createdAt: new Date().toISOString(),
      });

      // アップロードした画像は Bluesky の CDN で公開される。
      // Threads / Instagram は「画像の公開URL」しか受け取れないので、これを後続に渡す。
      const cid = (uploaded.data.blob.ref as unknown as { $link?: string })?.$link
        ?? String(uploaded.data.blob.ref);
      const did = agent.session?.did;
      const publicImageUrl =
        did && cid ? `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}@jpeg` : undefined;

      return { platform: this.name, ok: true, uri: response.uri, publicImageUrl };
    } catch (error) {
      return { platform: this.name, ok: false, error: (error as Error).message };
    }
  }
}
