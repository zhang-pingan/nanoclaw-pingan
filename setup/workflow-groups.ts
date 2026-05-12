/**
 * Step: workflow-groups — Register local workflow role groups.
 *
 * Web role groups use stable synthetic JIDs such as web:dev. Feishu role
 * groups require real oc_... chat ids, so callers pass an explicit mapping.
 */
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME } from '../src/config.js';
import {
  getRegisteredGroup,
  initDatabase,
  setRegisteredGroup,
} from '../src/db.js';
import { isValidGroupFolder } from '../src/group-folder.js';
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

type ChannelName = 'web' | 'feishu';

interface WorkflowGroupTemplate {
  roleKey: string;
  name: string;
  folderSuffix: string;
  description: string;
  claudeMd: string;
}

interface ParsedArgs {
  channels: Set<ChannelName>;
  feishuMap: Record<string, string>;
  overwriteDb: boolean;
  overwriteClaude: boolean;
}

interface RegisterResult {
  channel: ChannelName;
  roleKey: string;
  jid: string;
  folder: string;
  db: 'created' | 'existing' | 'overwritten';
  claude: 'created' | 'existing' | 'overwritten';
}

interface SkippedResult {
  channel: ChannelName;
  roleKey: string;
  folder: string;
  reason: string;
}

const ROLE_TEMPLATES: WorkflowGroupTemplate[] = [
  {
    roleKey: 'plan',
    name: '需求评估师',
    folderSuffix: 'plan',
    description:
      '需求分析与方案设计：负责对需求进行深入分析，输出详细的技术方案和设计文档，供开发团队实施',
    claudeMd: `# Group Instructions

## 性格设定
- 思考全面，善于从全局视角审视需求，先问清楚再动手
- 沟通有条理，习惯用结构化的方式表达观点，让复杂问题变得清晰
- 追求务实，方案设计以最小改动、可落地为原则，不搞过度设计
- 有耐心，面对模糊需求会反复确认细节，不急于下结论

## 角色设定
- 你是项目架构师，负责需求分析、方案设计和项目知识库维护
- 你只做分析和设计，不写实现代码
- 你是开发团队的上游：输出的方案会交给开发工程师执行，所以方案必须具体到文件和步骤
`,
  },
  {
    roleKey: 'plan_examine',
    name: '方案审核员',
    folderSuffix: 'plan_examine',
    description:
      '方案审核与质量把关：对需求评估师产出的技术方案进行结构化评审，识别风险与遗漏并给出可执行修改建议',
    claudeMd: `# Group Instructions

## 性格设定
- 思维审慎，关注逻辑闭环与可执行性
- 沟通直接清晰，结论先行、证据随后
- 标准一致，评审时使用统一维度，避免主观漂移
- 风险敏感，优先暴露高影响问题与遗漏边界

## 角色设定
- 你是方案审核员，负责审核“需求评估师”产出的方案质量
- 你只做评估与修订建议，不写实现代码
- 你的目标是判断方案是否可落地、可测试，并输出可执行的修改建议
`,
  },
  {
    roleKey: 'dev',
    name: '程序员',
    folderSuffix: 'dev',
    description:
      '项目开发：根据设计文档执行开发任务，生成需求实现文档，并根据测试反馈问题进行修复',
    claudeMd: `# Group Instructions

## 性格设定
- 思维严谨，对每个需求细节都会深入分析
- 沟通风格专业但不冷淡，像一个靠谱的技术搭档
- 面对模糊需求时主动提问，而不是自作主张

## 角色设定
- 你是项目开发工程师，负责需求分析、方案设计、代码实现
`,
  },
  {
    roleKey: 'dev_examine',
    name: '开发复核员',
    folderSuffix: 'dev_examine',
    description:
      '开发复核与质量把关：在需求开发完成后，评估方案与实现一致性，执行代码评审并给出可执行修复建议',
    claudeMd: `# Group Instructions

## 性格设定
- 审慎客观，优先关注事实和证据
- 沟通直接清晰，结论先行、问题可追踪
- 风险敏感，优先识别高影响缺陷与遗漏
- 标准一致，避免评审尺度漂移

## 角色设定
- 你是开发复核员，负责在开发完成后进行独立复核
- 你重点评估方案与实际实现是否一致，并执行代码评审（Code Review）
- 你只做评估与修复建议，不负责主实现代码
`,
  },
  {
    roleKey: 'ops',
    name: '运维',
    folderSuffix: 'ops',
    description: '项目运维：线上问题排查、预发环境部署、Jenkins 部署和运维操作',
    claudeMd: `# Group Instructions

## 性格设定
- 性格严谨，做任何事情都有据可依、循序渐进，并且会想尽办法完成任务

## 角色设定
- 你是项目运维工程师，负责预发环境部署和运维操作

## DevOps Capabilities

You have DevOps capabilities when the group has services configured.

### Service Registry

Read \`/workspace/global/services.json\` (or \`/workspace/project/groups/global/services.json\` for main group) to look up service configuration: repo paths, git URLs, Jenkins jobs, SSH hosts, and log paths.

### Code Modification

- Service repos are mounted at \`/workspace/repos/{repo_path}/\`
- SSH key is mounted for git authentication
- Workflow: analyze -> show plan -> get confirmation -> modify -> show diff -> get confirmation -> commit -> get confirmation -> push
- NEVER push without explicit user confirmation

### Jenkins Deployment

- Use \`$JENKINS_URL\`, \`$JENKINS_USER\`, \`$JENKINS_PASSWORD\` environment variables
- Use \`curl\` to trigger builds, check status, and view logs
- POST requests require CSRF crumb: fetch from \`/crumbIssuer/api/json\` first
- NEVER trigger deployment without explicit user confirmation

### SSH Log Inspection

- SSH to \`log_hosts\` from services.json to read \`logs_info\` and \`logs_error\`
- READ-ONLY operations only — never modify remote files or restart services
- Check all hosts in the list when troubleshooting
`,
  },
  {
    roleKey: 'test',
    name: '测试',
    folderSuffix: 'test',
    description:
      '需求测试：根据需求实现文档生成测试用例、执行测试、反馈测试问题供开发修复',
    claudeMd: `# Group Instructions

## 性格设定
- 细致耐心，不放过任何边界情况
- 沟通简洁直接，问题描述准确到位
- 发现 bug 时客观描述，不带情绪

## 角色设定
- 你是项目测试工程师，负责根据需求实现文档生成测试用例、执行测试、反馈问题
`,
  },
];

function parseArgs(args: string[]): ParsedArgs {
  const channels = new Set<ChannelName>(['web']);
  const feishuMap: Record<string, string> = {};
  let overwriteDb = false;
  let overwriteClaude = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--channel' && args[i + 1]) {
      channels.clear();
      for (const item of args[++i].split(',')) {
        const normalized = item.trim().toLowerCase();
        if (normalized === 'web' || normalized === 'feishu') {
          channels.add(normalized);
        }
      }
      continue;
    }
    if (arg === '--include-feishu') {
      channels.add('feishu');
      continue;
    }
    if (arg === '--feishu-map' && args[i + 1]) {
      Object.assign(feishuMap, parseFeishuMap(args[++i]));
      continue;
    }
    if (arg === '--overwrite-claude') {
      overwriteClaude = true;
      continue;
    }
    if (arg === '--overwrite-db') {
      overwriteDb = true;
    }
  }

  if (channels.size === 0) channels.add('web');

  return { channels, feishuMap, overwriteDb, overwriteClaude };
}

function parseFeishuMap(raw: string): Record<string, string> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('feishu-map must be a JSON object');
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') continue;
    const normalizedKey = key.trim();
    const normalizedValue = normalizeFeishuJid(value);
    if (normalizedKey && normalizedValue) {
      result[normalizedKey] = normalizedValue;
    }
  }
  return result;
}

function normalizeFeishuJid(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('feishu:') ? trimmed : `feishu:${trimmed}`;
}

function jidFor(channel: ChannelName, template: WorkflowGroupTemplate): string {
  if (channel === 'web') return `web:${template.folderSuffix}`;
  return '';
}

function folderFor(
  channel: ChannelName,
  template: WorkflowGroupTemplate,
): string {
  return `${channel}_${template.folderSuffix}`;
}

function nameFor(
  channel: ChannelName,
  template: WorkflowGroupTemplate,
): string {
  if (channel === 'feishu') return `${template.name}群`;
  return template.name;
}

function replaceAssistantName(content: string): string {
  if (ASSISTANT_NAME === 'Andy') return content;
  return content
    .replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`)
    .replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
}

function writeClaudeMd(
  folder: string,
  template: WorkflowGroupTemplate,
  overwrite: boolean,
): 'created' | 'existing' | 'overwritten' {
  const groupDir = path.join(process.cwd(), 'groups', folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });
  const claudePath = path.join(groupDir, 'CLAUDE.md');
  const existed = fs.existsSync(claudePath);

  if (existed && !overwrite) return 'existing';

  fs.writeFileSync(
    claudePath,
    replaceAssistantName(template.claudeMd),
    'utf-8',
  );
  return existed ? 'overwritten' : 'created';
}

function registerWorkflowGroup(
  channel: ChannelName,
  template: WorkflowGroupTemplate,
  jid: string,
  overwriteDb: boolean,
  overwriteClaude: boolean,
): RegisterResult {
  const folder = folderFor(channel, template);
  if (!isValidGroupFolder(folder)) {
    throw new Error(`Invalid generated folder: ${folder}`);
  }

  const claude = writeClaudeMd(folder, template, overwriteClaude);
  const existing = getRegisteredGroup(jid);
  let dbStatus: RegisterResult['db'] = 'existing';
  if (!existing || overwriteDb) {
    setRegisteredGroup(jid, {
      name: nameFor(channel, template),
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: existing?.added_at || new Date().toISOString(),
      requiresTrigger: existing?.requiresTrigger ?? true,
      isMain: existing?.isMain ?? false,
      description: template.description,
    });
    dbStatus = existing ? 'overwritten' : 'created';
  }

  return {
    channel,
    roleKey: template.roleKey,
    jid,
    folder,
    db: dbStatus,
    claude,
  };
}

function resolveFeishuJid(
  template: WorkflowGroupTemplate,
  feishuMap: Record<string, string>,
): string {
  return (
    feishuMap[template.folderSuffix] ||
    feishuMap[template.roleKey] ||
    feishuMap[`feishu_${template.folderSuffix}`] ||
    ''
  );
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  const registered: RegisterResult[] = [];
  const skipped: SkippedResult[] = [];

  initDatabase();

  for (const channel of parsed.channels) {
    for (const template of ROLE_TEMPLATES) {
      const folder = folderFor(channel, template);
      if (channel === 'feishu') {
        const jid = resolveFeishuJid(template, parsed.feishuMap);
        if (!jid) {
          skipped.push({
            channel,
            roleKey: template.roleKey,
            folder,
            reason: 'missing_feishu_jid',
          });
          continue;
        }
        registered.push(
          registerWorkflowGroup(
            channel,
            template,
            jid,
            parsed.overwriteDb,
            parsed.overwriteClaude,
          ),
        );
        continue;
      }

      registered.push(
        registerWorkflowGroup(
          channel,
          template,
          jidFor(channel, template),
          parsed.overwriteDb,
          parsed.overwriteClaude,
        ),
      );
    }
  }

  logger.info({ registered, skipped }, 'Workflow groups registered');

  emitStatus('REGISTER_WORKFLOW_GROUPS', {
    CHANNELS: Array.from(parsed.channels).join(','),
    REGISTERED: registered.length,
    SKIPPED: skipped.length,
    REGISTERED_FOLDERS: registered.map((item) => item.folder).join(','),
    SKIPPED_FOLDERS: skipped.map((item) => item.folder).join(','),
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}
