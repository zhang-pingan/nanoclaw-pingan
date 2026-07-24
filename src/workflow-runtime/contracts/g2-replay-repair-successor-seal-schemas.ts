import {
  CURRENT_G2_GOLDEN_CONFORMANCE_BUNDLE_SCHEMA,
  CURRENT_G2_GOLDEN_SEALED_INVENTORY_SCHEMA,
  CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_SCHEMA,
} from './current-g2-golden-seal-schemas.js';
import type { JsonObject } from './types.js';

function clone(value: JsonObject): JsonObject {
  return structuredClone(value);
}

function object(value: unknown, label: string): JsonObject {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`Expected schema object: ${label}`);
  }
  return value as JsonObject;
}

function properties(schema: JsonObject): JsonObject {
  return object(schema.properties, 'properties');
}

function property(schema: JsonObject, name: string): JsonObject {
  return object(properties(schema)[name], name);
}

const semanticReview = clone(CURRENT_G2_GOLDEN_SEMANTIC_REVIEW_SCHEMA);
semanticReview.$id =
  'https://icarus.local/schemas/g2-replay-repair-successor-semantic-review-v2';
property(semanticReview, 'bundle_version').const = '2.0.0';
property(semanticReview, 'checklist_version').const =
  'g2-replay-repair-successor-semantic-review/2';
const comparison = property(semanticReview, 'comparison_acknowledgement');
property(comparison, 'byte_equal_count').const = 40;
property(comparison, 'semantic_equal_count').const = 40;
property(comparison, 'compiled_difference_case_count').const = 0;
property(comparison, 'pointer_difference_count').const = 0;
property(comparison, 'semantic_assertion_count').const = 95;

const inventory = clone(CURRENT_G2_GOLDEN_SEALED_INVENTORY_SCHEMA);
inventory.$id =
  'https://icarus.local/schemas/g2-replay-repair-successor-conformance-inventory-v2';
property(inventory, 'bundle_version').const = '2.0.0';

const bundle = clone(CURRENT_G2_GOLDEN_CONFORMANCE_BUNDLE_SCHEMA);
bundle.$id =
  'https://icarus.local/schemas/g2-replay-repair-successor-conformance-bundle-v2';
property(bundle, 'bundle_version').const = '2.0.0';

export const G2_REPLAY_REPAIR_SEMANTIC_REVIEW_SCHEMA = semanticReview;
export const G2_REPLAY_REPAIR_SEALED_INVENTORY_SCHEMA = inventory;
export const G2_REPLAY_REPAIR_CONFORMANCE_BUNDLE_SCHEMA = bundle;
