import { loadConfig, loadDotEnv, requireEnv } from './config.js';
import { composePost } from './compose.js';
import { generateCopy } from './copy.js';
import { prepareImage } from './image.js';
import { BlueskyAdapter } from './platforms/bluesky.js';
import { ThreadsAdapter } from './platforms/threads.js';
import type { PostAdapter } from './platforms/types.js';
import { groupByMaterial, selectTarget } from './select.js';
import { loadState, recordNonPost, recordPost, saveState } from './state.js';
import { fetchAllProducts } from './suzuri.js';
import type { Slot } from './types.js';

// ローカル実行用に .env を読む（GitHub Actions では Secrets が環境変数で入るので無くてよい）
loadDotEnv();

interface Args {
  slot: Slot;
  dryRun: boolean;
  materialId?: number;
  check: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { slot: 'manual', dryRun: false, check: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--check') args.check = true;
    else if (arg.startsWith('--slot=')) {
      const value = arg.slice('--slot='.length);
      if (value === 'morning' || value === 'evening' || value === 'manual') args.slot = value;
      else throw new Error(`--slot には morning / evening / manual のいずれかを指定してください（指定値: ${value}）`);
    } else if (arg.startsWith('--material-id=')) {
      const value = Number.parseInt(arg.slice('--material-id='.length), 10);
      if (Number.isNaN(value)) throw new Error('--material-id には数値を指定してください');
      args.materialId = value;
    }
  }
  return args;
}

function line(label: string, value: string | number): void {
  console.log(`${label}: ${value}`);
}

/** 手順1: SUZURI のレスポンスに、使う予定のフィールドが本当に存在するか確認する。 */
function runFieldCheck(products: unknown[]): void {
  const fields: [string, (p: any) => unknown][] = [
    ['id', (p) => p.id],
    ['title', (p) => p.title],
    ['published', (p) => p.published],
    ['sampleImageUrl', (p) => p.sampleImageUrl],
    ['sampleUrl', (p) => p.sampleUrl],
    ['priceWithTax', (p) => p.priceWithTax],
    ['item.name', (p) => p.item?.name],
    ['item.humanizeName', (p) => p.item?.humanizeName],
    ['material.id', (p) => p.material?.id],
    ['material.title', (p) => p.material?.title],
    ['material.description', (p) => p.material?.description],
  ];

  console.log('=== フィールドの存在確認 ===');
  line('取得した商品数', products.length);
  for (const [name, get] of fields) {
    const present = products.filter((p) => {
      const v = get(p);
      return v !== undefined && v !== null && v !== '';
    }).length;
    const sample = products.length > 0 ? get(products[0]) : undefined;
    const shown = typeof sample === 'string' ? `${sample.slice(0, 60)}` : String(sample);
    console.log(`  ${name}: ${present}/${products.length} 件に値あり  例: ${shown}`);
  }
  console.log('');
}

function buildAdapters(enabled: string[]): PostAdapter[] {
  return enabled.map((name) => {
    if (name === 'bluesky') return new BlueskyAdapter();
    if (name === 'threads') return new ThreadsAdapter();
    throw new Error(`config.json の enabledPlatforms に未知の値があります: ${name}`);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const dryRun = args.dryRun || config.dryRun;

  line('実行モード', dryRun ? 'dry-run（投稿しません）' : '本番投稿');
  line('スロット', args.slot);
  console.log('');

  const token = requireEnv('SUZURI_API_TOKEN');
  console.log('SUZURI から商品を取得しています...');
  const products = await fetchAllProducts(config.suzuriUserName, token);
  line('取得した商品数', products.length);

  if (args.check) {
    runFieldCheck(products);
    const groups = groupByMaterial(products);
    line('公開中のデザイン数（material）', groups.length);
    line('公開中の商品数（product）', groups.reduce((n, g) => n + g.products.length, 0));
    console.log('');
    console.log('デザインごとのアイテム数（上位10件）:');
    for (const g of groups.slice(0, 10)) {
      console.log(`  ${g.materialTitle} … ${g.products.length} アイテム`);
    }

    // config.json の itemPriority を決めるための材料
    const counts = new Map<string, { label: string; n: number; minPrice: number }>();
    for (const g of groups) {
      for (const p of g.products) {
        const key = p.item?.name ?? '(不明)';
        const current = counts.get(key);
        if (current) {
          current.n += 1;
          current.minPrice = Math.min(current.minPrice, p.priceWithTax);
        } else {
          counts.set(key, {
            label: p.item?.humanizeName ?? key,
            n: 1,
            minPrice: p.priceWithTax,
          });
        }
      }
    }
    console.log('');
    console.log('アイテム種別ごとの取扱デザイン数（config.json の itemPriority 用）:');
    for (const [name, info] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  ${name}  …  ${info.n} デザイン / 最安 ${info.minPrice}円 / ${info.label}`);
    }
    return;
  }

  const state = loadState();
  const selection = selectTarget(products, state, config, { materialId: args.materialId });

  if (!selection) {
    const message = '投稿できる商品が見つかりませんでした。';
    console.log(message);
    if (!dryRun) {
      recordNonPost(state, { slot: args.slot, status: 'skipped', message });
      saveState(state);
    }
    return;
  }

  const { group, product, postCount, lastText } = selection;
  console.log('');
  console.log('=== 投稿する商品 ===');
  line('デザイン名', group.materialTitle);
  line('デザインID', group.materialId);
  line('商品名', product.title);
  line('商品ID', product.id);
  line('アイテム', product.item?.humanizeName ?? product.item?.name ?? '(不明)');
  line('税込価格', `${product.priceWithTax.toLocaleString('ja-JP')}円`);
  line('商品ページ', product.sampleUrl);
  line('画像URL', product.sampleImageUrl);
  line('このデザインの紹介回数', `${postCount} 回目まで完了`);
  console.log('');

  console.log('画像を JPEG に変換しています...');
  const image = await prepareImage(product.sampleImageUrl);
  line('変換後の画像', `${image.width}x${image.height} / ${Math.round(image.bytes / 1024)} KB`);

  console.log('紹介文を生成しています...');
  const copy = await generateCopy(product, image, config, {
    materialTitle: group.materialTitle,
    materialDescription: group.materialDescription,
    postCount,
    lastText,
  });
  line('生成方法', copy.fallback ? '定型文（Gemini を使えませんでした）' : 'Gemini');

  const composed = composePost(copy.body, product, config);

  console.log('');
  console.log('=== 投稿される本文 ===');
  console.log(composed.text);
  console.log('=== ここまで ===');
  line('文字数', `${composed.graphemes} / 300`);
  if (composed.trimmed) console.log('※ 上限に収めるため紹介文を短くしました。');
  console.log('');
  console.log('=== 画像の代替テキスト（alt） ===');
  console.log(copy.alt);
  console.log('=== ここまで ===');
  console.log('');

  if (dryRun) {
    console.log('dry-run のため、ここで終了します。投稿も記録もしていません。');
    return;
  }

  const adapters = buildAdapters(config.enabledPlatforms);
  const results = [];
  for (const adapter of adapters) {
    console.log(`${adapter.name} へ投稿しています...`);
    const result = await adapter.post({
      text: composed.text,
      altText: copy.alt,
      imageBuffer: image.buffer,
      imageMimeType: image.mimeType,
      imageWidth: image.width,
      imageHeight: image.height,
      linkUrl: product.sampleUrl,
    });
    results.push(result);
    if (result.ok) console.log(`  成功: ${result.uri}`);
    else console.error(`  失敗: ${result.error}`);
  }

  const anySuccess = results.some((r) => r.ok);
  if (anySuccess) {
    recordPost(state, {
      materialId: group.materialId,
      materialTitle: group.materialTitle,
      productId: product.id,
      text: composed.body,
      slot: args.slot,
      cooldownRuns: config.cooldownRuns,
    });
    saveState(state);
    console.log('投稿が完了し、state/posted.json を更新しました。');
  } else {
    const message = results.map((r) => `${r.platform}: ${r.error}`).join(' / ');
    recordNonPost(state, { slot: args.slot, status: 'failed', message });
    saveState(state);
    console.error('SUZURI_AUTOPOST_FAILED すべてのSNSへの投稿に失敗しました。');
    process.exitCode = 1;
  }
}

main().catch((error: Error) => {
  console.error('SUZURI_AUTOPOST_FAILED', error.message);
  process.exitCode = 1;
});
