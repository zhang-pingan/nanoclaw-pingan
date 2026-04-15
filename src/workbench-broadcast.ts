import type { WorkbenchRealtimeEvent } from './workbench-events.js';
import type { InteractiveCard, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  isWorkbenchBroadcastEnabled,
  resolveWorkbenchBroadcastJids,
} from './workbench-broadcast-config.js';
import {
  buildWorkbenchBroadcastCard,
  buildWorkbenchBroadcastResolvedText,
} from './workbench-broadcast-render.js';

interface BroadcastDeliveryState {
  status: string;
  targets: Set<string>;
}

export interface WorkbenchBroadcastDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sendCard?: (jid: string, card: InteractiveCard) => Promise<string | undefined>;
  sendMessage: (jid: string, text: string) => Promise<void>;
}

export class WorkbenchBroadcastService {
  private readonly deliveries = new Map<string, BroadcastDeliveryState>();

  constructor(private readonly deps: WorkbenchBroadcastDeps) {}

  async handleEvent(event: WorkbenchRealtimeEvent): Promise<void> {
    if (!isWorkbenchBroadcastEnabled()) return;
    if (event.type !== 'action_item_updated') return;

    const actionItemId =
      typeof event.payload.id === 'string' ? event.payload.id : '';
    const status =
      typeof event.payload.status === 'string' ? event.payload.status : '';
    if (!actionItemId || !status) return;

    const groups = this.deps.registeredGroups();
    const targetJids = resolveWorkbenchBroadcastJids(groups);
    if (targetJids.length === 0) return;

    if (status === 'pending') {
      await this.broadcastPending(event.taskId, actionItemId, targetJids);
      return;
    }

    await this.broadcastResolution(event.taskId, actionItemId, status, targetJids);
  }

  private async broadcastPending(
    taskId: string,
    actionItemId: string,
    targetJids: string[],
  ): Promise<void> {
    const card = buildWorkbenchBroadcastCard({ taskId, actionItemId });
    if (!card) return;

    const state = this.deliveries.get(actionItemId);
    const sentTargets = state?.targets || new Set<string>();
    const pendingTargets = targetJids.filter((jid) => !sentTargets.has(jid));

    if (pendingTargets.length === 0) return;

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
          { err, taskId, actionItemId, jid },
          'Failed to broadcast pending workbench action item',
        );
      }
    }

    this.deliveries.set(actionItemId, {
      status: 'pending',
      targets: sentTargets,
    });
  }

  private async broadcastResolution(
    taskId: string,
    actionItemId: string,
    status: string,
    targetJids: string[],
  ): Promise<void> {
    const state = this.deliveries.get(actionItemId);
    if (state?.status === status) return;

    const text = buildWorkbenchBroadcastResolvedText({
      taskId,
      actionItemId,
      nextStatus: status,
    });
    if (!text) return;

    for (const jid of targetJids) {
      try {
        await this.deps.sendMessage(jid, text);
      } catch (err) {
        logger.warn(
          { err, taskId, actionItemId, jid, status },
          'Failed to broadcast resolved workbench action item',
        );
      }
    }

    this.deliveries.set(actionItemId, {
      status,
      targets: new Set(targetJids),
    });
  }
}
