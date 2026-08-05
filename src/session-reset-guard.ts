const resetEpochs = new Map<string, number>();

export function getSessionResetEpoch(agentFolder: string): number {
  return resetEpochs.get(agentFolder) ?? 0;
}

export function bumpSessionResetEpoch(agentFolder: string): number {
  const next = getSessionResetEpoch(agentFolder) + 1;
  resetEpochs.set(agentFolder, next);
  return next;
}

export function isSessionResetEpochCurrent(
  agentFolder: string,
  epoch: number,
): boolean {
  return getSessionResetEpoch(agentFolder) === epoch;
}

export function _resetSessionResetGuardForTests(): void {
  resetEpochs.clear();
}
