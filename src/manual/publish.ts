import { AtpAgent, RichText } from '@atproto/api';
import { requireEnv } from '../config.js';
import {
  GRAPH_VERSION,
  describeError,
  graphGet,
  graphPost,
  resolveInstagramUserId,
  resolvePage,
  sleep,
} from '../platforms/meta.js';
import { API as THREADS_API, callThreadsApi, fetchPermalink, fetchUserId } from '../platforms/threads.js';
import type { Platform, QueueMedia } from './queue.js';

/**
 * 手動投稿・予約投稿で、各SNSに1件投稿する処理（GitHub Actions で実行）。
 *
 * SUZURI の自動投稿（src/platforms/*.ts）とは別にしてある。
 * 自動投稿は「画像1枚＋商品リンク」専用で本番稼働中なので、そちらには手を入れないため。
 */

export interface PublishInput {
  text: string;
  media: QueueMedia | null;
  /** 添付ファイルの中身。Bluesky と Facebook はファイルを直接送る。 */
  loadMedia: () => Promise<Buffer>;
  /**
   * Bluesky に投稿した画像の CDN URL。
   * Meta はこの URL なら確実に取りに行ける（SUZURI 自動投稿で実証済み）ので、画像ではこれを優先する。
   */
  publicImageUrl?: string;
}

export interface PublishResult {
  /** 投稿の閲覧用URL */
  uri: string;
  publicImageUrl?: string;
}

// ---------------------------------------------------------------------------
// 公開URLの扱い（Threads / Instagram 用）
// ---------------------------------------------------------------------------

/** GitHub Release のURLは別のホストに転送される。その転送先（署名付きの直接URL）を取る。 */
async function resolveRedirect(url: string): Promise<string> {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) return new URL(location, url).toString();
  } catch {
    /* 取れなければ元のURLのまま */
  }
  return url;
}

/**
 * 公開URLを順に試す。
 * 1. Bluesky の CDN URL（画像のみ） 2. GitHub Release のURL 3. その転送先の直接URL
 * 転送先の直接URLは数分で失効するので、使う直前に取り直す。
 *
 * attempt には「コンテナ作成〜処理完了待ち」までを入れ、公開（publish）は入れないこと。
 * 公開まで入れると、失敗の判定を誤ったときに二重投稿になる。
 */
async function withMediaUrl<T>(input: PublishInput, attempt: (url: string) => Promise<T>): Promise<T> {
  const media = input.media;
  if (!media) throw new Error('添付ファイルがありません。');

  const candidates: (() => Promise<string>)[] = [];
  if (media.kind === 'image' && input.publicImageUrl) {
    const cdn = input.publicImageUrl;
    candidates.push(async () => cdn);
  }
  candidates.push(async () => media.url);
  candidates.push(() => resolveRedirect(media.url));

  const tried = new Set<string>();
  const errors: string[] = [];
  for (const getUrl of candidates) {
    const url = await getUrl();
    if (tried.has(url)) continue;
    tried.add(url);
    try {
      return await attempt(url);
    } catch (error) {
      const message = (error as Error).message;
      errors.push(message);
      console.warn(`  このURLでは失敗しました: ${message}`);
    }
  }
  throw new Error(errors.join(' / '));
}

// ---------------------------------------------------------------------------
// Bluesky
// ---------------------------------------------------------------------------

const BLUESKY_VIDEO_SERVICE = 'https://video.bsky.app';

/**
 * Bluesky の動画は、動画サービス（video.bsky.app）にアップロードして変換してもらい、
 * 出来上がった blob を投稿に添付する。
 */
export async function uploadBlueskyVideo(agent: AtpAgent, data: Buffer, media: Pick<QueueMedia, 'fileName'>) {
  const did = agent.session?.did;
  if (!did) throw new Error('Bluesky にログインできていません。');

  // 1日あたりの動画アップロード数には上限があるので、先に確認する
  const { data: limitAuth } = await agent.com.atproto.server.getServiceAuth({
    aud: 'did:web:video.bsky.app',
    lxm: 'app.bsky.video.getUploadLimits',
  });
  const limitResponse = await fetch(`${BLUESKY_VIDEO_SERVICE}/xrpc/app.bsky.video.getUploadLimits`, {
    headers: { Authorization: `Bearer ${limitAuth.token}` },
  });
  if (limitResponse.ok) {
    const limits = (await limitResponse.json()) as { canUpload?: boolean; message?: string; error?: string };
    if (limits.canUpload === false) {
      throw new Error(`Bluesky の動画アップロード上限に達しています: ${limits.message ?? limits.error ?? ''}`);
    }
  }

  // アップロード用の認証は「自分のPDS」宛てに発行する
  const pdsHost = (agent.pdsUrl ?? agent.dispatchUrl).host;
  const { data: uploadAuth } = await agent.com.atproto.server.getServiceAuth({
    aud: `did:web:${pdsHost}`,
    lxm: 'com.atproto.repo.uploadBlob',
    exp: Math.floor(Date.now() / 1000) + 60 * 30,
  });

  const uploadUrl = new URL(`${BLUESKY_VIDEO_SERVICE}/xrpc/app.bsky.video.uploadVideo`);
  uploadUrl.searchParams.set('did', did);
  uploadUrl.searchParams.set('name', media.fileName);
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${uploadAuth.token}`, 'Content-Type': 'video/mp4' },
    body: new Uint8Array(data),
  });
  const body = (await response.json().catch(() => ({}))) as {
    jobId?: string;
    jobStatus?: { jobId?: string };
    error?: string;
    message?: string;
  };
  // 同じ動画を以前アップロードしていると 409 が返るが、jobId は返ってくるのでそのまま続ける
  const jobId = body.jobId ?? body.jobStatus?.jobId;
  if (!jobId) {
    throw new Error(
      `Bluesky への動画アップロードに失敗しました（HTTP ${response.status}）: ${body.message ?? body.error ?? '原因不明'}`,
    );
  }

  const videoAgent = new AtpAgent({ service: BLUESKY_VIDEO_SERVICE });
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const { data: status } = await videoAgent.app.bsky.video.getJobStatus({ jobId });
    const job = status.jobStatus;
    if (job.blob) return job.blob;
    if (job.state === 'JOB_STATE_FAILED') {
      throw new Error(`Bluesky で動画の処理に失敗しました: ${job.message ?? job.error ?? '原因不明'}`);
    }
    await sleep(3000);
  }
  throw new Error('Bluesky での動画の処理が10分以内に終わりませんでした。');
}

export async function publishToBluesky(input: PublishInput): Promise<PublishResult> {
  const agent = new AtpAgent({ service: 'https://bsky.social' });
  await agent.login({
    identifier: requireEnv('BLUESKY_IDENTIFIER'),
    password: requireEnv('BLUESKY_APP_PASSWORD'),
  });

  const rt = new RichText({ text: input.text });
  await rt.detectFacets(agent);

  const media = input.media;
  const aspectRatio =
    media && media.width > 0 && media.height > 0 ? { width: media.width, height: media.height } : undefined;
  let embed: ({ $type: string } & Record<string, unknown>) | undefined;
  let publicImageUrl: string | undefined;

  if (media?.kind === 'image') {
    const uploaded = await agent.uploadBlob(await input.loadMedia(), { encoding: media.mimeType });
    embed = {
      $type: 'app.bsky.embed.images',
      images: [{ image: uploaded.data.blob, alt: media.alt, aspectRatio }],
    };
    // 後続の Threads / Instagram に渡すため、CDN の公開URLを組み立てる（platforms/bluesky.ts と同じ）
    const cid =
      (uploaded.data.blob.ref as unknown as { $link?: string })?.$link ?? String(uploaded.data.blob.ref);
    const did = agent.session?.did;
    if (did && cid) publicImageUrl = `https://cdn.bsky.app/img/feed_fullsize/plain/${did}/${cid}@jpeg`;
  } else if (media?.kind === 'video') {
    const blob = await uploadBlueskyVideo(agent, await input.loadMedia(), media);
    embed = {
      $type: 'app.bsky.embed.video',
      video: blob,
      ...(media.alt ? { alt: media.alt } : {}),
      aspectRatio,
    };
  }

  const response = await agent.post({
    text: rt.text,
    facets: rt.facets,
    langs: ['ja'],
    ...(embed ? { embed } : {}),
    createdAt: new Date().toISOString(),
  });

  // at://did/app.bsky.feed.post/rkey → ブラウザで開けるURLにする
  const rkey = response.uri.split('/').pop();
  const did = agent.session?.did;
  const uri = did && rkey ? `https://bsky.app/profile/${did}/post/${rkey}` : response.uri;
  return { uri, publicImageUrl };
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/** Meta の推奨どおり、コンテナ作成から公開まで最低30秒あける。 */
const THREADS_MIN_WAIT_MS = 30_000;

async function waitThreadsContainer(containerId: string, token: string, createdAt: number): Promise<void> {
  const deadline = Date.now() + 10 * 60 * 1000;
  for (;;) {
    await sleep(10_000);
    const response = await fetch(
      `${THREADS_API}/${containerId}?fields=status,error_message&access_token=${encodeURIComponent(token)}`,
    );
    const data = (await response.json().catch(() => ({}))) as { status?: string; error_message?: string };
    if (data.status === 'FINISHED') break;
    if (data.status === 'ERROR' || data.status === 'EXPIRED') {
      throw new Error(`Threads でメディアの処理に失敗しました: ${data.error_message ?? data.status}`);
    }
    if (Date.now() > deadline) throw new Error('Threads でのメディアの処理が時間内に終わりませんでした。');
    console.log(`  Threads で処理中です（${data.status ?? '状態不明'}）...`);
  }
  const rest = THREADS_MIN_WAIT_MS - (Date.now() - createdAt);
  if (rest > 0) await sleep(rest);
}

function requireContainerId(container: Record<string, unknown>): string {
  if (typeof container.id !== 'string') {
    throw new Error(`コンテナIDを取得できませんでした: ${JSON.stringify(container)}`);
  }
  return container.id;
}

export async function publishToThreads(input: PublishInput): Promise<PublishResult> {
  const token = requireEnv('THREADS_ACCESS_TOKEN');
  const userId = await fetchUserId(token);
  const media = input.media;

  let creationId: string;
  if (!media) {
    const createdAt = Date.now();
    creationId = requireContainerId(
      await callThreadsApi(`${userId}/threads`, { media_type: 'TEXT', text: input.text, access_token: token }),
    );
    await waitThreadsContainer(creationId, token, createdAt);
  } else {
    creationId = await withMediaUrl(input, async (url) => {
      const params: Record<string, string> =
        media.kind === 'video'
          ? { media_type: 'VIDEO', video_url: url, access_token: token }
          : { media_type: 'IMAGE', image_url: url, access_token: token };
      if (input.text) params.text = input.text;
      if (media.kind === 'image' && media.alt) params.alt_text = media.alt;
      const createdAt = Date.now();
      const id = requireContainerId(await callThreadsApi(`${userId}/threads`, params));
      await waitThreadsContainer(id, token, createdAt);
      return id;
    });
  }

  const published = await callThreadsApi(`${userId}/threads_publish`, {
    creation_id: creationId,
    access_token: token,
  });
  const postId = published.id;
  if (typeof postId !== 'string') throw new Error(`公開後のIDを取得できませんでした: ${JSON.stringify(published)}`);
  const permalink = await fetchPermalink(postId, token);
  return { uri: permalink ?? `投稿ID ${postId}` };
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

async function waitInstagramContainer(containerId: string, token: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await sleep(10_000);
    const status = await graphGet<{ status_code?: string; status?: string }>(containerId, {
      fields: 'status_code,status',
      access_token: token,
    });
    if (status.status_code === 'FINISHED') return;
    if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
      throw new Error(`Instagram でメディアの処理に失敗しました: ${status.status ?? status.status_code}`);
    }
    if (Date.now() > deadline) throw new Error('Instagram でのメディアの処理が時間内に終わりませんでした。');
    console.log(`  Instagram で処理中です（${status.status_code ?? '状態不明'}）...`);
  }
}

export async function publishToInstagram(input: PublishInput): Promise<PublishResult> {
  const media = input.media;
  if (!media) throw new Error('Instagram は文字だけの投稿ができません。');
  const token = requireEnv('META_PAGE_ACCESS_TOKEN');
  const page = await resolvePage(token);
  const igUserId = await resolveInstagramUserId(page.id, token);

  const creationId = await withMediaUrl(input, async (url) => {
    // 動画はリールとして投稿する。リールには代替テキストを付けられない（API の仕様）。
    const params: Record<string, string> =
      media.kind === 'video'
        ? { media_type: 'REELS', video_url: url, caption: input.text, access_token: token }
        : { image_url: url, caption: input.text, alt_text: media.alt, access_token: token };
    const container = await graphPost<{ id?: string }>(`${igUserId}/media`, params);
    if (!container.id) throw new Error('コンテナIDを取得できませんでした。');
    await waitInstagramContainer(container.id, token, media.kind === 'video' ? 10 * 60 * 1000 : 2 * 60 * 1000);
    return container.id;
  });

  const published = await graphPost<{ id?: string }>(`${igUserId}/media_publish`, {
    creation_id: creationId,
    access_token: token,
  });
  if (!published.id) throw new Error('公開後のIDを取得できませんでした。');

  let permalink: string | undefined;
  try {
    permalink = (await graphGet<{ permalink?: string }>(published.id, { fields: 'permalink', access_token: token }))
      .permalink;
  } catch {
    /* URLが取れなくても投稿自体は成功している */
  }
  return { uri: permalink ?? `投稿ID ${published.id}` };
}

// ---------------------------------------------------------------------------
// Facebookページ
// ---------------------------------------------------------------------------

/** ファイルを直接アップロードする（公開URLを Meta に取りに行かせないので確実）。 */
export async function uploadToFacebook<T>(
  host: string,
  path: string,
  fields: Record<string, string>,
  file: { data: Buffer; name: string; type: string },
): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set('source', new Blob([new Uint8Array(file.data)], { type: file.type }), file.name);
  const response = await fetch(`https://${host}/${GRAPH_VERSION}/${path}`, { method: 'POST', body: form });
  const data = (await response.json().catch(() => ({}))) as T & { error?: Parameters<typeof describeError>[1]['error'] };
  if (!response.ok) throw new Error(describeError(response.status, data));
  return data;
}

export async function publishToFacebook(input: PublishInput): Promise<PublishResult> {
  const token = requireEnv('META_PAGE_ACCESS_TOKEN');
  const page = await resolvePage(token);
  const media = input.media;

  if (!media) {
    const result = await graphPost<{ id?: string }>(`${page.id}/feed`, { message: input.text, access_token: token });
    if (!result.id) throw new Error('投稿IDを取得できませんでした。');
    return { uri: `https://www.facebook.com/${result.id}` };
  }

  if (media.kind === 'video') {
    const result = await uploadToFacebook<{ id?: string }>(
      'graph-video.facebook.com',
      `${page.id}/videos`,
      { description: input.text, access_token: token },
      { data: await input.loadMedia(), name: media.fileName, type: media.mimeType },
    );
    if (!result.id) throw new Error('動画IDを取得できませんでした。');
    return { uri: `https://www.facebook.com/${page.id}/videos/${result.id}` };
  }

  const fields: Record<string, string> = {
    message: input.text,
    published: 'true',
    alt_text_custom: media.alt,
    access_token: token,
  };
  const result = input.publicImageUrl
    ? await graphPost<{ id?: string; post_id?: string }>(`${page.id}/photos`, { ...fields, url: input.publicImageUrl })
    : await uploadToFacebook<{ id?: string; post_id?: string }>('graph.facebook.com', `${page.id}/photos`, fields, {
        data: await input.loadMedia(),
        name: media.fileName,
        type: media.mimeType,
      });
  const postId = result.post_id ?? result.id;
  if (!postId) throw new Error('投稿IDを取得できませんでした。');
  return { uri: `https://www.facebook.com/${postId}` };
}

export const PUBLISHERS: Record<Platform, (input: PublishInput) => Promise<PublishResult>> = {
  bluesky: publishToBluesky,
  threads: publishToThreads,
  instagram: publishToInstagram,
  facebook: publishToFacebook,
};
