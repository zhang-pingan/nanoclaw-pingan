import type {
  DefinitionStaticLoweringContractV1,
  WorkflowCompilerConformanceCaseResultV1,
} from './compiler-contract-repair-types.js';
import { domainSeparatedSha256 } from './hash.js';
import type { JsonObject, JsonValue, Sha256Hash } from './types.js';

export const COMPILED_PLAN_V2_DOMAIN_SEPARATOR =
  'icarus:workflow-graph-plan:2\n' as const;
export const CONDITION_PROGRAM_V2_DOMAIN_SEPARATOR =
  'icarus:workflow-condition-program:2\n' as const;
export const STATIC_CHILD_CLOSURE_MEMBER_DOMAIN_SEPARATOR =
  'icarus:workflow-static-child-plan-closure-member:1\n' as const;
export const STATIC_CHILD_CLOSURE_DOMAIN_SEPARATOR =
  'icarus:workflow-static-child-plan-closure:1\n' as const;
export const COMPILER_CASE_RESULT_DOMAIN_SEPARATOR =
  'icarus:workflow-compiler-conformance-case-result:1\n' as const;

export function calculateCompilerConformanceCaseResultHash(
  result: Omit<WorkflowCompilerConformanceCaseResultV1, 'result_hash'>,
): Sha256Hash {
  return domainSeparatedSha256(
    COMPILER_CASE_RESULT_DOMAIN_SEPARATOR,
    result as unknown as JsonValue,
  );
}

function withSemanticHash<T extends JsonObject>(
  payload: JsonObject,
  hashField: string,
  domainSeparator: string,
): T {
  return {
    ...payload,
    [hashField]: domainSeparatedSha256(domainSeparator, payload),
  } as T;
}

export function buildStaticLoweringContract(): DefinitionStaticLoweringContractV1 {
  return withSemanticHash<DefinitionStaticLoweringContractV1>(
    {
      format: 'icarus.workflow-definition-static-lowering-contract/1',
      applies_to_state_types: ['delegation', 'system'],
      normal_named_exits: ['success', 'failure'],
      capability_terminal_routes: [
        {
          terminal_status: 'succeeded',
          named_exit: 'success',
          transition_slot: 'on_complete.success',
        },
        {
          terminal_status: 'failed',
          named_exit: 'failure',
          transition_slot: 'on_complete.failure',
        },
      ],
      engine_error: {
        scope_outcome_kind: 'errored',
        named_exit: null,
        transition_slot: 'on_error',
      },
      local_graph_cancel: {
        scope_outcome_kind: 'cancelled',
        reason: 'local_graph',
        named_exit: null,
        transition_slot: 'on_local_cancel',
      },
      global_workflow_cancel: {
        scope_outcome_kind: 'cancelled',
        reason: 'workflow',
        named_exit: null,
        transition_slot: null,
        disposition: 'terminate_workflow_without_state_transition',
      },
    },
    'contract_hash',
    'icarus:workflow-definition-static-lowering-contract:1\n',
  );
}
