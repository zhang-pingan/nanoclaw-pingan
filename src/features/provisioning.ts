import fs from 'fs';
import path from 'path';

import {
  getFeatureAgentBinding,
  getFeatureAgentBindingByFolder,
  getFeatureAgentBindingByJid,
  getRegisteredAgent,
  getRegisteredAgentByFolder,
  setFeatureAgentBinding,
  setRegisteredAgent,
} from '../db.js';
import { ASSISTANT_NAME, AGENTS_DIR } from '../config.js';
import { isValidAgentFolder } from '../agent-folder.js';
import { logger } from '../logger.js';
import {
  assertPathInsideFeature,
  FeatureManifest,
  FeatureRequiredAgent,
} from './manifest.js';

export function provisionFeatureAgents(input: {
  featureId: string;
  featureRoot: string;
  manifest: FeatureManifest;
}): void {
  for (const agent of input.manifest.requiredAgents || []) {
    provisionFeatureAgent({
      featureId: input.featureId,
      featureRoot: input.featureRoot,
      agent,
    });
  }
}

function provisionFeatureAgent(input: {
  featureId: string;
  featureRoot: string;
  agent: FeatureRequiredAgent;
}): void {
  const { featureId, featureRoot, agent } = input;
  if (!isValidAgentFolder(agent.folder)) {
    throw new Error(
      `Feature ${featureId} agent ${agent.key} has invalid folder "${agent.folder}"`,
    );
  }

  const templatePath = assertPathInsideFeature(
    featureRoot,
    agent.claudeMd,
    `requiredAgents.${agent.key}.claudeMd`,
  );
  if (!fs.existsSync(templatePath)) {
    throw new Error(
      `Feature ${featureId} agent ${agent.key} CLAUDE.md template not found: ${templatePath}`,
    );
  }

  const existingBinding = getFeatureAgentBinding(featureId, agent.key);
  const bindingByJid = getFeatureAgentBindingByJid(agent.jid);
  const bindingByFolder = getFeatureAgentBindingByFolder(agent.folder);

  if (
    bindingByJid &&
    (bindingByJid.feature_id !== featureId ||
      bindingByJid.agent_key !== agent.key)
  ) {
    throw new Error(
      `Feature ${featureId} agent ${agent.key} JID "${agent.jid}" is already bound to ${bindingByJid.feature_id}/${bindingByJid.agent_key}`,
    );
  }
  if (
    bindingByFolder &&
    (bindingByFolder.feature_id !== featureId ||
      bindingByFolder.agent_key !== agent.key)
  ) {
    throw new Error(
      `Feature ${featureId} agent ${agent.key} folder "${agent.folder}" is already bound to ${bindingByFolder.feature_id}/${bindingByFolder.agent_key}`,
    );
  }

  const existingByJid = getRegisteredAgent(agent.jid);
  const existingByFolder = getRegisteredAgentByFolder(agent.folder);
  if (!existingBinding) {
    if (existingByJid) {
      throw new Error(
        `Feature ${featureId} agent ${agent.key} JID "${agent.jid}" already exists without feature binding`,
      );
    }
    if (existingByFolder) {
      throw new Error(
        `Feature ${featureId} agent ${agent.key} folder "${agent.folder}" already exists without feature binding`,
      );
    }
  } else {
    if (
      existingBinding.agent_jid !== agent.jid ||
      existingBinding.agent_folder !== agent.folder
    ) {
      throw new Error(
        `Feature ${featureId} agent ${agent.key} binding changed from ${existingBinding.agent_jid}/${existingBinding.agent_folder} to ${agent.jid}/${agent.folder}`,
      );
    }
  }

  const now = new Date().toISOString();
  const agentDir = path.join(AGENTS_DIR, agent.folder);
  fs.mkdirSync(path.join(agentDir, 'logs'), { recursive: true });

  const claudeMdPath = path.join(agentDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    fs.copyFileSync(templatePath, claudeMdPath);
  }

  setRegisteredAgent(agent.jid, {
    name: agent.name,
    folder: agent.folder,
    trigger: `@${ASSISTANT_NAME}`,
    added_at: existingByJid?.added_at || now,
    requiresTrigger: agent.requiresTrigger ?? false,
    description: agent.description,
  });
  setFeatureAgentBinding({
    featureId,
    agentKey: agent.key,
    agentJid: agent.jid,
    agentFolder: agent.folder,
  });

  logger.info(
    { featureId, agentKey: agent.key, jid: agent.jid, folder: agent.folder },
    'Feature agent provisioned',
  );
}
