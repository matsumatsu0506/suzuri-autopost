/**
 * Facebookページのアクセストークンを取り出して .env に書き込む補助ツール。
 *
 * 使い方:
 *   1. .env に META_APP_ID / META_APP_SECRET / META_USER_ACCESS_TOKEN を入れる
 *   2. npm run meta:setup
 *
 * 短期トークンは自動で長期（60日）に交換する。
 * 長期ユーザートークンから取り出したページトークンは期限切れにならないので、
 * 一度これを実行すれば以後の更新作業は不要。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDotEnv } from './config.js';
import { GRAPH_API } from './platforms/meta.js';

loadDotEnv();

let userToken = process.env.META_USER_ACCESS_TOKEN;
if (!userToken) {
  console.error('.env に META_USER_ACCESS_TOKEN がありません。');
  console.error('グラフAPIエクスプローラのコピーボタンで取得したトークンを入れてください。');
  process.exit(1);
}

const appId = process.env.META_APP_ID;
const appSecret = process.env.META_APP_SECRET;

/** 短期トークン（1〜2時間）を長期トークン（60日）に交換する。 */
if (appId && appSecret) {
  console.log('短期トークンを長期トークンに交換しています...');
  const res = await fetch(
    `${GRAPH_API}/oauth/access_token?${new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: userToken,
    })}`,
  );
  const result = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: { message?: string };
  };
  if (!res.ok || !result.access_token) {
    console.error(`交換に失敗しました: ${result.error?.message ?? `HTTP ${res.status}`}`);
    process.exit(1);
  }
  userToken = result.access_token;
  const days = result.expires_in ? Math.round(result.expires_in / 86400) : null;
  console.log(`交換できました${days ? `（このユーザートークンはあと ${days} 日有効）` : ''}。`);
  console.log('');
} else {
  console.warn('※ META_APP_ID / META_APP_SECRET が無いため交換しません（トークンは短期のままです）。');
  console.warn('');
}

interface PageInfo {
  id: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string };
}

/**
 * 対象ページのIDを集める。
 *
 * /me/accounts は、ページがビジネスポートフォリオ所有だと空になることがある。
 * その場合はトークン自体に記録されている「どのページに権限を与えたか」
 * （granular_scopes）から拾う。
 */
async function collectPageIds(token: string): Promise<string[]> {
  const listRes = await fetch(
    `${GRAPH_API}/me/accounts?fields=id&access_token=${encodeURIComponent(token)}`,
  );
  const list = (await listRes.json()) as { data?: { id: string }[] };
  const fromList = (list.data ?? []).map((p) => p.id);
  if (fromList.length > 0) return fromList;

  if (!appId || !appSecret) return [];

  console.log('ページ一覧が空だったので、トークンの権限情報から対象ページを調べます...');
  const dbgRes = await fetch(
    `${GRAPH_API}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${appId}|${appSecret}`,
  );
  const dbg = (await dbgRes.json()) as {
    data?: { granular_scopes?: { scope: string; target_ids?: string[] }[] };
  };
  const ids = new Set<string>();
  for (const g of dbg.data?.granular_scopes ?? []) {
    if (g.scope === 'pages_manage_posts' || g.scope === 'pages_show_list') {
      for (const id of g.target_ids ?? []) ids.add(id);
    }
  }
  return [...ids];
}

const pageIds = await collectPageIds(userToken);

if (pageIds.length === 0) {
  console.error('対象のFacebookページが見つかりませんでした。');
  console.error('トークンを作るときに、投稿したいページを選んで許可したか確認してください。');
  process.exit(1);
}

const pages: PageInfo[] = [];
for (const id of pageIds) {
  const res = await fetch(
    `${GRAPH_API}/${id}?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(userToken)}`,
  );
  const data = (await res.json()) as PageInfo & { error?: { message?: string } };
  if (!res.ok || !data.access_token) {
    console.warn(`  ページ ${id} の情報を取得できませんでした: ${data.error?.message ?? `HTTP ${res.status}`}`);
    continue;
  }
  pages.push(data);
}

if (pages.length === 0) {
  console.error('ページのアクセストークンを取得できませんでした。');
  process.exit(1);
}

console.log(`使えるページ: ${pages.length} 件`);
for (const page of pages) {
  const ig = page.instagram_business_account;
  console.log(`  - ${page.name}（ID ${page.id}）`);
  console.log(`      Instagram: ${ig ? `@${ig.username ?? ig.id} と連携済み` : '連携されていません'}`);
}
console.log('');

// 引数でページ名やIDを指定できるようにする（ページが複数ある場合用）
const wanted = process.argv.slice(2).find((a) => !a.startsWith('--'));
const page = wanted ? pages.find((p) => p.name === wanted || p.id === wanted) : pages[0];

if (!page) {
  console.error(`指定されたページが見つかりません: ${wanted}`);
  process.exit(1);
}

if (!page.instagram_business_account) {
  console.warn(`⚠️ ページ「${page.name}」に Instagram が連携されていません。`);
  console.warn('   Facebook への投稿はできますが、Instagram への投稿はできません。');
  console.warn('');
}

// .env の META_PAGE_ACCESS_TOKEN を書き換える（他の行はそのまま）
const envPath = resolve(process.cwd(), '.env');
const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
const index = lines.findIndex((l) => l.startsWith('META_PAGE_ACCESS_TOKEN='));
const newLine = `META_PAGE_ACCESS_TOKEN=${page.access_token}`;
if (index >= 0) lines[index] = newLine;
else lines.push('META_PAGE_ACCESS_TOKEN=' + page.access_token);
writeFileSync(envPath, lines.join('\r\n'), 'utf8');

console.log(`ページ「${page.name}」のアクセストークンを .env に書き込みました（値は表示していません）。`);
console.log('このページトークンは期限切れになりません。');
console.log('');
console.log('次のステップ:');
console.log('  npm run post -- --dry-run で内容を確認する');
