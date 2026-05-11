import { describe, expect, it } from 'vitest';

import { validateEvolutionRunnerOutput } from './evolution-runner.js';

describe('evolution runner output validation', () => {
  it('accepts valid proposal JSON', () => {
    const result = validateEvolutionRunnerOutput(
      'proposal',
      JSON.stringify({
        ok: true,
        module_scope: 'assistant',
        direction: '补充自我进化状态展示',
        risk_level: 'low',
        proposal: '# Plan',
        requires_user_approval: false,
        blocked_by_policy: false,
        blocked_reason: null,
      }),
    );

    expect(result.ok).toBe(true);
    expect('proposal' in result && result.proposal).toBe('# Plan');
  });

  it('rejects non-json runner output', () => {
    expect(() =>
      validateEvolutionRunnerOutput('proposal', '```json\n{}\n```'),
    ).toThrow(/Unexpected token/);
  });

  it('rejects invalid risk levels', () => {
    expect(() =>
      validateEvolutionRunnerOutput(
        'review',
        JSON.stringify({
          ok: true,
          review_complete: true,
          implementation_coverage: 'ok',
          bug_report: null,
          required_fixes: [],
          risk_level: 'critical',
        }),
      ),
    ).toThrow(/invalid risk_level/);
  });

  it('accepts implementation policy blocks', () => {
    const result = validateEvolutionRunnerOutput(
      'implementation',
      JSON.stringify({
        ok: false,
        implementation_summary: 'blocked',
        changed_files: [],
        requires_followup: true,
        blocked_by_policy: true,
        blocked_reason: 'needs secrets',
      }),
    );

    expect(result.ok).toBe(false);
    expect(
      'blocked_by_policy' in result && result.blocked_by_policy,
    ).toBe(true);
  });
});
