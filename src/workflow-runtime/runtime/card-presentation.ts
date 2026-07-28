import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import { CLOSED_SCHEMA_DESCRIPTORS } from '../contracts/closed-schema-artifacts.js';
import type { CardPresentationDocument } from '../contracts/closed-schema-types.js';
import { canonicalJson } from '../contracts/hash.js';
import { RUNTIME_COMMAND_PROTOCOL_ENTRIES } from '../contracts/protocol-table-types.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from '../contracts/types.js';
import type { WorkflowRuntimeStore } from '../store/runtime-store/index.js';
import {
  G5RuntimeError,
  assertExactPublishedRegistryResource,
  insertInlineValue,
  loadInlineValue,
  runImmediateG5Transaction,
  runtimeObjectHash,
  stableRuntimeId,
} from './graph-store.js';
import type { AuthenticatedRuntimeCommandActor } from './commands.js';
import type {
  RuntimeRegistryRef,
  RuntimeValueRef,
} from '../contracts/g5-basic-runtime-types.js';

const cardDescriptor = CLOSED_SCHEMA_DESCRIPTORS.find(
  (descriptor) => descriptor.target_format === 'icarus.card-presentation/1',
)!;
const validateCardContract = new Ajv2020({
  strict: true,
  allErrors: true,
}).compile(cardDescriptor.schema as AnySchema);
const CREDENTIAL_REF_PATTERN =
  /^credential:[A-Za-z0-9][A-Za-z0-9._:/-]{0,510}$/;

export interface RenderCardPresentationInput {
  readonly contract: CardPresentationDocument;
  readonly presentationHash: Sha256Hash;
  readonly template: JsonObject;
  readonly templateHash: Sha256Hash;
  readonly variableSchema: JsonObject;
  readonly variableSchemaHash: Sha256Hash;
  readonly variables: JsonObject;
  readonly fallbackText: string;
  readonly channelAdapterRef: VersionedRef;
  readonly channelAdapterHash: Sha256Hash;
  readonly renderProfileRef: VersionedRef;
  readonly snapshotSchema: RuntimeRegistryRef;
  readonly workflowId: string;
  readonly graphRunId: string;
  readonly renderedAtMs: number;
}

export interface RenderedCardPresentation {
  readonly snapshot: RuntimeValueRef;
  readonly payload: JsonObject;
}

interface RenderedSnapshot extends JsonObject {
  readonly format: 'icarus.rendered-card-snapshot/1';
  readonly workflow_id: string;
  readonly graph_run_id: string;
  readonly presentation_ref: VersionedRef;
  readonly presentation_hash: Sha256Hash;
  readonly channel_adapter_ref: VersionedRef;
  readonly channel_adapter_hash: Sha256Hash;
  readonly render_profile_ref: VersionedRef;
  readonly rendered_at_ms: number;
  readonly variables_hash: Sha256Hash;
  readonly fallback_text: string;
  readonly content: JsonValue;
  readonly actions: JsonObject[];
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function assertNoSecretMaterial(value: JsonValue, pointer = ''): void {
  if (typeof value === 'string') {
    if (
      /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]+/i.test(
        value,
      )
    )
      throw new G5RuntimeError(
        'contract_invalid',
        `Card material contains secret bytes at ${pointer || '/'}`,
      );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((member, index) =>
      assertNoSecretMaterial(member, `${pointer}/${index}`),
    );
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, member] of Object.entries(value)) {
      if (/password|secret|token|cookie|private[_-]?key/i.test(key))
        throw new G5RuntimeError(
          'contract_invalid',
          `Card material contains a secret-bearing field at ${pointer}/${key}`,
        );
      assertNoSecretMaterial(member, `${pointer}/${key}`);
    }
  }
}

function resolveTemplate(value: JsonValue, variables: JsonObject): JsonValue {
  if (Array.isArray(value))
    return value.map((member) => resolveTemplate(member, variables));
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value);
  if (
    entries.length === 1 &&
    entries[0]![0] === 'variable' &&
    typeof entries[0]![1] === 'string'
  ) {
    const variable = entries[0]![1];
    if (!Object.prototype.hasOwnProperty.call(variables, variable))
      throw new G5RuntimeError(
        'contract_invalid',
        `Card template variable is unavailable: ${variable}`,
      );
    return variables[variable]!;
  }
  return Object.fromEntries(
    entries.map(([key, member]) => [key, resolveTemplate(member, variables)]),
  ) as JsonObject;
}

function stringBytes(value: JsonValue): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value))
    return value.reduce<number>(
      (total, member) => total + stringBytes(member),
      0,
    );
  if (value && typeof value === 'object')
    return Object.values(value).reduce<number>(
      (total, member) => total + stringBytes(member),
      0,
    );
  return 0;
}

function assertCardContract(input: RenderCardPresentationInput): void {
  if (!validateCardContract(input.contract))
    throw new G5RuntimeError(
      'contract_invalid',
      `CardPresentationContract is invalid: ${new Ajv2020().errorsText(
        validateCardContract.errors,
      )}`,
    );
  if (
    input.presentationHash !== input.contract.contract_hash ||
    input.templateHash !== input.contract.template_hash ||
    input.variableSchemaHash !== input.contract.variable_schema_hash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'Card presentation, template, or variable schema hash drifted',
    );
  const adapter = input.contract.supported_channel_adapters.find(
    (candidate) => {
      const document = candidate as {
        adapter_ref: VersionedRef;
        adapter_hash: Sha256Hash;
        render_profile_ref: VersionedRef;
      };
      return (
        sameRef(document.adapter_ref, input.channelAdapterRef) &&
        document.adapter_hash === input.channelAdapterHash &&
        sameRef(document.render_profile_ref, input.renderProfileRef)
      );
    },
  );
  if (!adapter)
    throw new G5RuntimeError(
      'contract_invalid',
      'Card channel adapter/render profile is not published by the presentation',
    );
  if (
    input.contract.actions.length >
    Number(input.contract.render_limits.max_actions)
  )
    throw new G5RuntimeError('contract_invalid', 'Card action limit exceeded');
  for (const action of input.contract.actions) {
    if (action.binding.action_kind !== 'runtime_command') continue;
    const binding = action.binding;
    const entry = RUNTIME_COMMAND_PROTOCOL_ENTRIES.find(
      (candidate) => candidate.command_type === binding.command_type,
    );
    if (!entry || entry.target_kind !== binding.target_binding)
      throw new G5RuntimeError(
        'contract_invalid',
        `Card runtime action target does not match ${binding.command_type}`,
      );
  }
}

export function renderCardPresentation(
  store: WorkflowRuntimeStore,
  input: RenderCardPresentationInput,
): RenderedCardPresentation {
  assertCardContract(input);
  const validateVariables = new Ajv2020({
    strict: true,
    allErrors: true,
  }).compile(input.variableSchema as AnySchema);
  if (!validateVariables(input.variables))
    throw new G5RuntimeError(
      'contract_invalid',
      `Card variables are invalid: ${new Ajv2020().errorsText(
        validateVariables.errors,
      )}`,
    );
  assertNoSecretMaterial(input.variables);
  const content = resolveTemplate(input.template, input.variables);
  const actions = input.contract.actions.map((action) => ({
    action_id: action.action_id,
    label: action.label,
    binding: action.binding,
    required_permission: action.required_permission,
    expires_at_ms: input.renderedAtMs + action.expires_after_ms,
  }));
  const snapshot: RenderedSnapshot = {
    format: 'icarus.rendered-card-snapshot/1',
    workflow_id: input.workflowId,
    graph_run_id: input.graphRunId,
    presentation_ref: input.contract.ref,
    presentation_hash: input.presentationHash,
    channel_adapter_ref: input.channelAdapterRef,
    channel_adapter_hash: input.channelAdapterHash,
    render_profile_ref: input.renderProfileRef,
    rendered_at_ms: input.renderedAtMs,
    variables_hash: runtimeObjectHash('card-variables', input.variables),
    fallback_text: input.fallbackText,
    content,
    actions,
  };
  const payload = {
    format: 'icarus.interactive-card/1',
    content,
    fallback_text: input.fallbackText,
    actions,
  };
  assertNoSecretMaterial(snapshot);
  const limits = input.contract.render_limits as {
    max_payload_bytes: number;
    max_text_bytes: number;
  };
  if (
    Buffer.byteLength(canonicalJson(payload), 'utf8') >
      limits.max_payload_bytes ||
    stringBytes(payload) > limits.max_text_bytes
  )
    throw new G5RuntimeError('contract_invalid', 'Card render limit exceeded');
  const snapshotHash = runtimeObjectHash('card-rendered-snapshot', snapshot);
  const snapshotId = stableRuntimeId('card-rendered-snapshot', {
    graph_run_id: input.graphRunId,
    presentation_hash: input.presentationHash,
    snapshot_hash: snapshotHash,
  });
  runImmediateG5Transaction(store, (transaction) => {
    assertExactPublishedRegistryResource(
      transaction,
      input.snapshotSchema,
      'Rendered Card snapshot schema',
    );
    insertInlineValue(transaction, {
      id: snapshotId,
      content: snapshot,
      contentHash: snapshotHash,
      provenanceRef: `card-presentation:${input.contract.ref.id}@${input.contract.ref.version}`,
      retentionClass: 'pinned',
      ownerGraphRunId: input.graphRunId,
      schemaResourceId: input.snapshotSchema.rowId,
      schemaResourceHash: input.snapshotSchema.hash,
      createdAtMs: input.renderedAtMs,
    });
    const run = transaction.queryOne<{ workflow_id: string }>(
      'SELECT workflow_id FROM workflow_graph_runs WHERE id = ?',
      [input.graphRunId],
    );
    if (!run || run.workflow_id !== input.workflowId)
      throw new G5RuntimeError(
        'precondition_failed',
        'Rendered Card Run/Workflow ownership is invalid',
      );
  });
  return { snapshot: { id: snapshotId, hash: snapshotHash }, payload };
}

export interface CardActionInvocation {
  readonly presentation_ref: VersionedRef;
  readonly presentation_hash: Sha256Hash;
  readonly rendered_snapshot_ref: string;
  readonly rendered_snapshot_hash: Sha256Hash;
  readonly action_id: string;
  readonly idempotency_key: string;
  readonly expected_target_row_version: number;
  readonly submitted_at_ms: number;
  readonly credential_ref: string | null;
}

export interface CardActionIngressInput {
  readonly contract: CardPresentationDocument;
  readonly invocation: CardActionInvocation;
  readonly actor: AuthenticatedRuntimeCommandActor;
  readonly nowMs: number;
}

export interface CardActionHandlerReceipt {
  readonly disposition:
    | 'applied'
    | 'duplicate'
    | 'conflict'
    | 'row_version_conflict';
  readonly result: JsonObject;
}

export interface CardActionHandlers {
  readonly waitSignal: (
    binding: Extract<
      CardPresentationDocument['actions'][number]['binding'],
      { action_kind: 'wait_signal' }
    >,
    input: CardActionIngressInput,
  ) => CardActionHandlerReceipt;
  readonly businessCommand: (
    binding: Extract<
      CardPresentationDocument['actions'][number]['binding'],
      { action_kind: 'business_command' }
    >,
    input: CardActionIngressInput,
  ) => CardActionHandlerReceipt;
  readonly runtimeCommand: (
    binding: Extract<
      CardPresentationDocument['actions'][number]['binding'],
      { action_kind: 'runtime_command' }
    >,
    input: CardActionIngressInput,
  ) => CardActionHandlerReceipt;
}

export interface CardActionIngressReceipt {
  readonly disposition:
    | CardActionHandlerReceipt['disposition']
    | 'action_expired';
  readonly requestHash: Sha256Hash;
  readonly result: JsonObject;
}

function assertCardInvocation(invocation: CardActionInvocation): void {
  const keys = [
    'presentation_ref',
    'presentation_hash',
    'rendered_snapshot_ref',
    'rendered_snapshot_hash',
    'action_id',
    'idempotency_key',
    'expected_target_row_version',
    'submitted_at_ms',
    'credential_ref',
  ];
  if (
    Object.keys(invocation).length !== keys.length ||
    Object.keys(invocation).some((key) => !keys.includes(key)) ||
    invocation.action_id.length === 0 ||
    invocation.idempotency_key.length === 0 ||
    invocation.idempotency_key.length > 512 ||
    !Number.isSafeInteger(invocation.expected_target_row_version) ||
    invocation.expected_target_row_version < 0 ||
    !Number.isSafeInteger(invocation.submitted_at_ms) ||
    invocation.submitted_at_ms < 0 ||
    (invocation.credential_ref !== null &&
      !CREDENTIAL_REF_PATTERN.test(invocation.credential_ref))
  )
    throw new G5RuntimeError(
      'contract_invalid',
      'CardActionInvocation is not a closed valid document',
    );
}

export function invokeCardAction(
  store: WorkflowRuntimeStore,
  input: CardActionIngressInput,
  handlers: CardActionHandlers,
): CardActionIngressReceipt {
  assertCardInvocation(input.invocation);
  if (!validateCardContract(input.contract))
    throw new G5RuntimeError(
      'contract_invalid',
      'CardPresentationContract is invalid',
    );
  if (
    !sameRef(input.invocation.presentation_ref, input.contract.ref) ||
    input.invocation.presentation_hash !== input.contract.contract_hash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'Card action presentation identity drifted',
    );
  if (
    !input.actor.authenticated ||
    input.actor.authSessionRef.length === 0 ||
    input.actor.entrypoint !== 'card_action'
  )
    throw new G5RuntimeError(
      'forbidden_surface',
      'Card action requires authenticated server-derived card context',
    );
  const snapshot = runImmediateG5Transaction(store, (transaction) => {
    const loaded = loadInlineValue(
      transaction,
      input.invocation.rendered_snapshot_ref,
      input.invocation.rendered_snapshot_hash,
      'Rendered Card snapshot',
    ) as RenderedSnapshot;
    const ownership = transaction.queryOne<{
      owner_graph_run_id: string | null;
      workflow_id: string | null;
    }>(
      `SELECT o.owner_graph_run_id, r.workflow_id
         FROM workflow_value_ownerships o
         LEFT JOIN workflow_graph_runs r ON r.id = o.owner_graph_run_id
        WHERE o.value_id = ?`,
      [input.invocation.rendered_snapshot_ref],
    );
    if (
      !ownership ||
      ownership.owner_graph_run_id !== loaded.graph_run_id ||
      ownership.workflow_id !== loaded.workflow_id
    )
      throw new G5RuntimeError(
        'integrity_violation',
        'Rendered Card snapshot ownership binding drifted',
      );
    return loaded;
  });
  if (
    runtimeObjectHash('card-rendered-snapshot', snapshot) !==
      input.invocation.rendered_snapshot_hash ||
    snapshot.format !== 'icarus.rendered-card-snapshot/1' ||
    !sameRef(snapshot.presentation_ref, input.contract.ref) ||
    snapshot.presentation_hash !== input.contract.contract_hash
  )
    throw new G5RuntimeError(
      'integrity_violation',
      'Rendered Card snapshot presentation binding drifted',
    );
  const action = input.contract.actions.find(
    (candidate) => candidate.action_id === input.invocation.action_id,
  );
  const renderedAction = snapshot.actions.find(
    (candidate) => candidate.action_id === input.invocation.action_id,
  );
  if (!action || !renderedAction)
    throw new G5RuntimeError(
      'contract_invalid',
      'Card action id is not published',
    );
  const expectedRenderedAction = {
    action_id: action.action_id,
    label: action.label,
    binding: action.binding,
    required_permission: action.required_permission,
    expires_at_ms: snapshot.rendered_at_ms + action.expires_after_ms,
  };
  if (canonicalJson(renderedAction) !== canonicalJson(expectedRenderedAction))
    throw new G5RuntimeError(
      'integrity_violation',
      'Rendered Card action binding drifted from the presentation contract',
    );
  if (!input.actor.permissions.has(action.required_permission as never))
    throw new G5RuntimeError(
      'forbidden_surface',
      'Card action permission denied',
    );
  const requestHash = runtimeObjectHash(
    'card-action-request',
    input.invocation as unknown as JsonObject,
  );
  if (
    typeof renderedAction.expires_at_ms !== 'number' ||
    input.nowMs > renderedAction.expires_at_ms
  )
    return {
      disposition: 'action_expired',
      requestHash,
      result: { execution_result: 'denied', denial_code: 'action_expired' },
    };
  const receipt =
    action.binding.action_kind === 'wait_signal'
      ? handlers.waitSignal(action.binding, input)
      : action.binding.action_kind === 'business_command'
        ? handlers.businessCommand(action.binding, input)
        : handlers.runtimeCommand(action.binding, input);
  return { ...receipt, requestHash };
}
