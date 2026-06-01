import type { AssistantRealtimeEvent } from './assistant-events.js';
import type { AgentInboxItemView } from './types.js';
import type { InteractiveCard, RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import {
  isAssistantInboxBroadcastEnabled,
  resolveAssistantInboxBroadcastJids,
} from './assistant-inbox-broadcast-config.js';
import {
  buildAssistantInboxBroadcastCard,
  buildAssistantInboxBroadcastFallbackText,
  buildAssistantInboxBroadcastStatusCard,
  buildAssistantInboxBroadcastStatusText,
} from './assistant-inbox-broadcast-render.js';

interface BroadcastDeliveryState {
  status: string;
  updatedAt: string;
  targets: Set<string>;
}

const CARD_STATUSES = new Set(['unread', 'read']);

export interface AssistantInboxBroadcastDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendCard?: (
    jid: string,
    card: InteractiveCard,
  ) => Promise<string | undefined>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

export class AssistantInboxBroadcastService {
  private readonly deliveries = new Map<string, BroadcastDeliveryState>();

  constructor(private readonly deps: AssistantInboxBroadcastDeps) {}

  async handleEvent(event: AssistantRealtimeEvent): Promise<void> {
    if (!isAssistantInboxBroadcastEnabled()) return;
    if (event.type !== 'inbox_updated') return;

    const item = event.item;
    const groups = this.deps.registeredGroups();
    const targetJids = resolveAssistantInboxBroadcastJids(groups);
    if (targetJids.length === 0) return;

    if (CARD_STATUSES.has(item.status)) {
      await this.broadcastActive(item, targetJids);
      return;
    }

    await this.broadcastStatus(item, targetJids);
  }

  private async broadcastActive(
    item: AgentInboxItemView,
    targetJids: string[],
  ): Promise<void> {
    const state = this.deliveries.get(item.id);
    const pendingTargets = targetJids.filter((jid) => {
      return !(state?.updatedAt === item.updated_at && state.targets.has(jid));
    });
    if (pendingTargets.length === 0) return;

    const card = buildAssistantInboxBroadcastCard(item);
    if (!card) return;

    const sentTargets =
      state?.updatedAt === item.updated_at
        ? new Set(state.targets)
        : new Set<string>();

    for (const jid of pendingTargets) {
      try {
        if (this.deps.sendCard) {
          await this.deps.sendCard(jid, card);
        } else {
          await this.deps.sendMessage(jid, card.body || card.header.title);
        }
        sentTargets.add(jid);
      } catch (err) {
        logger.warn(
          { err, itemId: item.id, jid },
          'Failed to broadcast assistant inbox item',
        );
        try {
          await this.deps.sendMessage(
            jid,
            buildAssistantInboxBroadcastFallbackText(item),
          );
          sentTargets.add(jid);
          logger.info(
            { itemId: item.id, jid },
            'Assistant inbox broadcast downgraded to text message',
          );
        } catch (fallbackErr) {
          logger.warn(
            { err: fallbackErr, itemId: item.id, jid },
            'Failed to broadcast assistant inbox fallback text',
          );
        }
      }
    }

    this.deliveries.set(item.id, {
      status: item.status,
      updatedAt: item.updated_at,
      targets: sentTargets,
    });
  }

  private async broadcastStatus(
    item: AgentInboxItemView,
    targetJids: string[],
  ): Promise<void> {
    const state = this.deliveries.get(item.id);
    if (state?.status === item.status && state.updatedAt === item.updated_at) {
      return;
    }

    const card = buildAssistantInboxBroadcastStatusCard(item);
    const text = buildAssistantInboxBroadcastStatusText(item);
    const sentTargets = new Set<string>();
    for (const jid of targetJids) {
      try {
        if (this.deps.sendCard) {
          await this.deps.sendCard(jid, card);
        } else {
          await this.deps.sendMessage(jid, text);
        }
        sentTargets.add(jid);
      } catch (err) {
        logger.warn(
          { err, itemId: item.id, jid, status: item.status },
          'Failed to broadcast assistant inbox status update',
        );
        if (!this.deps.sendCard) continue;
        try {
          await this.deps.sendMessage(jid, text);
          sentTargets.add(jid);
          logger.info(
            { itemId: item.id, jid, status: item.status },
            'Assistant inbox status broadcast downgraded to text message',
          );
        } catch (fallbackErr) {
          logger.warn(
            { err: fallbackErr, itemId: item.id, jid, status: item.status },
            'Failed to broadcast assistant inbox status fallback text',
          );
        }
      }
    }

    this.deliveries.set(item.id, {
      status: item.status,
      updatedAt: item.updated_at,
      targets: sentTargets,
    });
  }
}
