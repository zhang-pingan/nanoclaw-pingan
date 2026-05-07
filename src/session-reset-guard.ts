const resetEpochs = new Map<string, number>();

export function getSessionResetEpoch(groupFolder: string): number {
  return resetEpochs.get(groupFolder) ?? 0;
}

export function bumpSessionResetEpoch(groupFolder: string): number {
  const next = getSessionResetEpoch(groupFolder) + 1;
  resetEpochs.set(groupFolder, next);
  return next;
}

export function isSessionResetEpochCurrent(
  groupFolder: string,
  epoch: number,
): boolean {
  return getSessionResetEpoch(groupFolder) === epoch;
}

export function _resetSessionResetGuardForTests(): void {
  resetEpochs.clear();
}
