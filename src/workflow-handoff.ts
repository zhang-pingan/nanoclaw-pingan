import type { Delegation, Workflow } from './types.js';
import type { WorkflowDefinitionHandoff } from './workflow-definition.js';

export interface WorkflowHandoffContract {
  version: 1;
  input_schema: string;
  output_schema: string;
  artifact_contract_ref?: string;
  success_criteria: string[];
  failure_taxonomy: string[];
  auto_retry: {
    enabled: boolean;
    max_attempts: number;
    retryable_failures: string[];
  };
}

export interface WorkflowHandoffInput {
  workflow_id: string;
  workflow_type: string;
  stage_key: string;
  role: string;
  skill: string;
  service: string;
  name: string;
  round: number;
  context: Record<string, unknown>;
  rendered_task: string;
}

export interface WorkflowHandoffEnvelope {
  role: string;
  skill: string;
  contract: WorkflowHandoffContract;
  input: WorkflowHandoffInput;
}

export interface WorkflowHandoffResultValidation {
  status: 'valid' | 'invalid' | 'not_json';
  payload: Record<string, unknown> | null;
  errors: string[];
}

const CORE_FAILURE_TAXONOMY = [
  'model_api_error',
  'model_output_invalid',
  'tool_error',
  'tool_contract_error',
  'sandbox_error',
  'container_runtime_error',
  'timeout',
  'routing_error',
  'state_transition_error',
  'workflow_transition_error',
  'evaluation_failed',
  'invalid_input',
  'invalid_config',
  'permission_error',
  'db_error',
  'unknown_error',
];

function uniqueStrings(values: unknown[] | undefined): string[] {
  return Array.from(
    new Set(
      (values || [])
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function defaultSuccessCriteria(skill: string): string[] {
  if (/deploy|ops/i.test(skill)) {
    return [
      '部署动作完成并记录目标环境',
      '返回分支元数据和部署 verdict',
      '提供可追踪的部署或验证证据',
    ];
  }
  if (/test/i.test(skill)) {
    return [
      '测试执行完成或明确说明阻塞原因',
      '返回测试计数和业务 verdict',
      '提供测试文档或验证证据',
    ];
  }
  if (/examine|review/i.test(skill)) {
    return [
      '复核目标文档或实现',
      '返回明确 verdict',
      '提供 findings 和 evidence',
    ];
  }
  if (/plan/i.test(skill)) {
    return [
      '方案文档写入指定交付目录',
      '返回交付目录和分支元数据',
      '提供方案 verdict 与证据',
    ];
  }
  return [
    '任务执行完成或明确说明阻塞原因',
    '返回结构化 verdict、summary、findings、evidence',
    '产物满足对应 artifact contract',
  ];
}

export function buildWorkflowHandoffEnvelope(input: {
  workflow: Workflow;
  stageKey: string;
  role: string;
  skill: string;
  taskContent: string;
  handoff?: WorkflowDefinitionHandoff;
  artifactContractRef?: string;
  evaluatorArtifactContractRef?: string;
}): WorkflowHandoffEnvelope {
  const fallbackContractRef =
    input.artifactContractRef || input.evaluatorArtifactContractRef;
  const configured = input.handoff || {};
  const outputSchema =
    configured.output_schema ||
    configured.artifact_contract_ref ||
    fallbackContractRef ||
    `workflow.${input.stageKey}.output.v1`;
  const artifactContractRef =
    configured.artifact_contract_ref || fallbackContractRef || undefined;

  return {
    role: input.role,
    skill: input.skill,
    contract: {
      version: 1,
      input_schema:
        configured.input_schema || `workflow.${input.stageKey}.input.v1`,
      output_schema: outputSchema,
      ...(artifactContractRef
        ? { artifact_contract_ref: artifactContractRef }
        : {}),
      success_criteria: uniqueStrings(configured.success_criteria) || [],
      failure_taxonomy: uniqueStrings(configured.failure_taxonomy) || [],
      auto_retry: {
        enabled: configured.auto_retry?.enabled ?? false,
        max_attempts: configured.auto_retry?.max_attempts ?? 0,
        retryable_failures: uniqueStrings(
          configured.auto_retry?.retryable_failures,
        ),
      },
    },
    input: {
      workflow_id: input.workflow.id,
      workflow_type: input.workflow.workflow_type,
      stage_key: input.stageKey,
      role: input.role,
      skill: input.skill,
      service: input.workflow.service,
      name: input.workflow.name,
      round: input.workflow.round,
      context: input.workflow.context,
      rendered_task: input.taskContent,
    },
  };
}

export function normalizeWorkflowHandoffEnvelope(
  envelope: WorkflowHandoffEnvelope,
): WorkflowHandoffEnvelope {
  return {
    ...envelope,
    contract: {
      ...envelope.contract,
      success_criteria:
        envelope.contract.success_criteria.length > 0
          ? envelope.contract.success_criteria
          : defaultSuccessCriteria(envelope.skill),
      failure_taxonomy:
        envelope.contract.failure_taxonomy.length > 0
          ? envelope.contract.failure_taxonomy
          : CORE_FAILURE_TAXONOMY,
    },
  };
}

export function parseDelegationHandoffResult(
  delegation: Delegation | null | undefined,
): Record<string, unknown> | null {
  if (!delegation?.handoff_result_json) return null;
  try {
    const parsed = JSON.parse(delegation.handoff_result_json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function validateWorkflowHandoffResult(
  rawResult: string,
  delegation?: Delegation | null,
): WorkflowHandoffResultValidation {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawResult);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        status: 'not_json',
        payload: null,
        errors: ['result must be a JSON object'],
      };
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return {
      status: 'not_json',
      payload: null,
      errors: ['result must be valid JSON'],
    };
  }

  const errors: string[] = [];
  for (const key of ['verdict', 'summary', 'findings', 'evidence']) {
    if (payload[key] === undefined) errors.push(`${key} is required`);
  }
  if (
    payload.verdict !== undefined &&
    !['passed', 'failed', 'needs_revision', 'pending'].includes(
      String(payload.verdict),
    )
  ) {
    errors.push(
      'verdict must be one of passed, failed, needs_revision, pending',
    );
  }
  if (payload.summary !== undefined && typeof payload.summary !== 'string') {
    errors.push('summary must be a string');
  }
  if (payload.findings !== undefined && !Array.isArray(payload.findings)) {
    errors.push('findings must be an array');
  }
  if (payload.evidence !== undefined && !Array.isArray(payload.evidence)) {
    errors.push('evidence must be an array');
  }

  const contract = parseHandoffContract(delegation);
  const schemaRef = contract?.artifact_contract_ref || contract?.output_schema;
  if (schemaRef && schemaRef.includes('.testing.')) {
    for (const key of ['total', 'passed', 'failed', 'blocked']) {
      if (typeof payload[key] !== 'number')
        errors.push(`${key} must be a number`);
    }
  }

  return {
    status: errors.length > 0 ? 'invalid' : 'valid',
    payload,
    errors,
  };
}

function parseHandoffContract(
  delegation: Delegation | null | undefined,
): WorkflowHandoffContract | null {
  if (!delegation?.handoff_contract_json) return null;
  try {
    const parsed = JSON.parse(delegation.handoff_contract_json);
    return parsed && typeof parsed === 'object'
      ? (parsed as WorkflowHandoffContract)
      : null;
  } catch {
    return null;
  }
}
