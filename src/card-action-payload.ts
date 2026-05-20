export const CARD_ACTION_RESERVED_FIELDS = new Set([
  'action',
  'workbench_action',
  'task_id',
  'action_item_id',
  'item_id',
  'group_id',
  'workflow_id',
  'interrupt_id',
  'resume_action',
  'resume_payload_schema',
  'group_folder',
  'source_type',
  'source_ref_id',
  'request_id',
  'question_id',
  'answer',
  'reply_text',
  'payload',
]);

export function parseNestedCardPayload(
  formValue: Record<string, string> | undefined,
): Record<string, unknown> | undefined {
  const raw = formValue?.payload;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function parseNestedCardStringPayload(
  formValue: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const parsed = parseNestedCardPayload(formValue);
  if (!parsed) return undefined;
  return Object.fromEntries(
    Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export function flatCardFormValues(
  formValue: Record<string, string> | undefined,
  reservedFields: Iterable<string> = CARD_ACTION_RESERVED_FIELDS,
): Record<string, string> {
  if (!formValue) return {};
  const reserved = new Set(reservedFields);
  return Object.fromEntries(
    Object.entries(formValue).filter(([key]) => !reserved.has(key)),
  );
}

export function buildCardActionPayload(
  formValue: Record<string, string> | undefined,
  reservedFields?: Iterable<string>,
): Record<string, unknown> {
  return (
    parseNestedCardPayload(formValue) ||
    flatCardFormValues(formValue, reservedFields)
  );
}

export function buildCardStringFormValues(
  formValue: Record<string, string> | undefined,
  reservedFields?: Iterable<string>,
): Record<string, string> | undefined {
  if (!formValue) return undefined;
  return (
    parseNestedCardStringPayload(formValue) ||
    flatCardFormValues(formValue, reservedFields)
  );
}
