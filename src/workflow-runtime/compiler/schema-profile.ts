import fs from 'node:fs';
import path from 'node:path';

import { Ajv2020, type AnySchema, type ErrorObject } from 'ajv/dist/2020.js';

import { parseContractArtifactEnvelope } from '../contracts/artifact.js';
import type { CompilerConformanceDiagnosticV1 } from '../contracts/compiler-contract-repair-types.js';
import {
  assertJsonObject,
  strictParseJsonBytes,
} from '../contracts/strict-json.js';
import type { JsonObject, JsonValue } from '../contracts/types.js';
import type { WorkflowCompilerSourceKind } from './types.js';

const compilerRoot = import.meta.dirname;
const contractsRoot = path.resolve(compilerRoot, '../contracts');
const FORBIDDEN_SCHEMA_KEYWORDS = new Set([
  '$dynamicAnchor',
  '$dynamicRef',
  '$recursiveAnchor',
  '$recursiveRef',
  'allOf',
  'anyOf',
  'contains',
  'dependentRequired',
  'dependentSchemas',
  'if',
  'not',
  'oneOf',
  'patternProperties',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
const GRAPH_NODE_BRANCH_BY_TYPE = new Map([
  ['delegation', 0],
  ['system', 1],
  ['wait', 2],
  ['join', 3],
  ['subgraph', 4],
  ['expand', 5],
  ['map', 6],
  ['terminal', 7],
]);

function schemaPayload(relativePath: string): AnySchema {
  return parseContractArtifactEnvelope(
    strictParseJsonBytes(
      fs.readFileSync(path.join(contractsRoot, relativePath)),
    ),
  ).payload as AnySchema;
}

const ajv = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
const validateGraph = ajv.compile(
  schemaPayload('schemas/graph-scope-source-schema.json'),
);
const validateDefinition = ajv.compile(
  schemaPayload('schemas/workflow-definition-schema.json'),
);

function pointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function valueAtPointer(
  root: JsonValue,
  pointer: string,
): JsonValue | undefined {
  if (!pointer) return root;
  let current: JsonValue | undefined = root;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) current = current[Number(token)];
    else if (current && typeof current === 'object') current = current[token];
    else return undefined;
  }
  return current;
}

function schemaDiagnostic(
  source: JsonObject,
  error: ErrorObject,
): CompilerConformanceDiagnosticV1 {
  let instancePointer = error.instancePath;
  if (
    error.keyword === 'additionalProperties' &&
    typeof error.params.additionalProperty === 'string'
  ) {
    instancePointer += `/${pointerToken(error.params.additionalProperty)}`;
  }
  let stableObjectId: string | null = null;
  let cursor = error.instancePath;
  while (cursor.length > 0 && stableObjectId === null) {
    const value = valueAtPointer(source, cursor);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.id === 'string') stableObjectId = value.id;
    }
    cursor = cursor.slice(0, cursor.lastIndexOf('/'));
  }
  let schemaPointer = error.schemaPath;
  if (instancePointer.includes('/notify/')) {
    schemaPointer = '#/$defs/transition/properties/notify/additionalProperties';
  } else if (instancePointer.includes('/effects/operations/')) {
    schemaPointer = '#/$defs/transition_effect/additionalProperties';
  }
  return {
    code: 'schema_unknown_field',
    phase: 'schema',
    instance_pointer: instancePointer,
    schema_pointer: schemaPointer,
    stable_object_id: stableObjectId,
    detail_ref: null,
  };
}

function forbiddenKeyword(
  value: JsonValue,
  pointer = '',
): { keyword: string; pointer: string } | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = forbiddenKeyword(value[index], `${pointer}/${index}`);
      if (found) return found;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    const nextPointer = `${pointer}/${pointerToken(key)}`;
    if (FORBIDDEN_SCHEMA_KEYWORDS.has(key))
      return { keyword: key, pointer: nextPointer };
    const found = forbiddenKeyword(value[key], nextPointer);
    if (found) return found;
  }
  return null;
}

export function validateClosedSource(
  kind: WorkflowCompilerSourceKind,
  source: JsonObject,
): CompilerConformanceDiagnosticV1 | null {
  if (kind === 'workflow_schema') {
    const forbidden = forbiddenKeyword(source);
    if (forbidden) {
      return {
        code: 'schema_profile_keyword_unsupported',
        phase: 'schema',
        instance_pointer: forbidden.pointer,
        schema_pointer: '#/profile/forbiddenKeywords',
        stable_object_id: null,
        detail_ref: null,
      };
    }
    return null;
  }
  const validate = kind === 'graph_scope' ? validateGraph : validateDefinition;
  if (validate(source)) return null;
  const typedNodeAdditionalProperty = validate.errors?.find((error) => {
    if (error.keyword !== 'additionalProperties') return false;
    const node = valueAtPointer(source, error.instancePath);
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
    const branch = GRAPH_NODE_BRANCH_BY_TYPE.get(String(node.type));
    return (
      branch !== undefined &&
      error.schemaPath.endsWith(`/oneOf/${branch}/additionalProperties`)
    );
  });
  const additionalProperty =
    typedNodeAdditionalProperty ??
    validate.errors?.find((error) => error.keyword === 'additionalProperties');
  const error = additionalProperty ?? validate.errors?.[0];
  if (!error)
    throw new Error('Closed source validation failed without diagnostics');
  return schemaDiagnostic(source, error);
}

export function assertSourceObject(value: JsonValue): JsonObject {
  assertJsonObject(value);
  return value;
}
