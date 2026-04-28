import { ASSISTANT_NAME } from '../config.js';
import {
  listStoredMessagesByChat,
  storeChatMetadata,
  storeMessageDirect,
} from '../db.js';
import { emitAssistantEvent } from '../assistant/assistant-events.js';
import {
  ASSISTANT_MAIN_FOLDER,
  ASSISTANT_MAIN_JID,
  ASSISTANT_MAIN_NAME,
  AssistantChatMessageView,
  registerAssistantChannelPort,
} from '../assistant/assistant-channel-bridge.js';
import { logger } from '../logger.js';
import type { NewMessage, RegisteredGroup, StoredChatMessageRecord } from '../types.js';
import { registerChannel, ChannelFactory, ChannelOpts } from './registry.js';

function nowTs(): string {
  return Date.now().toString();
}

function createMessageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function assistantMainGroup(): RegisteredGroup {
  return {
    name: ASSISTANT_MAIN_NAME,
    folder: ASSISTANT_MAIN_FOLDER,
    trigger: '',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: true,
    description: '桌面个人助手自然语言主群',
  };
}

function toChatMessageView(
  record: StoredChatMessageRecord | NewMessage,
): AssistantChatMessageView {
  return {
    id: record.id,
    chatJid: record.chat_jid,
    sender: record.sender,
    senderName: record.sender_name,
    content: record.content,
    timestamp: record.timestamp,
    isFromMe: Boolean(record.is_from_me),
    isBotMessage: Boolean(record.is_bot_message),
  };
}

class AssistantChannel {
  name = 'assistant' as const;
  private connected = false;

  constructor(private readonly opts: ChannelOpts) {}

  async connect(): Promise<void> {
    const groups = this.opts.registeredGroups();
    if (!groups[ASSISTANT_MAIN_JID]) {
      if (!this.opts.registerGroup) {
        throw new Error('assistant channel requires registerGroup callback');
      }
      this.opts.registerGroup(ASSISTANT_MAIN_JID, assistantMainGroup());
    }

    const now = nowTs();
    this.opts.onChatMetadata(
      ASSISTANT_MAIN_JID,
      now,
      ASSISTANT_MAIN_NAME,
      'assistant',
      true,
    );

    registerAssistantChannelPort({
      sendUserMessage: (content) => this.receiveUserMessage(content),
      listMessages: (limit) => this.listMessages(limit),
    });
    this.connected = true;
    logger.info({ jid: ASSISTANT_MAIN_JID }, 'Assistant channel connected');
  }

  async disconnect(): Promise<void> {
    registerAssistantChannelPort(null);
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('assistant:');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) return;
    const timestamp = nowTs();
    const msg: StoredChatMessageRecord = {
      id: createMessageId('assistant-bot'),
      chat_jid: jid,
      sender: ASSISTANT_NAME,
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp,
      is_from_me: 0,
      is_bot_message: 1,
      workflow_id: null,
    };
    storeChatMetadata(jid, timestamp, ASSISTANT_MAIN_NAME, 'assistant', true);
    storeMessageDirect({
      ...msg,
      is_from_me: false,
      is_bot_message: true,
    });
    emitAssistantEvent({
      type: 'chat_message',
      message: toChatMessageView(msg),
    });
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.ownsJid(jid)) return;
    emitAssistantEvent({ type: 'chat_typing', typing: isTyping });
  }

  private receiveUserMessage(content: string): AssistantChatMessageView {
    const trimmed = content.trim();
    if (!trimmed) throw new Error('content required');

    const timestamp = nowTs();
    const msg: NewMessage = {
      id: createMessageId('assistant-user'),
      chat_jid: ASSISTANT_MAIN_JID,
      sender: 'desktop_assistant_user',
      sender_name: 'Desktop User',
      content: trimmed,
      timestamp,
      is_from_me: true,
      is_bot_message: false,
      model: null,
    };

    this.opts.onChatMetadata(
      ASSISTANT_MAIN_JID,
      timestamp,
      ASSISTANT_MAIN_NAME,
      'assistant',
      true,
    );
    this.opts.onMessage(ASSISTANT_MAIN_JID, msg);
    this.opts.enqueueMessageCheck?.(ASSISTANT_MAIN_JID);

    const view = toChatMessageView(msg);
    emitAssistantEvent({ type: 'chat_message', message: view });
    return view;
  }

  private listMessages(limit: number = 80): AssistantChatMessageView[] {
    return listStoredMessagesByChat(ASSISTANT_MAIN_JID, limit)
      .reverse()
      .map(toChatMessageView);
  }
}

const factory: ChannelFactory = (opts) => new AssistantChannel(opts);

registerChannel('assistant', factory);
