export const ASSISTANT_MAIN_JID = 'assistant:main';
export const ASSISTANT_MAIN_FOLDER = 'assistant_main';
export const ASSISTANT_MAIN_NAME = '桌面个人助手';

export interface AssistantChatMessageView {
  id: string;
  chatJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  isFromMe: boolean;
  isBotMessage: boolean;
  filePath: string | null;
  fileUrl: string | null;
}

export interface AssistantChannelPort {
  sendUserMessage(content: string): AssistantChatMessageView;
  listMessages(limit?: number): AssistantChatMessageView[];
}

let port: AssistantChannelPort | null = null;

export function registerAssistantChannelPort(
  nextPort: AssistantChannelPort | null,
): void {
  port = nextPort;
}

export function sendAssistantUserMessage(
  content: string,
): AssistantChatMessageView {
  if (!port) {
    throw new Error('Assistant channel is not connected');
  }
  return port.sendUserMessage(content);
}

export function listAssistantChatMessages(
  limit?: number,
): AssistantChatMessageView[] {
  if (!port) return [];
  return port.listMessages(limit);
}
