import type { Platform, QueueMedia } from './queue.js';

/**
 * 各SNSの制限（2026年9月時点の公式ドキュメントより）。
 * 動画の上限は、GitHub への一時アップロードと Bluesky の制限に合わせて 100MB にしている。
 */
export const LIMITS = {
  blueskyText: 300,
  threadsText: 500,
  instagramText: 2200,
  facebookText: 63206,
  instagramHashtags: 30,
  maxVideoBytes: 100 * 1024 * 1024,
  blueskyVideoSec: 180,
  threadsVideoSec: 300,
  instagramVideoMinSec: 3,
  instagramVideoSec: 900,
} as const;

/** Bluesky は「見た目の1文字」（grapheme）で数える。絵文字や濁点付き文字も1文字。 */
export function countGraphemes(text: string): number {
  const segmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' });
  let n = 0;
  for (const _ of segmenter.segment(text)) n += 1;
  return n;
}

/** Threads / Instagram / Facebook は文字（コードポイント）で数える。 */
export function countChars(text: string): number {
  return [...text].length;
}

export interface PostDraft {
  text: string;
  platforms: Platform[];
  media: Pick<QueueMedia, 'kind' | 'bytes' | 'durationSec' | 'alt'> | null;
}

/** 投稿できない理由を、そのまま画面に出せる日本語の文で返す。空配列なら問題なし。 */
export function validateDraft(draft: PostDraft): string[] {
  const errors: string[] = [];
  const text = draft.text.trim();
  const has = (p: Platform) => draft.platforms.includes(p);
  const media = draft.media;

  if (draft.platforms.length === 0) errors.push('投稿アカウントを1つ以上選んでください。');
  if (!text && !media) errors.push('本文を入力するか、画像か動画を添付してください。');

  if (has('bluesky')) {
    const n = countGraphemes(text);
    if (n > LIMITS.blueskyText) {
      errors.push(`Bluesky の本文は${LIMITS.blueskyText}文字までです（現在${n}文字）。`);
    }
  }
  if (has('threads')) {
    const n = countChars(text);
    if (n > LIMITS.threadsText) {
      errors.push(`Threads の本文は${LIMITS.threadsText}文字までです（現在${n}文字）。`);
    }
  }
  if (has('instagram')) {
    if (!media) {
      errors.push(
        'Instagram は文字だけの投稿ができません。画像か動画を添付するか、Instagram のチェックを外してください。',
      );
    }
    const n = countChars(text);
    if (n > LIMITS.instagramText) {
      errors.push(`Instagram の本文は${LIMITS.instagramText}文字までです（現在${n}文字）。`);
    }
    const tags = text.match(/[#＃][^\s#＃]+/g)?.length ?? 0;
    if (tags > LIMITS.instagramHashtags) {
      errors.push(`Instagram のハッシュタグは${LIMITS.instagramHashtags}個までです（現在${tags}個）。`);
    }
  }
  if (has('facebook')) {
    const n = countChars(text);
    if (n > LIMITS.facebookText) errors.push(`Facebook の本文は${LIMITS.facebookText}文字までです。`);
  }

  if (media?.kind === 'image' && !media.alt.trim()) {
    errors.push('画像の代替テキストを入力してください。画像の内容を短く説明する文です。');
  }

  if (media?.kind === 'video') {
    if (media.bytes > LIMITS.maxVideoBytes) {
      const mb = Math.round(media.bytes / 1024 / 1024);
      errors.push(`動画は100MBまでです（現在${mb}MB）。`);
    }
    const sec = media.durationSec;
    if (sec !== undefined) {
      const shown = formatDuration(sec);
      if (has('bluesky') && sec > LIMITS.blueskyVideoSec) {
        errors.push(`Bluesky の動画は3分までです（この動画は${shown}）。`);
      }
      if (has('threads') && sec > LIMITS.threadsVideoSec) {
        errors.push(`Threads の動画は5分までです（この動画は${shown}）。`);
      }
      if (has('instagram') && sec < LIMITS.instagramVideoMinSec) {
        errors.push(`Instagram の動画は3秒以上必要です（この動画は${shown}）。`);
      }
      if (has('instagram') && sec > LIMITS.instagramVideoSec) {
        errors.push(`Instagram の動画は15分までです（この動画は${shown}）。`);
      }
    }
  }

  return errors;
}

export function formatDuration(sec: number): string {
  const total = Math.round(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}
