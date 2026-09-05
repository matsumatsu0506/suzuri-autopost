/**
 * Facebookページ と Instagram で共通に使う処理。
 *
 * どちらも「ページアクセストークン」1つで投稿できる。
 * ページIDと、そのページに紐づく Instagram のユーザーIDは、トークンから引けるので
 * 環境変数に入れる必要はない。
 */

export const GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v26.0';
export const GRAPH_API = `https://graph.facebook.com/${GRAPH_VERSION}`;

interface GraphError {
  message?: string;
  error_user_title?: string;
  error_user_msg?: string;
  error_subcode?: number;
  code?: number;
}

function describeError(status: number, data: { error?: GraphError }): string {
  const e = data.error;
  if (!e) return `HTTP ${status}`;
  const parts = [e.error_user_title, e.error_user_msg, e.message].filter(Boolean);
  return `HTTP ${status}: ${parts.join(' / ') || '原因不明'}${
    e.error_subcode ? `（subcode ${e.error_subcode}）` : ''
  }`;
}

export async function graphGet<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = `${GRAPH_API}/${path}?${new URLSearchParams(params)}`;
  const response = await fetch(url);
  const data = (await response.json().catch(() => ({}))) as T & { error?: GraphError };
  if (!response.ok) throw new Error(describeError(response.status, data));
  return data;
}

export async function graphPost<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const response = await fetch(`${GRAPH_API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: GraphError };
  if (!response.ok) throw new Error(describeError(response.status, data));
  return data;
}

/** トークンが指しているFacebookページのIDと名前を取得する。 */
export async function resolvePage(
  token: string,
): Promise<{ id: string; name: string }> {
  const data = await graphGet<{ id?: string; name?: string }>('me', {
    fields: 'id,name',
    access_token: token,
  });
  if (!data.id) {
    throw new Error(
      'ページ情報を取得できませんでした。META_PAGE_ACCESS_TOKEN が「ページアクセストークン」' +
        'であることを確認してください（個人のユーザートークンでは投稿できません）。',
    );
  }
  return { id: data.id, name: data.name ?? '(名称不明)' };
}

/** ページに紐づいている Instagram プロアカウントのIDを取得する。 */
export async function resolveInstagramUserId(
  pageId: string,
  token: string,
): Promise<string> {
  const data = await graphGet<{ instagram_business_account?: { id: string } }>(pageId, {
    fields: 'instagram_business_account',
    access_token: token,
  });
  const id = data.instagram_business_account?.id;
  if (!id) {
    throw new Error(
      'このFacebookページに Instagram のプロアカウントが紐づいていません。' +
        'Instagram をプロアカウント（ビジネスまたはクリエイター）に切り替えたうえで、' +
        'Facebookページと連携してください。',
    );
  }
  return id;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
