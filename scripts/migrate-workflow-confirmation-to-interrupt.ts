import fs from 'fs';
import path from 'path';

const workflowDir = path.join(process.cwd(), 'container', 'workflow-definitions');
const cardDir = path.join(process.cwd(), 'container', 'cards');

interface MigrationIssue {
  file: string;
  path: string;
  message: string;
}

interface MigrationChange {
  file: string;
  path: string;
  message: string;
}

const issues: MigrationIssue[] = [];
const changes: MigrationChange[] = [];

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function noteChange(file: string, pathName: string, message: string): void {
  changes.push({ file, path: pathName, message });
}

function noteIssue(file: string, pathName: string, message: string): void {
  issues.push({ file, path: pathName, message });
}

function migrateState(
  file: string,
  pathName: string,
  state: Record<string, unknown>,
): void {
  if (state.type !== 'confirmation') return;

  const onApprove = state.on_approve;
  const onRevise = state.on_revise;
  if (!isObject(onApprove) && !isObject(onRevise)) {
    noteIssue(file, pathName, 'confirmation state has no on_approve/on_revise');
    return;
  }

  const cardRef = isObject(state.card) ? String(state.card.ref || '') : '';
  const credential = cardRef === 'testing_confirm' || pathName.endsWith('.testing_confirm');
  state.type = 'interrupt';
  state.kind = credential ? 'credential' : 'approval';
  state.title = typeof state.label === 'string' ? state.label : path.basename(pathName);
  state.allowed_channels = ['web', 'feishu', 'assistant'];

  if (credential) {
    state.allowed_actions = ['submit', 'skip'];
    state.resume_payload_schema = {
      schema: {
        type: 'object',
        properties: {
          access_token: { type: 'string', minLength: 1 },
          skipped: { type: 'boolean' },
        },
      },
    };
    const onResume: Record<string, unknown> = {};
    if (isObject(onRevise)) onResume.submit = onRevise;
    if (isObject(onApprove)) onResume.skip = onApprove;
    state.on_resume = onResume;
  } else {
    const allowed = ['approve'];
    if (isObject(onRevise)) allowed.push('revise');
    state.allowed_actions = allowed;
    state.resume_payload_schema = {
      schema: {
        type: 'object',
        properties: {
          revision_text: { type: 'string', minLength: 1 },
        },
      },
    };
    const onResume: Record<string, unknown> = {};
    if (isObject(onApprove)) onResume.approve = onApprove;
    if (isObject(onRevise)) onResume.revise = onRevise;
    state.on_resume = onResume;
  }

  delete state.on_approve;
  delete state.on_revise;
  noteChange(file, pathName, 'confirmation -> interrupt');
}

function migrateWorkflowDefinitions(): void {
  if (!fs.existsSync(workflowDir)) return;
  for (const fileName of fs.readdirSync(workflowDir).filter((file) => file.endsWith('.json'))) {
    const filePath = path.join(workflowDir, fileName);
    const json = readJson(filePath);
    if (!isObject(json) || !Array.isArray(json.versions)) continue;
    for (const [versionIndex, version] of json.versions.entries()) {
      if (!isObject(version) || !isObject(version.states)) continue;
      for (const [stateKey, state] of Object.entries(version.states)) {
        if (!isObject(state)) continue;
        migrateState(
          fileName,
          `versions[${versionIndex}].states.${stateKey}`,
          state,
        );
      }
    }
    writeJson(filePath, json);
  }
}

function migrateAction(
  file: string,
  pathName: string,
  action: Record<string, unknown>,
): void {
  const id = String(action.id || '');
  if (!id) {
    noteIssue(file, pathName, 'action id is required');
    return;
  }

  if (id === 'approve' || id === 'approve_dev') {
    action.id = 'approve';
    action.action_kind = 'interrupt_resume';
    action.resume_action = 'approve';
  } else if (id === 'request_revision') {
    action.id = 'revise';
    action.action_kind = 'interrupt_resume';
    action.resume_action = 'revise';
  } else if (id === 'submit_access_token') {
    action.id = 'submit';
    action.action_kind = 'interrupt_resume';
    action.resume_action = 'submit';
  } else if (id === 'skip') {
    action.action_kind = 'interrupt_resume';
    action.resume_action = 'skip';
  } else if (id === 'pause') {
    action.id = 'pause_workflow';
    action.action_kind = 'workflow_control';
    action.workflow_control_action = 'pause_workflow';
  } else if (id === 'cancel') {
    action.id = 'cancel_workflow';
    action.action_kind = 'workflow_control';
    action.workflow_control_action = 'cancel_workflow';
  } else if (!action.action_kind) {
    noteIssue(file, pathName, `unknown action "${id}"`);
    return;
  } else {
    return;
  }
  noteChange(file, pathName, `migrated action "${id}"`);
}

function migrateCards(): void {
  if (!fs.existsSync(cardDir)) return;
  for (const fileName of fs.readdirSync(cardDir).filter((file) => file.endsWith('.json'))) {
    const filePath = path.join(cardDir, fileName);
    const json = readJson(filePath);
    if (!isObject(json)) continue;
    for (const [cardKey, card] of Object.entries(json)) {
      if (!isObject(card)) continue;
      for (const [index, action] of ((card.actions as unknown[]) || []).entries()) {
        if (isObject(action)) migrateAction(fileName, `${cardKey}.actions[${index}]`, action);
      }
      const form = card.form;
      if (isObject(form) && isObject(form.submit_action)) {
        migrateAction(fileName, `${cardKey}.form.submit_action`, form.submit_action);
      }
      for (const [sectionIndex, section] of ((card.sections as unknown[]) || []).entries()) {
        if (!isObject(section)) continue;
        for (const [actionIndex, action] of ((section.actions as unknown[]) || []).entries()) {
          if (isObject(action)) {
            migrateAction(
              fileName,
              `${cardKey}.sections[${sectionIndex}].actions[${actionIndex}]`,
              action,
            );
          }
        }
      }
    }
    writeJson(filePath, json);
  }
}

migrateWorkflowDefinitions();
migrateCards();

for (const change of changes) {
  console.log(`[changed] ${change.file} ${change.path}: ${change.message}`);
}

if (issues.length > 0) {
  for (const issue of issues) {
    console.error(`[issue] ${issue.file} ${issue.path}: ${issue.message}`);
  }
  process.exit(1);
}

console.log(`Migration complete. ${changes.length} change(s).`);
