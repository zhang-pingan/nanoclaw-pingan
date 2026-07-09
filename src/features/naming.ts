export function getFeatureOwnedTablePrefixes(featureId: string): string[] {
  const normalized = normalizeFeatureIdForSql(featureId);
  return [...new Set([`feature_${normalized}_`, `feature_${featureId}_`])];
}

export function isFeatureOwnedTableName(
  featureId: string,
  tableName: string,
): boolean {
  return getFeatureOwnedTablePrefixes(featureId).some((prefix) =>
    tableName.startsWith(prefix),
  );
}

export function normalizeFeatureIdForSql(featureId: string): string {
  return featureId.replace(/[^A-Za-z0-9]+/g, '_');
}
