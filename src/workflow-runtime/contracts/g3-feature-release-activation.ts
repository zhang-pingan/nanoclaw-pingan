import { Ajv2020, type AnySchema } from 'ajv/dist/2020.js';

import {
  calculateRegistryResourceContentHash,
  compareAscii,
  registryResourceId,
  registryResourceKey,
} from './g3-registry-persistence.js';
import {
  G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA,
  G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA,
} from './g3-retention-executor-abi-preflight.js';
import {
  G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE,
  type G3RetentionExecutorAbiPreflightResult,
} from './g3-retention-executor-abi-preflight-types.js';
import {
  G39_ACTIVATION_ERROR_PRECEDENCE,
  G39_ACTIVATION_DISPOSITIONS,
  G39_FEATURE_RELEASE_ACTIVATION_FORMATS,
  G39_TERMINAL_DISPOSITIONS,
  type G39ActivationErrorCode,
  type G39ActivationFailure,
  type G39ExpectedPointer,
  type G39FeatureReleaseActivationReceipt,
  type G39FeatureReleaseActivationRequest,
  type G39FeatureReleaseActivationResult,
  type G39ObservedPointer,
  type G39TerminalResultReference,
} from './g3-feature-release-activation-types.js';
import { canonicalJson, domainSeparatedSha256 } from './hash.js';
import type {
  JsonObject,
  JsonValue,
  Sha256Hash,
  VersionedRef,
} from './types.js';

export const G39_REQUEST_DOMAIN =
  'icarus:workflow-feature-release-activation-request:1\n';
export const G39_DOMAIN_REQUEST_DOMAIN =
  'icarus:workflow-feature-release-activation-domain-request:1\n';
export const G39_RECEIPT_DOMAIN =
  'icarus:workflow-feature-release-activation-receipt:1\n';
export const G39_RESULT_DOMAIN =
  'icarus:workflow-feature-release-activation-result:1\n';
export const G39_INVOCATION_DOMAIN =
  'icarus:workflow-feature-release-activation-invocation:1\n';
export const G39_EVENT_DOMAIN =
  'icarus:workflow-feature-release-activation-event:1\n';
export const G39_COMMAND_ID_DOMAIN =
  'icarus:workflow-feature-release-activation-command-id:1\n';
export const G39_COMPATIBILITY_INPUT_VALUE_DOMAIN =
  'icarus:workflow-feature-release-activation-g3-6-input-value:1\n';
export const G39_COMPATIBILITY_RESULT_VALUE_DOMAIN =
  'icarus:workflow-feature-release-activation-g3-6-result-value:1\n';

export const G39_SCHEMA_REFS = {
  request: {
    id: 'icarus.workflow-feature-release-activation-request-schema',
    version: '1.0.0',
  },
  receipt: {
    id: 'icarus.workflow-feature-release-activation-receipt-schema',
    version: '1.0.0',
  },
  result: {
    id: 'icarus.workflow-feature-release-activation-result-schema',
    version: '1.0.0',
  },
  compatibility_input: {
    id: 'icarus.workflow-retention-executor-abi-preflight-input-schema',
    version: '1.0.0',
  },
  compatibility_result: {
    id: 'icarus.workflow-retention-executor-abi-preflight-result-schema',
    version: '1.0.0',
  },
} as const;

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
const HASH_PATTERN = '^sha256:[0-9a-f]{64}$';
const hashSchema: JsonObject = { type: 'string', pattern: HASH_PATTERN };
const nonEmptyString: JsonObject = { type: 'string', minLength: 1 };
const safeInteger: JsonObject = {
  type: 'integer',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};
const positiveInteger: JsonObject = {
  type: 'integer',
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
};

function object(
  required: string[],
  properties: Record<string, JsonValue>,
  extra: JsonObject = {},
): JsonObject {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties,
    ...extra,
  };
}

const g36Defs = structuredClone(
  G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA.$defs as JsonObject,
);
const g36InputCore = structuredClone(
  G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA,
) as JsonObject;
delete g36InputCore.$schema;
delete g36InputCore.$id;
delete g36InputCore.$defs;

const releaseIdentitySchema = object(['release_id', 'ref', 'hash'], {
  release_id: nonEmptyString,
  ref: { $ref: '#/$defs/versioned_ref' },
  hash: hashSchema,
});

const releaseClaimSchema = object(
  ['release_id', 'ref', 'hash', 'expected_lifecycle'],
  {
    release_id: nonEmptyString,
    ref: { $ref: '#/$defs/versioned_ref' },
    hash: hashSchema,
    expected_lifecycle: { enum: ['staged', 'active'] },
  },
);

const releaseResourceSchema = object(
  ['resource_type', 'ref', 'content_hash', 'role'],
  {
    resource_type: { type: 'string', minLength: 1 },
    ref: { $ref: '#/$defs/versioned_ref' },
    content_hash: hashSchema,
    role: { enum: ['closure_root', 'closure_member'] },
  },
);

const targetReleaseSchema = object(
  ['release_id', 'ref', 'hash', 'expected_lifecycle', 'resources'],
  {
    release_id: nonEmptyString,
    ref: { $ref: '#/$defs/versioned_ref' },
    hash: hashSchema,
    expected_lifecycle: { const: 'staged' },
    resources: {
      type: 'array',
      minItems: 1,
      items: releaseResourceSchema,
    },
  },
);

const retentionClaimSchema = object(
  [
    'handle_id',
    'handle_kind',
    'feature_release_id',
    'closure_ref',
    'closure_hash',
    'expected_status',
    'expected_row_version',
  ],
  {
    handle_id: nonEmptyString,
    handle_kind: { const: 'published' },
    feature_release_id: nonEmptyString,
    closure_ref: { $ref: '#/$defs/versioned_ref' },
    closure_hash: hashSchema,
    expected_status: { const: 'held' },
    expected_row_version: safeInteger,
  },
);

const absentPointerSchema = object(['state', 'row_version', 'release'], {
  state: { const: 'absent' },
  row_version: { type: 'null' },
  release: { type: 'null' },
});

const presentPointerSchema = object(['state', 'row_version', 'release'], {
  state: { const: 'present' },
  row_version: positiveInteger,
  release: releaseIdentitySchema,
});

const contractSchemasSchema = object(
  [
    'request',
    'receipt',
    'result',
    'compatibility_input',
    'compatibility_result',
  ],
  {
    request: { $ref: '#/$defs/exact_query' },
    receipt: { $ref: '#/$defs/exact_query' },
    result: { $ref: '#/$defs/exact_query' },
    compatibility_input: { $ref: '#/$defs/exact_query' },
    compatibility_result: { $ref: '#/$defs/exact_query' },
  },
);

export const G39_REQUEST_SCHEMA: JsonObject = {
  $schema: DRAFT_2020_12,
  ...object(
    [
      'format',
      'command_type',
      'idempotency_domain',
      'idempotency_key',
      'actor_ref',
      'auth_session_ref',
      'requested_at_ms',
      'feature_id',
      'target_release',
      'previous_release',
      'expected_pointer',
      'compatibility_preflight',
      'target_retention',
      'previous_retention',
      'contract_schemas',
      'domain_request_hash',
      'request_hash',
    ],
    {
      format: { const: G39_FEATURE_RELEASE_ACTIVATION_FORMATS.request },
      command_type: { const: 'activate_feature_release' },
      idempotency_domain: nonEmptyString,
      idempotency_key: nonEmptyString,
      actor_ref: nonEmptyString,
      auth_session_ref: nonEmptyString,
      requested_at_ms: safeInteger,
      feature_id: nonEmptyString,
      target_release: targetReleaseSchema,
      previous_release: {
        anyOf: [releaseClaimSchema, { type: 'null' }],
      },
      expected_pointer: {
        oneOf: [absentPointerSchema, presentPointerSchema],
      },
      compatibility_preflight: g36InputCore,
      target_retention: retentionClaimSchema,
      previous_retention: {
        anyOf: [retentionClaimSchema, { type: 'null' }],
      },
      contract_schemas: contractSchemasSchema,
      domain_request_hash: hashSchema,
      request_hash: hashSchema,
    },
  ),
  $defs: g36Defs,
};

const receiptCoreSchema = object(
  [
    'format',
    'command_id',
    'domain_request_hash',
    'feature_id',
    'target_release',
    'previous_release',
    'pointer',
    'target_lifecycle',
    'previous_lifecycle',
    'compatibility_result_hash',
    'target_retention',
    'previous_retention',
    'activated_at_ms',
    'active_pointer_changed',
    'receipt_hash',
  ],
  {
    format: { const: G39_FEATURE_RELEASE_ACTIVATION_FORMATS.receipt },
    command_id: nonEmptyString,
    domain_request_hash: hashSchema,
    feature_id: nonEmptyString,
    target_release: releaseIdentitySchema,
    previous_release: { anyOf: [releaseIdentitySchema, { type: 'null' }] },
    pointer: object(
      ['previous_state', 'previous_row_version', 'applied_row_version'],
      {
        previous_state: { enum: ['absent', 'present'] },
        previous_row_version: {
          anyOf: [positiveInteger, { type: 'null' }],
        },
        applied_row_version: positiveInteger,
      },
    ),
    target_lifecycle: { const: 'active' },
    previous_lifecycle: {
      anyOf: [{ const: 'draining' }, { type: 'null' }],
    },
    compatibility_result_hash: hashSchema,
    target_retention: retentionClaimSchema,
    previous_retention: {
      anyOf: [retentionClaimSchema, { type: 'null' }],
    },
    activated_at_ms: safeInteger,
    active_pointer_changed: { const: true },
    receipt_hash: hashSchema,
  },
);

export const G39_RECEIPT_SCHEMA: JsonObject = {
  $schema: DRAFT_2020_12,
  ...receiptCoreSchema,
  $defs: { versioned_ref: g36Defs.versioned_ref },
};

const terminalReferenceSchema = object(
  ['value_id', 'hash', 'schema_resource_id', 'schema_hash'],
  {
    value_id: nonEmptyString,
    hash: hashSchema,
    schema_resource_id: nonEmptyString,
    schema_hash: hashSchema,
  },
);

const failureSchema = object(['phase', 'code', 'nested_g3_6_code'], {
  phase: {
    enum: [
      'admission',
      'idempotency',
      'integrity',
      'preflight',
      'activation_transaction',
      'persistence',
    ],
  },
  code: { enum: [...G39_ACTIVATION_ERROR_PRECEDENCE] },
  nested_g3_6_code: {
    anyOf: [
      { enum: [...G3_RETENTION_EXECUTOR_ABI_ERROR_PRECEDENCE] },
      { type: 'null' },
    ],
  },
});

export const G39_RESULT_SCHEMA: JsonObject = {
  $schema: DRAFT_2020_12,
  ...object(
    [
      'format',
      'disposition',
      'code',
      'command_id',
      'invocation_no',
      'submitted_domain_request_hash',
      'bound_domain_request_hash',
      'terminal_disposition',
      'referenced_terminal_result',
      'receipt',
      'expected_pointer',
      'observed_pointer',
      'failure',
      'result_hash',
    ],
    {
      format: { const: G39_FEATURE_RELEASE_ACTIVATION_FORMATS.result },
      disposition: { enum: [...G39_ACTIVATION_DISPOSITIONS] },
      code: {
        enum: [
          'feature_release_activation_applied',
          'feature_release_activation_duplicate',
          ...G39_ACTIVATION_ERROR_PRECEDENCE,
        ],
      },
      command_id: nonEmptyString,
      invocation_no: positiveInteger,
      submitted_domain_request_hash: hashSchema,
      bound_domain_request_hash: hashSchema,
      terminal_disposition: {
        anyOf: [{ enum: [...G39_TERMINAL_DISPOSITIONS] }, { type: 'null' }],
      },
      referenced_terminal_result: {
        anyOf: [terminalReferenceSchema, { type: 'null' }],
      },
      receipt: { anyOf: [receiptCoreSchema, { type: 'null' }] },
      expected_pointer: {
        oneOf: [absentPointerSchema, presentPointerSchema],
      },
      observed_pointer: {
        anyOf: [absentPointerSchema, presentPointerSchema, { type: 'null' }],
      },
      failure: { anyOf: [failureSchema, { type: 'null' }] },
      result_hash: hashSchema,
    },
  ),
  $defs: { versioned_ref: g36Defs.versioned_ref },
};

function schemaResourceHash(ref: VersionedRef, schema: JsonObject): Sha256Hash {
  return calculateRegistryResourceContentHash({
    format: 'icarus.workflow-registry-resource/1',
    resource_type: 'schema',
    ref,
    content: schema,
  });
}

export const G39_SCHEMA_RESOURCE_HASHES = {
  request: schemaResourceHash(G39_SCHEMA_REFS.request, G39_REQUEST_SCHEMA),
  receipt: schemaResourceHash(G39_SCHEMA_REFS.receipt, G39_RECEIPT_SCHEMA),
  result: schemaResourceHash(G39_SCHEMA_REFS.result, G39_RESULT_SCHEMA),
  compatibility_input: schemaResourceHash(
    G39_SCHEMA_REFS.compatibility_input,
    G3_RETENTION_EXECUTOR_ABI_INPUT_SCHEMA,
  ),
  compatibility_result: schemaResourceHash(
    G39_SCHEMA_REFS.compatibility_result,
    G3_RETENTION_EXECUTOR_ABI_RESULT_SCHEMA,
  ),
} as const;

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
const validateRequestSchema = ajv.compile(G39_REQUEST_SCHEMA as AnySchema);
const validateReceiptSchema = ajv.compile(G39_RECEIPT_SCHEMA as AnySchema);
const validateResultSchema = ajv.compile(G39_RESULT_SCHEMA as AnySchema);

export class G39ActivationContractError extends Error {
  constructor(
    readonly code: G39ActivationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'G39ActivationContractError';
  }
}

function without<T extends JsonObject>(value: T, fields: string[]): JsonObject {
  const cloned = structuredClone(value) as JsonObject;
  for (const field of fields) delete cloned[field];
  return cloned;
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.version === right.version;
}

function releaseIdentity(claim: {
  release_id: string;
  ref: VersionedRef;
  hash: Sha256Hash;
}): JsonObject {
  return {
    release_id: claim.release_id,
    ref: claim.ref,
    hash: claim.hash,
  };
}

function schemaBindingMatches(
  request: G39FeatureReleaseActivationRequest,
  key: keyof typeof G39_SCHEMA_REFS,
): boolean {
  const query = request.contract_schemas[key];
  return (
    query.resource_type === 'schema' &&
    sameRef(query.ref, G39_SCHEMA_REFS[key]) &&
    query.content_hash === G39_SCHEMA_RESOURCE_HASHES[key] &&
    query.publication_state === 'published'
  );
}

function assertRequestSemantics(
  request: G39FeatureReleaseActivationRequest,
): void {
  if (
    !Object.keys(G39_SCHEMA_REFS).every((key) =>
      schemaBindingMatches(request, key as keyof typeof G39_SCHEMA_REFS),
    )
  ) {
    throw new G39ActivationContractError(
      'activation_request_schema_invalid',
      'Activation contract schema bindings must be the exact published G3.9 and G3.6 schema resources',
    );
  }

  const resources = request.target_release.resources;
  const keys = resources.map((entry) => registryResourceKey(entry));
  if (
    new Set(keys).size !== keys.length ||
    canonicalJson(keys) !==
      canonicalJson(
        [...keys].sort((left, right) => compareAscii(left, right)),
      ) ||
    resources.filter((entry) => entry.role === 'closure_root').length !== 1
  ) {
    throw new G39ActivationContractError(
      'activation_request_schema_invalid',
      'Target Release resources must be unique, ASCII ordered, and have one Closure root',
    );
  }

  const compatibility = request.compatibility_preflight;
  if (
    !sameRef(compatibility.feature_release_ref, request.target_release.ref) ||
    compatibility.feature_release_hash !== request.target_release.hash ||
    !sameRef(
      compatibility.retention.feature_release_ref,
      request.target_release.ref,
    ) ||
    compatibility.retention.feature_release_hash !==
      request.target_release.hash ||
    request.target_retention.feature_release_id !==
      request.target_release.release_id ||
    !sameRef(request.target_retention.closure_ref, compatibility.closure.ref) ||
    request.target_retention.closure_hash !== compatibility.closure.closure_hash
  ) {
    throw new G39ActivationContractError(
      'activation_request_schema_invalid',
      'Target Release, G3.6, and Retention claims must bind the same exact identities',
    );
  }
  const retentionKeys = compatibility.retention.members.map((entry) =>
    registryResourceKey(entry),
  );
  if (
    canonicalJson(keys) !== canonicalJson(retentionKeys) ||
    resources.some(
      (entry, index) =>
        entry.content_hash !==
        compatibility.retention.members[index].content_hash,
    )
  ) {
    throw new G39ActivationContractError(
      'activation_request_schema_invalid',
      'Target Release resources must equal the exact G3.6 Retention member set',
    );
  }

  if (request.expected_pointer.state === 'absent') {
    if (
      request.previous_release !== null ||
      request.previous_retention !== null
    ) {
      throw new G39ActivationContractError(
        'activation_request_schema_invalid',
        'Absent expected pointer forbids previous Release and Retention claims',
      );
    }
  } else {
    if (
      request.previous_release === null ||
      request.previous_retention === null ||
      request.previous_release.expected_lifecycle !== 'active' ||
      canonicalJson(releaseIdentity(request.previous_release)) !==
        canonicalJson(request.expected_pointer.release) ||
      request.previous_retention.feature_release_id !==
        request.previous_release.release_id ||
      request.previous_release.release_id === request.target_release.release_id
    ) {
      throw new G39ActivationContractError(
        'activation_request_schema_invalid',
        'Present expected pointer requires one distinct exact active previous Release and held Retention claim',
      );
    }
  }
}

export function calculateG39DomainRequestHash(
  request: G39FeatureReleaseActivationRequest,
): Sha256Hash {
  return domainSeparatedSha256(
    G39_DOMAIN_REQUEST_DOMAIN,
    without(request, ['domain_request_hash', 'request_hash']),
  );
}

export function calculateG39RequestHash(
  request: G39FeatureReleaseActivationRequest,
): Sha256Hash {
  return domainSeparatedSha256(
    G39_REQUEST_DOMAIN,
    without(request, ['request_hash']),
  );
}

export function calculateG39ReceiptHash(
  receipt: G39FeatureReleaseActivationReceipt,
): Sha256Hash {
  return domainSeparatedSha256(
    G39_RECEIPT_DOMAIN,
    without(receipt, ['receipt_hash']),
  );
}

export function calculateG39ResultHash(
  result: G39FeatureReleaseActivationResult,
): Sha256Hash {
  return domainSeparatedSha256(
    G39_RESULT_DOMAIN,
    without(result, ['result_hash']),
  );
}

export function calculateG39CompatibilityInputValueHash(
  input: G39FeatureReleaseActivationRequest['compatibility_preflight'],
): Sha256Hash {
  return domainSeparatedSha256(G39_COMPATIBILITY_INPUT_VALUE_DOMAIN, input);
}

export function calculateG39CompatibilityResultValueHash(
  result: G3RetentionExecutorAbiPreflightResult,
): Sha256Hash {
  return domainSeparatedSha256(G39_COMPATIBILITY_RESULT_VALUE_DOMAIN, result);
}

export function validateG39FeatureReleaseActivationRequest(
  candidate: unknown,
): asserts candidate is G39FeatureReleaseActivationRequest {
  if (!validateRequestSchema(candidate)) {
    const unknown = validateRequestSchema.errors?.some(
      (entry) => entry.keyword === 'additionalProperties',
    );
    throw new G39ActivationContractError(
      unknown
        ? 'activation_request_unknown_field'
        : 'activation_request_schema_invalid',
      ajv.errorsText(validateRequestSchema.errors),
    );
  }
  const request = candidate as G39FeatureReleaseActivationRequest;
  assertRequestSemantics(request);
  if (
    request.domain_request_hash !== calculateG39DomainRequestHash(request) ||
    request.request_hash !== calculateG39RequestHash(request)
  ) {
    throw new G39ActivationContractError(
      'activation_request_hash_mismatch',
      'Activation request or domain request hash mismatch',
    );
  }
}

export function validateG39FeatureReleaseActivationReceipt(
  candidate: unknown,
): asserts candidate is G39FeatureReleaseActivationReceipt {
  if (!validateReceiptSchema(candidate)) {
    throw new G39ActivationContractError(
      'terminal_integrity_mismatch',
      ajv.errorsText(validateReceiptSchema.errors),
    );
  }
  const receipt = candidate as G39FeatureReleaseActivationReceipt;
  if (
    receipt.receipt_hash !== calculateG39ReceiptHash(receipt) ||
    (receipt.pointer.previous_state === 'absent' &&
      (receipt.pointer.previous_row_version !== null ||
        receipt.previous_release !== null ||
        receipt.previous_retention !== null ||
        receipt.previous_lifecycle !== null ||
        receipt.pointer.applied_row_version !== 1)) ||
    (receipt.pointer.previous_state === 'present' &&
      (receipt.pointer.previous_row_version === null ||
        receipt.previous_release === null ||
        receipt.previous_retention === null ||
        receipt.previous_lifecycle !== 'draining' ||
        receipt.pointer.applied_row_version !==
          receipt.pointer.previous_row_version + 1))
  ) {
    throw new G39ActivationContractError(
      'terminal_integrity_mismatch',
      'Activation receipt hash or pointer transition binding mismatch',
    );
  }
}

export function validateG39FeatureReleaseActivationResult(
  candidate: unknown,
): asserts candidate is G39FeatureReleaseActivationResult {
  if (!validateResultSchema(candidate)) {
    throw new G39ActivationContractError(
      'terminal_integrity_mismatch',
      ajv.errorsText(validateResultSchema.errors),
    );
  }
  const result = candidate as G39FeatureReleaseActivationResult;
  if (result.result_hash !== calculateG39ResultHash(result)) {
    throw new G39ActivationContractError(
      'terminal_integrity_mismatch',
      'Activation result hash mismatch',
    );
  }
  const receiptAllowed =
    result.disposition === 'applied' ||
    (result.disposition === 'duplicate' &&
      result.terminal_disposition === 'applied');
  if (
    (receiptAllowed && result.receipt === null) ||
    (!receiptAllowed && result.receipt !== null) ||
    ((result.disposition === 'applied' || result.disposition === 'failed') &&
      result.referenced_terminal_result !== null) ||
    (result.disposition === 'duplicate' &&
      (result.referenced_terminal_result === null ||
        result.terminal_disposition === null ||
        result.submitted_domain_request_hash !==
          result.bound_domain_request_hash ||
        result.code !== 'feature_release_activation_duplicate' ||
        result.failure !== null ||
        result.observed_pointer !== null)) ||
    (result.disposition === 'applied' &&
      (result.terminal_disposition !== 'applied' ||
        result.code !== 'feature_release_activation_applied' ||
        result.failure !== null ||
        result.submitted_domain_request_hash !==
          result.bound_domain_request_hash ||
        canonicalJson(result.expected_pointer) !==
          canonicalJson(result.observed_pointer))) ||
    (result.disposition === 'failed' &&
      (result.terminal_disposition !== 'failed' ||
        result.failure === null ||
        result.code !== result.failure.code ||
        result.submitted_domain_request_hash !==
          result.bound_domain_request_hash ||
        result.observed_pointer !== null)) ||
    (result.disposition === 'conflict' &&
      (result.failure === null ||
        result.code !== result.failure.code ||
        (result.submitted_domain_request_hash ===
        result.bound_domain_request_hash
          ? result.terminal_disposition !== 'conflict' ||
            result.referenced_terminal_result !== null ||
            result.code !== 'pointer_cas_conflict' ||
            result.observed_pointer === null
          : result.code !== 'idempotency_conflict' ||
            result.receipt !== null ||
            result.observed_pointer !== null ||
            (result.terminal_disposition === null
              ? result.referenced_terminal_result !== null
              : result.referenced_terminal_result === null)))) ||
    (result.failure !== null &&
      (result.failure.code === 'g3_6_preflight_rejected') !==
        (result.failure.nested_g3_6_code !== null))
  ) {
    throw new G39ActivationContractError(
      'terminal_integrity_mismatch',
      'Activation result disposition, receipt, reference, or failure binding mismatch',
    );
  }
  if (result.receipt)
    validateG39FeatureReleaseActivationReceipt(result.receipt);
}

export function buildG39Receipt(
  candidate: Omit<G39FeatureReleaseActivationReceipt, 'receipt_hash'>,
): G39FeatureReleaseActivationReceipt {
  const receipt = {
    ...candidate,
    receipt_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  } as unknown as G39FeatureReleaseActivationReceipt;
  receipt.receipt_hash = calculateG39ReceiptHash(receipt);
  validateG39FeatureReleaseActivationReceipt(receipt);
  return receipt;
}

export function buildG39Result(
  candidate: Omit<G39FeatureReleaseActivationResult, 'result_hash'>,
): G39FeatureReleaseActivationResult {
  const result = {
    ...candidate,
    result_hash:
      'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  } as unknown as G39FeatureReleaseActivationResult;
  result.result_hash = calculateG39ResultHash(result);
  validateG39FeatureReleaseActivationResult(result);
  return result;
}

export function g39ActivationCommandId(
  idempotencyDomain: string,
  idempotencyKey: string,
): string {
  return `activation-command:${domainSeparatedSha256(G39_COMMAND_ID_DOMAIN, {
    idempotency_domain: idempotencyDomain,
    idempotency_key: idempotencyKey,
  })}`;
}

export function g39SchemaResourceId(
  request: G39FeatureReleaseActivationRequest,
  key: keyof G39FeatureReleaseActivationRequest['contract_schemas'],
): string {
  return registryResourceId(
    request.contract_schemas[
      key
    ] as G39FeatureReleaseActivationRequest['contract_schemas']['request'],
  );
}

export function g39ReleaseIdentity(
  request: G39FeatureReleaseActivationRequest,
  kind: 'target' | 'previous',
): JsonObject | null {
  const claim =
    kind === 'target' ? request.target_release : request.previous_release;
  return claim ? releaseIdentity(claim) : null;
}

export function g39Failure(
  phase: G39ActivationFailure['phase'],
  code: G39ActivationFailure['code'],
  nested: G39ActivationFailure['nested_g3_6_code'] = null,
): G39ActivationFailure {
  return { phase, code, nested_g3_6_code: nested };
}

export function g39TerminalReference(
  valueId: string,
  hash: Sha256Hash,
  schemaResourceId: string,
  schemaHash: Sha256Hash,
): G39TerminalResultReference {
  return {
    value_id: valueId,
    hash,
    schema_resource_id: schemaResourceId,
    schema_hash: schemaHash,
  };
}

export function g39ExpectedPointer(
  request: G39FeatureReleaseActivationRequest,
): G39ExpectedPointer {
  return structuredClone(request.expected_pointer);
}

export function g39ObservedPointer(
  candidate: G39ObservedPointer,
): G39ObservedPointer {
  return structuredClone(candidate);
}

export function g39SchemasForTest(): {
  request: JsonObject;
  receipt: JsonObject;
  result: JsonObject;
} {
  return {
    request: structuredClone(G39_REQUEST_SCHEMA),
    receipt: structuredClone(G39_RECEIPT_SCHEMA),
    result: structuredClone(G39_RESULT_SCHEMA),
  };
}

export const G39_UPSTREAM_IDENTITIES = {
  database_schema_version: 5,
  g1_root_hash:
    'sha256:f49781e161e00815e08841b2bc3b2b09ee83d60476220c398c9c0824ee4bcfa9',
  database_schema_hash:
    'sha256:adfcd0462b50991cceb9497412f8af4e0271f6769a9d810ff9e4d58011952cf1',
  schema5_migration_hash:
    'sha256:11e69e3d82c3963c3eac7d75be67ac16575e43685fdd8e5b392e97152f734e9b',
  schema3_to_4_upgrade_hash:
    'sha256:5ac263fe3279c61f74ba6314f5df98fff59a8f8b32acfa784d2040421ebaa3cf',
  schema4_to_5_upgrade_hash:
    'sha256:b443b201131cc1a26bd2401b784f7b4672c5f80828e6df31c23fb518c93e59e1',
  schema4_source_migration_hash:
    'sha256:4a8ddeb1f9715399ad96c3bc32efa5e8032a3bd484eaed0159c6a24620c1be43',
  g3_8a_pack_hash:
    'sha256:d8412111a0f3dcabb4ce416b99086701ea3e3911ff431b5457eb957b2f69722f',
  g3_8a_repair_artifact_hash:
    'sha256:94cb2c390bb44298238b1ffac4184b04f59efbbeae6f268fbce7618104ec406b',
  g3_8a_internal_contract_hash:
    'sha256:70d4b9ef47c83711415636737292450538acaf5cc4547d3130b04b101e6707ae',
  g3_6_pack_hash:
    'sha256:03131d78800718ac1bd326f932e33ca677d9ac617ff00fc090fc7aaefedd85a9',
  g3_7_pack_hash:
    'sha256:8a67b2516d46da89524045297b261e32305d0803546089048b19d70384e23282',
  g2_sealed_bundle_hash:
    'sha256:d99647d8ca6aabc737a793019335e6770aa111a79be7545c4dec00c6e7af2145',
} as const;
