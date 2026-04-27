import fs from 'fs';
import path from 'path';

import { CardConfig } from './card-config.js';

export const CARD_REGISTRY_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
export const CARDS_RELATIVE_DIR = 'container/cards';

function getContainerDir(): string {
  return path.join(process.cwd(), 'container');
}

export function getCardsDir(): string {
  return path.join(getContainerDir(), 'cards');
}

export function validateCardRegistryKey(key: string): string | null {
  if (!key.trim()) return 'card registry key is required';
  if (!CARD_REGISTRY_KEY_PATTERN.test(key)) {
    return `card registry key "${key}" 只能包含字母、数字、下划线和中划线`;
  }
  return null;
}

export function getCardGroupFilePath(workflowType: string): string {
  const keyError = validateCardRegistryKey(workflowType);
  if (keyError) throw new Error(keyError);
  return path.join(getCardsDir(), `${workflowType}.json`);
}

function ensureCardsDir(): void {
  fs.mkdirSync(getCardsDir(), { recursive: true });
}

function isCardGroup(input: unknown): input is Record<string, CardConfig> {
  return !!input && typeof input === 'object' && !Array.isArray(input);
}

function readCardGroupFile(fileName: string): {
  workflowType: string;
  cards: Record<string, CardConfig>;
} {
  const workflowType = path.basename(fileName, '.json');
  const keyError = validateCardRegistryKey(workflowType);
  if (keyError) throw new Error(`${fileName}: ${keyError}`);

  const filePath = path.join(getCardsDir(), fileName);
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
  if (!isCardGroup(raw)) {
    throw new Error(
      `${fileName}: card 文件必须是 card key 到 card config 的对象`,
    );
  }

  return {
    workflowType,
    cards: raw,
  };
}

export function readCardRegistryFromDir(): Record<
  string,
  Record<string, CardConfig>
> {
  const cardsDir = getCardsDir();
  if (!fs.existsSync(cardsDir)) {
    return {};
  }

  const registry: Record<string, Record<string, CardConfig>> = {};
  const files = fs
    .readdirSync(cardsDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of files) {
    const group = readCardGroupFile(fileName);
    registry[group.workflowType] = group.cards;
  }

  return registry;
}

export function writeCardGroup(
  workflowType: string,
  cards: Record<string, CardConfig>,
): void {
  const keyError = validateCardRegistryKey(workflowType);
  if (keyError) throw new Error(keyError);
  ensureCardsDir();
  fs.writeFileSync(
    getCardGroupFilePath(workflowType),
    `${JSON.stringify(cards, null, 2)}\n`,
    'utf-8',
  );
}

export function writeCardRegistryToDir(
  registry: Record<string, Record<string, CardConfig>>,
): void {
  ensureCardsDir();

  for (const [workflowType, cards] of Object.entries(registry)) {
    writeCardGroup(workflowType, cards);
  }

  const activeFiles = new Set(
    Object.keys(registry).map((workflowType) => `${workflowType}.json`),
  );
  for (const fileName of fs.readdirSync(getCardsDir())) {
    if (fileName.endsWith('.json') && !activeFiles.has(fileName)) {
      fs.unlinkSync(path.join(getCardsDir(), fileName));
    }
  }
}
