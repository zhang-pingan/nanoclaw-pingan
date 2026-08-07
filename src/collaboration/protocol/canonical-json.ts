import { canonicalize } from 'json-canonicalize';

import {
  assertJsonValue,
  strictParseJson,
  strictParseJsonBytes,
} from '../../workflow-runtime/contracts/strict-json.js';

export { strictParseJson, strictParseJsonBytes };

export function canonicalJsonStringify(
  value: unknown,
  space?: string | number,
): string {
  assertJsonValue(value);
  if (space !== undefined) return `${JSON.stringify(value, null, space)}\n`;
  return canonicalize(value);
}

export function prettyCollaborationJson(value: unknown): string {
  assertJsonValue(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}
