/** SUZURI API が返す商品情報のうち、このアプリで使うフィールドだけを定義したもの。 */

export interface SuzuriItem {
  id: number;
  name: string;
  humanizeName?: string;
}

export interface SuzuriMaterial {
  id: number;
  title: string;
  description?: string | null;
}

export interface SuzuriProduct {
  id: number;
  title: string;
  published: boolean;
  sampleImageUrl: string;
  sampleUrl: string;
  priceWithTax: number;
  item: SuzuriItem;
  material: SuzuriMaterial;
}

/** 同じデザイン（material）から作られた商品をまとめたもの。投稿対象はこの単位で選ぶ。 */
export interface MaterialGroup {
  materialId: number;
  materialTitle: string;
  materialDescription: string | null;
  products: SuzuriProduct[];
}

export type Slot = 'morning' | 'evening' | 'manual';
