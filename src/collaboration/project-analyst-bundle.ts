export const COLLABORATION_GROUP_README_PATH = 'README.md' as const;
export const COLLABORATION_PROJECT_ANALYST_ROOT =
  'tools/project-analyst' as const;

export const PROJECT_ANALYST_BUNDLE_RELATIVE_PATHS = [
  'SKILL.md',
  'agents/openai.yaml',
  'contracts/analysis-input.schema.json',
  'contracts/analysis-result.schema.json',
  'contracts/proposed-action.schema.json',
  'contracts/repository-analysis-input.schema.json',
  'contracts/repository-analysis-result.schema.json',
  'contracts/repository-verification.schema.json',
  'references/action-policy.md',
  'references/evidence-rules.md',
  'references/finding-taxonomy.md',
  'references/package-mode.md',
  'references/repository-mode.md',
  'references/trust-model.md',
  'scripts/check-runtime.mjs',
  'scripts/install.mjs',
  'scripts/repository-context.mjs',
  'scripts/validate-result.mjs',
  'scripts/verify-evidence.mjs',
] as const;

export const PROJECT_ANALYST_CAPABILITY_STATIC_RELATIVE_PATHS = [
  'SKILL.md',
  'references/action-policy.md',
  'references/evidence-rules.md',
  'references/finding-taxonomy.md',
  'references/package-mode.md',
  'references/repository-mode.md',
  'references/trust-model.md',
  'scripts/validate-result.mjs',
  'scripts/verify-evidence.mjs',
] as const;
