export interface PostPayload {
  /** 投稿する本文（URL・ハッシュタグを含む完成形） */
  text: string;
  /** 画像の代替テキスト。アクセシビリティ上の必須項目。 */
  altText: string;
  /** JPEG に変換済みの画像データ。Bluesky はこれを直接アップロードする。 */
  imageBuffer: Buffer;
  imageMimeType: string;
  imageWidth: number;
  imageHeight: number;
  /**
   * 画像の公開 URL。
   * Threads と Instagram はバイナリを受け取らず公開 URL しか受け付けないため、
   * Phase 2 以降で GitHub Pages などに置いた URL をここに入れる。
   */
  imagePublicUrl?: string;
  /** 商品ページの URL */
  linkUrl: string;
}

export interface PostResult {
  platform: string;
  ok: boolean;
  uri?: string;
  error?: string;
}

export interface PostAdapter {
  readonly name: string;
  post(payload: PostPayload): Promise<PostResult>;
}
