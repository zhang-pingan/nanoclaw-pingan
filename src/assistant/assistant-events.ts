import type {
  AssistantChatMessageView,
} from './assistant-channel-bridge.js';
import type {
  AgentInboxItemView,
  AssistantActionLogView,
  AssistantSettings,
} from './types.js';

export type AssistantRealtimeEvent =
  | {
      type: 'inbox_updated';
      item: AgentInboxItemView;
    }
  | {
      type: 'settings_updated';
      settings: AssistantSettings;
    }
  | {
      type: 'action_logged';
      log: AssistantActionLogView;
    }
  | {
      type: 'chat_message';
      message: AssistantChatMessageView;
    }
  | {
      type: 'chat_typing';
      typing: boolean;
    }
  | {
      type: 'scan_completed';
      createdOrUpdated: number;
      scannedAt: string;
    }
  | {
      type: 'data_cleared';
      deleted: {
        assistant_chat_messages: number;
        messages: number;
        agent_inbox_items: number;
        assistant_action_logs: number;
        assistant_snoozes: number;
        total: number;
      };
      clearedAt: string;
    };

type AssistantEventBroadcaster = (event: AssistantRealtimeEvent) => void;

let broadcaster: AssistantEventBroadcaster | null = null;

export function initAssistantEvents(
  nextBroadcaster: AssistantEventBroadcaster,
): void {
  broadcaster = nextBroadcaster;
}

export function emitAssistantEvent(event: AssistantRealtimeEvent): void {
  broadcaster?.(event);
}
