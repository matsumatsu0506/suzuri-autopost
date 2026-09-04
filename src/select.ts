import type { AppConfig } from './config.js';
import type { State } from './state.js';
import { getMaterialState } from './state.js';
import type { MaterialGroup, SuzuriProduct } from './types.js';

export interface Selection {
  group: MaterialGroup;
  product: SuzuriProduct;
  postCount: number;
  lastText: string | null;
}

/**
 * SUZURI は「1つのデザイン（material）× 多数のアイテム」で商品が作られるため、
 * 商品を単純に1件ずつ選ぶと同じ絵柄が何日も連続してしまう。
 * そのため投稿対象は必ず material 単位で選ぶ。
 */
export function groupByMaterial(products: SuzuriProduct[]): MaterialGroup[] {
  const groups = new Map<number, MaterialGroup>();

  for (const product of products) {
    if (!product.published) continue;
    if (!product.material || !product.sampleImageUrl || !product.sampleUrl) continue;

    const id = product.material.id;
    let group = groups.get(id);
    if (!group) {
      group = {
        materialId: id,
        materialTitle: product.material.title ?? '(無題)',
        materialDescription: product.material.description ?? null,
        products: [],
      };
      groups.set(id, group);
    }
    group.products.push(product);
  }

  return [...groups.values()];
}

/**
 * グループの中から実際に投稿する商品を1点選ぶ。
 *
 * 同じデザインが2周目・3周目に回ってきたときは別のアイテムを見せたいので、
 * itemPriority に載っていて実在するものを並べ、postCount 番目を順番に使う。
 */
function pickProduct(
  group: MaterialGroup,
  itemPriority: string[],
  postCount: number,
): SuzuriProduct {
  const candidates: SuzuriProduct[] = [];
  for (const wanted of itemPriority) {
    const hit = group.products.find((p) => p.item?.name === wanted);
    if (hit) candidates.push(hit);
  }
  if (candidates.length > 0) {
    return candidates[postCount % candidates.length];
  }
  // 優先アイテムが1つも無ければ一番安いもの。同額なら商品ID順で毎回同じ結果になるようにする。
  return [...group.products].sort(
    (a, b) => a.priceWithTax - b.priceWithTax || a.id - b.id,
  )[0];
}

export function selectTarget(
  products: SuzuriProduct[],
  state: State,
  config: AppConfig,
  options: { materialId?: number } = {},
): Selection | null {
  const groups = groupByMaterial(products);
  if (groups.length === 0) return null;

  // --material-id で指定された場合はそれを使う（動作確認用）
  if (options.materialId !== undefined) {
    const forced = groups.find((g) => g.materialId === options.materialId);
    if (!forced) return null;
    const ms = getMaterialState(state, forced.materialId);
    const postCount = ms?.postCount ?? 0;
    return {
      group: forced,
      product: pickProduct(forced, config.itemPriority, postCount),
      postCount,
      lastText: ms?.lastText ?? null,
    };
  }

  // 直近に投稿したデザインは除外する（朝と夜で必ず違う絵柄にするため）
  const recent = new Set(state.recentMaterialIds);
  let candidates = groups.filter((g) => !recent.has(g.materialId));
  // 全部が除外対象になるほどデザインが少ない場合は、除外せずに一番古いものを使う
  if (candidates.length === 0) candidates = groups;

  const sorted = candidates.sort((a, b) => {
    const aAt = getMaterialState(state, a.materialId)?.lastPostedAt ?? null;
    const bAt = getMaterialState(state, b.materialId)?.lastPostedAt ?? null;
    // 未投稿（null）を最優先
    if (aAt === null && bAt !== null) return -1;
    if (aAt !== null && bAt === null) return 1;
    if (aAt !== null && bAt !== null && aAt !== bAt) return aAt < bAt ? -1 : 1;
    // 同着は materialId 昇順で、実行結果が毎回同じになるようにする
    return a.materialId - b.materialId;
  });

  const group = sorted[0];
  const ms = getMaterialState(state, group.materialId);
  const postCount = ms?.postCount ?? 0;
  return {
    group,
    product: pickProduct(group, config.itemPriority, postCount),
    postCount,
    lastText: ms?.lastText ?? null,
  };
}
