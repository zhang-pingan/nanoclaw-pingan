import {
  ActiveAgentQueryTrace,
  AgentStatusInfo,
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredAgent,
  StopAgentResult,
} from '../types.js';
import type { CollaborationWebApi } from '../collaboration/web-api.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredAgents: () => Record<string, RegisteredAgent>;
  enqueueMessageCheck?: (agentJid: string) => void;
  getAgentStatus?: () => AgentStatusInfo[];
  getActiveAgentQueryTraces?: () => ActiveAgentQueryTrace[];
  stopAgent?: (agentJid: string) => Promise<StopAgentResult>;
  resetSessions?: (scope: {
    all?: boolean;
    agentJid?: string;
  }) => Promise<{ resetCount: number }>;
  registerAgent?: (jid: string, agent: RegisteredAgent) => void;
  collaborationApi?: CollaborationWebApi;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
