import type { SuzuriProduct } from './types.js';

const BASE_URL = 'https://suzuri.jp/api/v1';
const PAGE_SIZE = 50; // API の上限（デフォルトは 20）
const PAGE_INTERVAL_MS = 300;

interface ProductsResponse {
  products: SuzuriProduct[];
  meta?: { hasNext?: boolean };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** ヘッダ名の大文字小文字の表記ゆれを吸収して読む。 */
function readIntHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * 指定ユーザーの商品を全件取得する。
 * レートリミットの残りが少なくなったら X-Ratelimit-Reset まで待つ。
 */
export async function fetchAllProducts(
  userName: string,
  token: string,
): Promise<SuzuriProduct[]> {
  const all: SuzuriProduct[] = [];
  let offset = 0;

  for (let page = 0; page < 100; page++) {
    const url = `${BASE_URL}/products?userName=${encodeURIComponent(userName)}&limit=${PAGE_SIZE}&offset=${offset}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `SUZURI API がエラーを返しました (HTTP ${response.status})。` +
          `offset=${offset}\n${body.slice(0, 500)}`,
      );
    }

    const data = (await response.json()) as ProductsResponse;
    const products = data.products ?? [];
    all.push(...products);

    const hasNext = data.meta?.hasNext === true;
    if (!hasNext || products.length === 0) break;

    // レートリミットの残りが少なければリセットまで待つ
    const remaining = readIntHeader(response.headers, 'x-ratelimit-remaining');
    if (remaining !== null && remaining <= 3) {
      const reset = readIntHeader(response.headers, 'x-ratelimit-reset');
      const waitMs = reset === null ? 60_000 : Math.max(reset * 1000 - Date.now(), 1000);
      console.warn(`レートリミットが残り ${remaining} なので ${Math.ceil(waitMs / 1000)} 秒待ちます。`);
      await sleep(Math.min(waitMs, 120_000));
    }

    offset += PAGE_SIZE;
    await sleep(PAGE_INTERVAL_MS);
  }

  return all;
}
