/**
 * Step: register — Write channel registration config, create Agent folders.
 *
 * Requires --channel to identify one of the built-in messaging channels.
 * Uses parameterized SQL queries to prevent injection.
 */
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../src/config.ts';
import { initDatabase, setRegisteredAgent } from '../src/db.ts';
import { isValidAgentFolder } from '../src/agent-folder.ts';
import { logger } from '../src/logger.ts';
import { emitStatus } from './status.ts';

interface RegisterArgs {
  jid: string;
  name: string;
  trigger: string;
  folder: string;
  channel: string;
  requiresTrigger: boolean;
  isMain: boolean;
  assistantName: string;
}

export const BUILT_IN_CHANNELS = [
  'assistant',
  'feishu',
  'wecom',
  'web',
] as const;

type BuiltInChannel = (typeof BUILT_IN_CHANNELS)[number];

export type RegistrationChannelError =
  | 'missing_channel'
  | 'invalid_channel'
  | 'jid_channel_mismatch';

export function isJidForBuiltInChannel(
  channel: BuiltInChannel,
  jid: string,
): boolean {
  switch (channel) {
    case 'assistant':
      return jid.startsWith('assistant:');
    case 'feishu':
      return /^feishu:o[uc]_/.test(jid);
    case 'wecom':
      return jid.startsWith('wecom:user:');
    case 'web':
      return jid.startsWith('web:');
  }
}

export function validateRegistrationChannel(
  channel: string,
  jid: string,
): RegistrationChannelError | null {
  if (!channel) return 'missing_channel';
  if (!BUILT_IN_CHANNELS.includes(channel as BuiltInChannel)) {
    return 'invalid_channel';
  }
  if (!isJidForBuiltInChannel(channel as BuiltInChannel, jid)) {
    return 'jid_channel_mismatch';
  }
  return null;
}

export function parseArgs(args: string[]): RegisterArgs {
  const result: RegisterArgs = {
    jid: '',
    name: '',
    trigger: '',
    folder: '',
    channel: '',
    requiresTrigger: true,
    isMain: false,
    assistantName: 'Andy',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--jid':
        result.jid = args[++i] || '';
        break;
      case '--name':
        result.name = args[++i] || '';
        break;
      case '--trigger':
        result.trigger = args[++i] || '';
        break;
      case '--folder':
        result.folder = args[++i] || '';
        break;
      case '--channel':
        result.channel = (args[++i] || '').toLowerCase();
        break;
      case '--no-trigger-required':
        result.requiresTrigger = false;
        break;
      case '--is-main':
        result.isMain = true;
        break;
      case '--assistant-name':
        result.assistantName = args[++i] || 'Andy';
        break;
    }
  }

  return result;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseArgs(args);

  if (
    !parsed.jid ||
    !parsed.name ||
    !parsed.trigger ||
    !parsed.folder ||
    !parsed.channel
  ) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'missing_required_args',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  const channelError = validateRegistrationChannel(parsed.channel, parsed.jid);
  if (channelError) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: channelError,
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  if (!isValidAgentFolder(parsed.folder)) {
    emitStatus('REGISTER_CHANNEL', {
      STATUS: 'failed',
      ERROR: 'invalid_folder',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  logger.info(parsed, 'Registering channel');

  // Ensure data and store directories exist on fresh installations.
  fs.mkdirSync(path.join(projectRoot, 'data'), { recursive: true });
  fs.mkdirSync(STORE_DIR, { recursive: true });

  // Initialize database (creates schema + runs migrations)
  initDatabase();

  setRegisteredAgent(parsed.jid, {
    name: parsed.name,
    folder: parsed.folder,
    trigger: parsed.trigger,
    added_at: new Date().toISOString(),
    requiresTrigger: parsed.requiresTrigger,
    isMain: parsed.isMain,
  });

  logger.info('Wrote registration to SQLite');

  // Create Agent folders
  fs.mkdirSync(path.join(projectRoot, 'agents', parsed.folder, 'logs'), {
    recursive: true,
  });

  // Update assistant name in CLAUDE.md files if different from default
  let nameUpdated = false;
  if (parsed.assistantName !== 'Andy') {
    logger.info(
      { from: 'Andy', to: parsed.assistantName },
      'Updating assistant name',
    );

    const mdFiles = [
      path.join(projectRoot, 'agents', 'global', 'CLAUDE.md'),
      path.join(projectRoot, 'agents', parsed.folder, 'CLAUDE.md'),
    ];

    for (const mdFile of mdFiles) {
      if (fs.existsSync(mdFile)) {
        let content = fs.readFileSync(mdFile, 'utf-8');
        content = content.replace(/^# Andy$/m, `# ${parsed.assistantName}`);
        content = content.replace(
          /You are Andy/g,
          `You are ${parsed.assistantName}`,
        );
        fs.writeFileSync(mdFile, content);
        logger.info({ file: mdFile }, 'Updated CLAUDE.md');
      }
    }

    // Update .env
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      let envContent = fs.readFileSync(envFile, 'utf-8');
      if (envContent.includes('ASSISTANT_NAME=')) {
        envContent = envContent.replace(
          /^ASSISTANT_NAME=.*$/m,
          `ASSISTANT_NAME="${parsed.assistantName}"`,
        );
      } else {
        envContent += `\nASSISTANT_NAME="${parsed.assistantName}"`;
      }
      fs.writeFileSync(envFile, envContent);
    } else {
      fs.writeFileSync(envFile, `ASSISTANT_NAME="${parsed.assistantName}"\n`);
    }
    logger.info('Set ASSISTANT_NAME in .env');
    nameUpdated = true;
  }

  emitStatus('REGISTER_CHANNEL', {
    JID: parsed.jid,
    NAME: parsed.name,
    FOLDER: parsed.folder,
    CHANNEL: parsed.channel,
    TRIGGER: parsed.trigger,
    REQUIRES_TRIGGER: parsed.requiresTrigger,
    ASSISTANT_NAME: parsed.assistantName,
    NAME_UPDATED: nameUpdated,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
