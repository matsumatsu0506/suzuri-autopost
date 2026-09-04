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
  /** Threads / Instagram / Facebook 用の、公開された JPEG の URL */
  publicJpegUrl: string;
}

/**
 * SUZURI の画像URLは末尾の拡張子で形式が決まる。
 * `....png.webp?h=...` を `....png.jpg?h=...` にすると JPEG がそのまま返ってくる
 * （8種類のアイテムで実測確認済み）。
 *
 * Threads / Instagram / Facebook は画像ファイルを送れず「公開された JPEG か PNG の URL」
 * しか受け付けないため、この変換だけで要件を満たせる。画像を自前でホストする必要はない。
 */
export function toPublicJpegUrl(sampleImageUrl: string): string {
  return sampleImageUrl.replace(/\.webp(\?|$)/, '.jpg$1');
}

/**
 * SUZURI の sampleImageUrl は WebP を返す。
 * Bluesky は WebP も受け付けるが、Threads / Instagram は JPEG か PNG しか受け付けないため、
 * 最初から JPEG に統一しておく。
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
        publicJpegUrl: toPublicJpegUrl(sampleImageUrl),
      };
    }
  }

  throw new Error('画像を上限サイズまで圧縮できませんでした。');
}
