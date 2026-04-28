// Type declarations for the NanoClaw Electron renderer

interface NanoClawAppAPI {
  /** Show a native system notification */
  notify(title: string, body: string, meta?: { chatJid?: string; taskId?: string }): void;
  /** Listen to notification click events emitted by the main process */
  onNotificationClick(handler: (payload: { chatJid?: string; taskId?: string }) => void): () => void;
  /** Listen to the app shortcut that cycles the primary nav */
  onCyclePrimaryNav(handler: () => void): () => void;
  /** Listen to the app shortcut that toggles the Today Plan screen */
  onToggleTodayPlan(handler: () => void): () => void;
  /** Listen for quick-chat actions that should switch the main window to the main group */
  onQuickChatOpenMainGroup(handler: () => void): () => void;
  /** Open a URL in the system browser */
  openExternal(url: string): void;
  /** Open a local file in the default app */
  openFile(filePath: string): Promise<{ ok: boolean; result?: string; error?: string }>;
  /** Open file with system app picker */
  openFileWith(filePath: string): Promise<{ ok: boolean; error?: string }>;
  /** Reveal a file in the system file manager */
  showInFolder(filePath: string): Promise<{ ok: boolean; error?: string }>;
  /** Capture desktop display metadata and, optionally, a screenshot */
  captureDesktop(options?: {
    displayId?: string;
    maxWidth?: number;
    includeImage?: boolean;
    includeWindows?: boolean;
  }): Promise<{
    ok: boolean;
    error?: string;
    details?: string;
    capturedAt?: string;
    platform?: string;
    screenPermission?: string;
    displays?: unknown[];
    windows?: unknown[];
    imageBase64?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    displayId?: string;
  }>;
  /** Current platform (darwin, win32, linux) */
  platform: string;
  /** Bring the main application window to the foreground */
  showMainWindow(): void;
  /** Ask the main application window to jump to the main group */
  openMainGroupFromQuickChat(): void;
  /** Hide the window (quit Electron UI, keep NanoClaw running) */
  hideWindow(): void;
}

declare global {
  interface Window {
    nanoclawApp: NanoClawAppAPI;
  }
}

export {};
