import { RichText } from '@atproto/api';
import type { AppConfig } from './config.js';
import type { SuzuriProduct } from './types.js';

/** Bluesky の本文の上限（grapheme 単位）。 */
export const BLUESKY_MAX_GRAPHEMES = 300;

export function graphemeLength(text: string): number {
  return new RichText({ text }).graphemeLength;
}

function graphemes(text: string): string[] {
  const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  return [...segmenter.segment(text)].map((s) => s.segment);
}

function trimToGraphemes(text: string, max: number): string {
  const parts = graphemes(text);
  if (parts.length <= max) return text;
  return `${parts.slice(0, Math.max(max - 1, 0)).join('').trimEnd()}…`;
}

function buildHashtags(product: SuzuriProduct, config: AppConfig): string[] {
  const tags = [...config.hashtags];
  if (config.includeItemHashtag) {
    const label = product.item?.humanizeName ?? product.item?.name;
    if (label) {
      const tag = `#${label.replace(/[\s　/・]/g, '')}`;
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
  return tags;
}

export interface ComposedPost {
  text: string;
  body: string;
  tail: string;
  graphemes: number;
  trimmed: boolean;
}

/**
 * 「紹介文 + 改行 + 商品ページURL + ハッシュタグ」の形に組み立てる。
 * 300 grapheme を超える場合は紹介文の側だけを削る（URL とハッシュタグは削らない）。
 */
export function composePost(
  bodyText: string,
  product: SuzuriProduct,
  config: AppConfig,
): ComposedPost {
  const tail = `\n\n${product.sampleUrl}\n${buildHashtags(product, config).join(' ')}`;
  const tailLength = graphemeLength(tail);
  const budget = BLUESKY_MAX_GRAPHEMES - tailLength;

  let body = trimToGraphemes(bodyText.trim(), Math.min(config.maxBodyLength, budget));
  let trimmed = body !== bodyText.trim();

  // 念のため、組み立てた結果で再チェックする
  while (graphemeLength(body + tail) > BLUESKY_MAX_GRAPHEMES && body.length > 0) {
    body = trimToGraphemes(body, graphemes(body).length - 1);
    trimmed = true;
  }

  const text = body + tail;
  return { text, body, tail, graphemes: graphemeLength(text), trimmed };
}
