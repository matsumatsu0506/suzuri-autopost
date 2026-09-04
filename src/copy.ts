import type { AppConfig } from './config.js';
import type { PreparedImage } from './image.js';
import type { SuzuriProduct } from './types.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'gemini-3.6-flash';
/** 無料枠では混雑時に 503 が返ることがあるので、少し待って再試行する。 */
const RETRY_DELAYS_MS = [4000, 12000];

export interface GeneratedCopy {
  /** 投稿の本文（URL・ハッシュタグを含まない） */
  body: string;
  /** 画像の代替テキスト */
  alt: string;
  /** Gemini の生成に失敗してテンプレートで代替したか */
  fallback: boolean;
}

function itemLabel(product: SuzuriProduct): string {
  return product.item?.humanizeName ?? product.item?.name ?? 'グッズ';
}

/** Gemini が使えなかったときに必ず投稿できるようにするための定型文。 */
function fallbackCopy(product: SuzuriProduct): GeneratedCopy {
  const label = itemLabel(product);
  return {
    body: `${product.title}（${label} / 税込${product.priceWithTax.toLocaleString('ja-JP')}円）を SUZURI で販売しています。`,
    alt: `${product.title} の商品画像（${label}）`,
    fallback: true,
  };
}

function buildPrompt(
  product: SuzuriProduct,
  config: AppConfig,
  context: { materialTitle: string; materialDescription: string | null; postCount: number; lastText: string | null },
): string {
  const lines = [
    'あなたは SUZURI で自分のグッズを販売している作者本人です。',
    'これから渡す商品を SNS（Bluesky）で紹介する文章と、画像の代替テキストを作ってください。',
    '添付した画像が、実際に投稿される商品画像です。',
    '',
    '# 商品情報',
    `- 商品名: ${product.title}`,
    `- アイテムの種類: ${itemLabel(product)}`,
    `- デザイン名: ${context.materialTitle}`,
  ];
  if (context.materialDescription) {
    lines.push(`- デザインの説明: ${context.materialDescription}`);
  }
  lines.push(
    `- 税込価格: ${product.priceWithTax}円`,
    `- このデザインを紹介するのは ${context.postCount + 1} 回目です`,
  );
  if (context.lastText) {
    lines.push('', '# 前回このデザインを紹介したときの文章', context.lastText);
  }
  lines.push(
    '',
    '# 本文（body）のルール',
    `- ${config.maxBodyLength}文字以内。厳守してください`,
    '- 商品名を必ず含める',
    `- 語り口: ${config.copyTone}`,
    '- 前回の文章がある場合は、それとは違う切り口にする（使う場面、デザインの背景、贈り物としての提案、季節の話題など）',
    '- 誇大な表現、効能をうたう表現、医療的な断定表現は使わない',
    '- 「大人気」「今だけ」「必見」のような煽り文句は使わない',
    '- 絵文字は0〜2個まで',
    '- URL やハッシュタグは書かない（こちらで後から付け足します）',
    '',
    '# 代替テキスト（alt）のルール',
    '- 目が見えない人が画像の内容を理解できるように、実際に見える通りに説明する',
    '- 100文字以内。デザインの絵柄（何が描かれているか、色、雰囲気）を具体的に書く',
    '- 商品の種類（Tシャツ、マグカップなど）にも触れる',
    '- 「画像」「写真」という語で始めない。宣伝文句は入れない',
  );
  return lines.join('\n');
}

export async function generateCopy(
  product: SuzuriProduct,
  image: PreparedImage,
  config: AppConfig,
  context: { materialTitle: string; materialDescription: string | null; postCount: number; lastText: string | null },
): Promise<GeneratedCopy> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY が無いため、定型文で投稿します。');
    return fallbackCopy(product);
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const body = {
    contents: [
      {
        parts: [
          { text: buildPrompt(product, config, context) },
          { inline_data: { mime_type: image.mimeType, data: image.buffer.toString('base64') } },
        ],
      },
    ],
    generationConfig: {
      temperature: 1.0,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { body: { type: 'STRING' }, alt: { type: 'STRING' } },
        required: ['body', 'alt'],
      },
    },
  };

  try {
    let response: Response | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      response = await fetch(`${ENDPOINT}/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
      // 429（レート超過）と 5xx（混雑）だけ再試行する。400 番台の設定ミスは即座に諦める。
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === RETRY_DELAYS_MS.length) break;
      const waitMs = RETRY_DELAYS_MS[attempt];
      console.warn(`Gemini が HTTP ${response.status} を返しました。${waitMs / 1000} 秒後に再試行します。`);
      await new Promise((r) => setTimeout(r, waitMs));
    }

    if (!response || !response.ok) {
      const detail = response ? await response.text().catch(() => '') : '';
      throw new Error(`HTTP ${response?.status} ${detail.slice(0, 300)}`);
    }

    const data = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    };
    const text = (data.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => p.thought !== true && typeof p.text === 'string')
      .map((p) => p.text)
      .join('')
      .trim();

    if (!text) throw new Error('空の応答が返りました');

    const parsed = JSON.parse(text) as { body?: string; alt?: string };
    const generatedBody = parsed.body?.trim();
    const generatedAlt = parsed.alt?.trim();
    if (!generatedBody) throw new Error('body が空でした');

    const label = itemLabel(product);
    let alt: string;
    if (!generatedAlt) {
      alt = `${product.title} の商品画像（${label}）`;
    } else if (generatedAlt.includes(label)) {
      // 生成された説明にすでにアイテム名が入っていれば、重ねて付けない
      alt = generatedAlt;
    } else {
      alt = `${generatedAlt}（${label}）`;
    }
    return { body: generatedBody, alt, fallback: false };
  } catch (error) {
    console.warn(`紹介文の生成に失敗したため定型文で投稿します: ${(error as Error).message}`);
    return fallbackCopy(product);
  }
}
