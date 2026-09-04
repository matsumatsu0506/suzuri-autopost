import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Slot } from './types.js';

export interface MaterialState {
  /** 最後に投稿した日時（ISO8601）。未投稿なら null。 */
  lastPostedAt: string | null;
  postCount: number;
  /** 前回の紹介文。次回「これと違う切り口で」と指示するために使う。 */
  lastText: string | null;
  title: string;
}

export interface LastRun {
  at: string;
  slot: Slot;
  materialId: number | null;
  productId: number | null;
  status: 'success' | 'skipped' | 'failed';
  message?: string;
}

export interface State {
  version: 1;
  materials: Record<string, MaterialState>;
  /** 直近に投稿したデザインID（新しい順）。朝と夜で同じ絵柄が出ないようにするため。 */
  recentMaterialIds: number[];
  lastRun: LastRun | null;
}

const STATE_PATH = resolve(process.cwd(), 'state', 'posted.json');

const EMPTY_STATE: State = {
  version: 1,
  materials: {},
  recentMaterialIds: [],
  lastRun: null,
};

export function loadState(): State {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<State>;
    return {
      version: 1,
      materials: parsed.materials ?? {},
      recentMaterialIds: parsed.recentMaterialIds ?? [],
      lastRun: parsed.lastRun ?? null,
    };
  } catch {
    // ファイルが無い / 壊れている場合は空の状態から始める（全商品が未投稿扱いになる）
    return structuredClone(EMPTY_STATE);
  }
}

export function saveState(state: State): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function getMaterialState(state: State, materialId: number): MaterialState | undefined {
  return state.materials[String(materialId)];
}

/** 投稿成功後に状態を更新する。 */
export function recordPost(
  state: State,
  params: {
    materialId: number;
    materialTitle: string;
    productId: number;
    text: string;
    slot: Slot;
    cooldownRuns: number;
  },
): void {
  const key = String(params.materialId);
  const previous = state.materials[key];
  const now = new Date().toISOString();

  state.materials[key] = {
    lastPostedAt: now,
    postCount: (previous?.postCount ?? 0) + 1,
    lastText: params.text,
    title: params.materialTitle,
  };

  state.recentMaterialIds = [
    params.materialId,
    ...state.recentMaterialIds.filter((id) => id !== params.materialId),
  ].slice(0, Math.max(params.cooldownRuns, 1));

  state.lastRun = {
    at: now,
    slot: params.slot,
    materialId: params.materialId,
    productId: params.productId,
    status: 'success',
  };
}

export function recordNonPost(
  state: State,
  params: { slot: Slot; status: 'skipped' | 'failed'; message: string },
): void {
  state.lastRun = {
    at: new Date().toISOString(),
    slot: params.slot,
    materialId: null,
    productId: null,
    status: params.status,
    message: params.message,
  };
}
