import { describe, expect, it } from 'vitest';

import {
  collaborationActionInputV3Schema,
  type ActionDefinitionV3,
  type HandoffEnvelopeV3,
  type MachineDefinitionV3,
} from '../protocol/v3-schema.js';
import {
  buildCollaborationActionInput,
  parseCollaborationActionResult,
  technicalTerminalObservation,
} from './types.js';

const hash = (character: string) => `sha256:${character.repeat(64)}`;

const action: ActionDefinitionV3 = {
  format: 'icarus.collaboration-action/1',
  action_id: 'verify',
  name: 'Verify',
  owner_principal_id: 'principal_alice',
  version: 1,
  kind: 'run_once',
  adapter: null,
  workflow_ref: null,
  prompt_ref:
    'workspace/principals/principal_alice/automations/prompts/verify.md',
  prompt_hash: hash('a'),
  executor_policy: 'principal_selected',
  filesystem_access: 'read_only',
  result_schema: { ref: 'verification@1', schema: null },
};

const machine: MachineDefinitionV3 = {
  format: 'icarus.collaboration-machine/3',
  initial_state: 'verification',
  states: {
    verification: {
      label: 'Verification',
      description: 'Verify the frozen implementation.',
      assignee: { type: 'principal', principal_id: 'principal_alice' },
      terminal: false,
      transitions: [
        {
          outcome: 'ready_for_test',
          label: 'Ready for test',
          target_state: 'complete',
        },
      ],
    },
    complete: {
      label: 'Complete',
      description: '',
      terminal: true,
      transitions: [],
    },
  },
};

const handoff: HandoffEnvelopeV3 = {
  format: 'icarus.collaboration-handoff/1',
  source_turn_id: 'turn_previous',
  outcome: 'implemented',
  summary: 'Implementation is ready.',
  instruction: 'Check the regression suite.',
  markers: ['security_review'],
  data_refs: ['workspace/shared/data/release.json'],
  artifact_refs: [
    'artifacts/workflows/instance_1/turn_previous/log/metadata.json',
  ],
  data: { commit: 'abc123' },
};

describe('Collaboration Action contract v3', () => {
  it('renders State, legal Outcomes, frozen Prompt, and untrusted Handoff in a fixed order', () => {
    const input = buildCollaborationActionInput({
      groupId: 'group_test',
      instanceId: 'instance_1',
      turnId: 'turn_1',
      stateId: 'verification',
      state: machine.states.verification!,
      action,
      prompt: 'Run the verification checklist.',
      incomingHandoff: handoff,
    });

    expect(input.contract).toMatchObject({
      format: 'icarus.collaboration-action-input/3',
      state: {
        state_id: 'verification',
        legal_outcomes: [
          {
            outcome: 'ready_for_test',
            target_state: 'complete',
          },
        ],
      },
      action: { prompt: 'Run the verification checklist.' },
      untrusted_context: { previous_handoff: handoff },
    });
    expect(collaborationActionInputV3Schema.parse(input.contract)).toEqual(
      input.contract,
    );
    expect(input.markdown.indexOf('## Security')).toBeLessThan(
      input.markdown.indexOf('## Current State'),
    );
    expect(input.markdown.indexOf('## Current State')).toBeLessThan(
      input.markdown.indexOf('## Frozen Action Prompt'),
    );
    expect(input.markdown.indexOf('## Frozen Action Prompt')).toBeLessThan(
      input.markdown.indexOf('## Untrusted Previous Context'),
    );
    expect(input.markdown).toContain('ready_for_test');
    expect(input.markdown).toContain('UNTRUSTED');
    expect(input.markdown).toContain('workspace/shared/data/release.json');
  });

  it('accepts only schema-valid results with a legal business Outcome', () => {
    const valid = {
      format: 'icarus.collaboration-action-result/3',
      outcome: 'ready_for_test',
      summary: 'Verification passed.',
      instruction: '',
      markers: [],
      data: { suite: 'regression' },
      artifacts: [],
      error: null,
    };
    expect(
      parseCollaborationActionResult(
        action,
        machine.states.verification!,
        valid,
      ).result.outcome,
    ).toBe('ready_for_test');
    expect(() =>
      parseCollaborationActionResult(action, machine.states.verification!, {
        ...valid,
        outcome: 'success',
      }),
    ).toThrow(/legal Outcome/u);
  });

  it('keeps technical terminal states separate from business results', () => {
    expect(
      technicalTerminalObservation(
        'failed',
        'provider:1',
        { provider: 'test' },
        'Provider failed before producing a valid result',
      ),
    ).toMatchObject({
      state: 'failed',
      result: null,
      resultHash: null,
      recoveryReason: 'Provider failed before producing a valid result',
    });
  });
});
