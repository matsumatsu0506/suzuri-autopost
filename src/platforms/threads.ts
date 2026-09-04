import type { PostAdapter, PostPayload, PostResult } from './types.js';

/**
 * Phase 2 用のスタブ。まだ実装していません。
 *
 * 実装するときに必要になることのメモ:
 *
 * 1. 画像はバイナリを送れない。**公開された URL（image_url）しか受け付けない**。
 *    しかも形式は **JPEG か PNG のみ**（SUZURI の sampleImageUrl は WebP なので変換が必須）。
 *    → 変換済みの JPEG を GitHub Pages に置き、その URL を payload.imagePublicUrl に入れる。
 *
 * 2. 投稿は2段階。
 *    POST /{threads-user-id}/threads          … メディアコンテナを作る（media_type=IMAGE, image_url, text）
 *    POST /{threads-user-id}/threads_publish  … コンテナIDを渡して公開する
 *
 * 3. **長期アクセストークンは60日で失効する。**
 *    発行から24時間経過後に th_refresh_token でリフレッシュできる。
 *    60日間放置すると完全に失効して作り直しになるため、
 *    「週1回トークンをリフレッシュする GitHub Actions ワークフロー」を別途用意すること。
 *
 * 4. Meta の開発者アプリを作り、Threads のアクセス権限
 *    （threads_basic / threads_content_publish）を有効にする必要がある。
 */
export class ThreadsAdapter implements PostAdapter {
  readonly name = 'threads';

  async post(_payload: PostPayload): Promise<PostResult> {
    throw new Error(
      'Threads への投稿はまだ実装されていません（Phase 2）。' +
        'config.json の enabledPlatforms から "threads" を外してください。',
    );
  }
}
