import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * ローカル実行用に .env を読む。
 * 値が空の行は無視する（PC 側に設定済みの環境変数を、空欄で上書きしてしまわないため）。
 * GitHub Actions では .env が無く Secrets が環境変数に入るので、この関数は何もしない。
 */
export function loadDotEnv(path = '.env'): void {
  const file = resolve(process.cwd(), path);
  if (!existsSync(file)) return;

  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;

    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) process.env[key] = value;
  }
}

export interface AppConfig {
  suzuriUserName: string;
  itemPriority: string[];
  hashtags: string[];
  includeItemHashtag: boolean;
  copyTone: string;
  maxBodyLength: number;
  enabledPlatforms: string[];
  cooldownRuns: number;
  dryRun: boolean;
}

const CONFIG_PATH = resolve(process.cwd(), 'config.json');

export function loadConfig(): AppConfig {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<AppConfig>;

  if (!raw.suzuriUserName) {
    throw new Error(
      'config.json の suzuriUserName が空です。SUZURI のユーザー名を入れてください。\n' +
        '（自分のショップの URL が https://suzuri.jp/abcdef なら abcdef の部分です）',
    );
  }

  return {
    suzuriUserName: raw.suzuriUserName,
    itemPriority: raw.itemPriority ?? [],
    hashtags: raw.hashtags ?? ['#SUZURI'],
    includeItemHashtag: raw.includeItemHashtag ?? true,
    copyTone: raw.copyTone ?? '落ち着いた語り口',
    maxBodyLength: raw.maxBodyLength ?? 180,
    enabledPlatforms: raw.enabledPlatforms ?? ['bluesky'],
    cooldownRuns: raw.cooldownRuns ?? 3,
    dryRun: raw.dryRun ?? false,
  };
}

/** 必須の環境変数を取り出す。無ければ分かりやすいエラーにする。 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `環境変数 ${name} が設定されていません。\n` +
        'ローカルで動かす場合は .env に、GitHub Actions で動かす場合は\n' +
        'リポジトリの Settings → Secrets and variables → Actions に登録してください。',
    );
  }
  return value;
}
