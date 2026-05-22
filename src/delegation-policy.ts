import { readEnvFile } from './env.js';

const CROSS_CHANNEL_TARGET_ENV_KEYS = [
  'ICARUS_CROSS_CHANNEL_DELEGATION_TARGET_CHANNELS',
  'DELEGATION_CROSS_CHANNEL_TARGETS',
];

const envConfig = readEnvFile(CROSS_CHANNEL_TARGET_ENV_KEYS);

export function parseDelegationTargetChannels(value?: string): Set<string> {
  return new Set(
    (value || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function getFolderChannel(folder: string): string {
  return String(folder || '')
    .split('_')[0]
    .trim()
    .toLowerCase();
}

export function getCrossChannelDelegationTargetChannels(): Set<string> {
  const configured =
    process.env.ICARUS_CROSS_CHANNEL_DELEGATION_TARGET_CHANNELS ||
    process.env.DELEGATION_CROSS_CHANNEL_TARGETS ||
    envConfig.ICARUS_CROSS_CHANNEL_DELEGATION_TARGET_CHANNELS ||
    envConfig.DELEGATION_CROSS_CHANNEL_TARGETS;
  return parseDelegationTargetChannels(configured);
}

export function isAllowedCrossChannelDelegationTargetFolder(
  targetFolder: string,
  allowedTargetChannels = getCrossChannelDelegationTargetChannels(),
): boolean {
  const targetChannel = getFolderChannel(targetFolder);
  return Boolean(targetChannel && allowedTargetChannels.has(targetChannel));
}

export function canDelegateToFolder(
  sourceFolder: string,
  targetFolder: string,
  allowedTargetChannels = getCrossChannelDelegationTargetChannels(),
): boolean {
  const sourceChannel = getFolderChannel(sourceFolder);
  const targetChannel = getFolderChannel(targetFolder);
  if (!sourceChannel || !targetChannel) return false;
  if (sourceChannel === targetChannel) return true;
  return allowedTargetChannels.has(targetChannel);
}
