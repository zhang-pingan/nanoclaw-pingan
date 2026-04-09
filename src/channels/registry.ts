import {
  ActiveAgentQueryTrace,
  AgentStatusInfo,
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
  StopAgentResult,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getAgentStatus?: () => AgentStatusInfo[];
  getActiveAgentQueryTraces?: () => ActiveAgentQueryTrace[];
  stopAgent?: (groupJid: string) => Promise<StopAgentResult>;
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
