import sharp from 'sharp';

/** Bluesky の 1 枚あたりのサイズ上限（2,000,000 バイト）に対して余裕をみた値。 */
const MAX_BYTES = 950_000;
/**
 * SUZURI の sampleImageUrl は 500x500 が上限（URL に署名が入っていて、
 * サイズ部分を書き換えると 404 になる）。拡大はしないので実質 500x500 のまま。
 */
const MAX_EDGE = 1200;
/** 元画像が小さくファイルサイズに余裕があるので、画質は高めから始める。 */
const QUALITY_STEPS = [92, 85, 75, 65, 55];

export interface PreparedImage {
  buffer: Buffer;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
}

/**
 * SUZURI の sampleImageUrl は WebP を返すので JPEG に変換する。
 *
 * 注意: SUZURI の画像URLの拡張子を .jpg に変えると JPEG は返ってくるが、
 * **lens.suzuri.jp は Meta のクローラーを拒否する**ため、その URL を
 * Threads / Instagram に渡すことはできない（実測で subcode 2207052 になる）。
 * 画像の公開URLは Bluesky に投稿したあとの CDN URL を使う（platforms/bluesky.ts を参照）。
 */
export async function prepareImage(sampleImageUrl: string): Promise<PreparedImage> {
  const response = await fetch(sampleImageUrl);
  if (!response.ok) {
    throw new Error(`商品画像を取得できませんでした (HTTP ${response.status}) : ${sampleImageUrl}`);
  }
  const original = Buffer.from(await response.arrayBuffer());

  for (const quality of QUALITY_STEPS) {
    const pipeline = sharp(original)
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }) // 透過画像が黒くつぶれないように白背景を敷く
      .jpeg({ quality, mozjpeg: true });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    if (data.byteLength <= MAX_BYTES) {
      return {
        buffer: data,
        mimeType: 'image/jpeg',
        width: info.width,
        height: info.height,
        bytes: data.byteLength,
      };
    }
  }

  throw new Error('画像を上限サイズまで圧縮できませんでした。');
}
