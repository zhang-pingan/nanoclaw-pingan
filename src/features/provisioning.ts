import fs from 'fs';
import path from 'path';

import {
  getFeatureGroupBinding,
  getFeatureGroupBindingByFolder,
  getFeatureGroupBindingByJid,
  getRegisteredGroup,
  getRegisteredGroupByFolder,
  setFeatureGroupBinding,
  setRegisteredGroup,
} from '../db.js';
import { ASSISTANT_NAME, GROUPS_DIR } from '../config.js';
import { isValidGroupFolder } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  assertPathInsideFeature,
  FeatureManifest,
  FeatureRequiredGroup,
} from './manifest.js';

export function provisionFeatureGroups(input: {
  featureId: string;
  featureRoot: string;
  manifest: FeatureManifest;
}): void {
  for (const group of input.manifest.requiredGroups || []) {
    provisionFeatureGroup({
      featureId: input.featureId,
      featureRoot: input.featureRoot,
      group,
    });
  }
}

function provisionFeatureGroup(input: {
  featureId: string;
  featureRoot: string;
  group: FeatureRequiredGroup;
}): void {
  const { featureId, featureRoot, group } = input;
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(
      `Feature ${featureId} group ${group.key} has invalid folder "${group.folder}"`,
    );
  }

  const templatePath = assertPathInsideFeature(
    featureRoot,
    group.claudeMd,
    `requiredGroups.${group.key}.claudeMd`,
  );
  if (!fs.existsSync(templatePath)) {
    throw new Error(
      `Feature ${featureId} group ${group.key} CLAUDE.md template not found: ${templatePath}`,
    );
  }

  const existingBinding = getFeatureGroupBinding(featureId, group.key);
  const bindingByJid = getFeatureGroupBindingByJid(group.jid);
  const bindingByFolder = getFeatureGroupBindingByFolder(group.folder);

  if (
    bindingByJid &&
    (bindingByJid.feature_id !== featureId ||
      bindingByJid.group_key !== group.key)
  ) {
    throw new Error(
      `Feature ${featureId} group ${group.key} JID "${group.jid}" is already bound to ${bindingByJid.feature_id}/${bindingByJid.group_key}`,
    );
  }
  if (
    bindingByFolder &&
    (bindingByFolder.feature_id !== featureId ||
      bindingByFolder.group_key !== group.key)
  ) {
    throw new Error(
      `Feature ${featureId} group ${group.key} folder "${group.folder}" is already bound to ${bindingByFolder.feature_id}/${bindingByFolder.group_key}`,
    );
  }

  const existingByJid = getRegisteredGroup(group.jid);
  const existingByFolder = getRegisteredGroupByFolder(group.folder);
  if (!existingBinding) {
    if (existingByJid) {
      throw new Error(
        `Feature ${featureId} group ${group.key} JID "${group.jid}" already exists without feature binding`,
      );
    }
    if (existingByFolder) {
      throw new Error(
        `Feature ${featureId} group ${group.key} folder "${group.folder}" already exists without feature binding`,
      );
    }
  } else {
    if (
      existingBinding.group_jid !== group.jid ||
      existingBinding.group_folder !== group.folder
    ) {
      throw new Error(
        `Feature ${featureId} group ${group.key} binding changed from ${existingBinding.group_jid}/${existingBinding.group_folder} to ${group.jid}/${group.folder}`,
      );
    }
  }

  const now = new Date().toISOString();
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const claudeMdPath = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.copyFileSync(templatePath, claudeMdPath);
  }

  setRegisteredGroup(group.jid, {
    name: group.name,
    folder: group.folder,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: existingByJid?.added_at || now,
    requiresTrigger: group.requiresTrigger ?? false,
    description: group.description,
  });
  setFeatureGroupBinding({
    featureId,
    groupKey: group.key,
    groupJid: group.jid,
    groupFolder: group.folder,
  });

  logger.info(
    { featureId, groupKey: group.key, jid: group.jid, folder: group.folder },
    'Feature group provisioned',
  );
}
