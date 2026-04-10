// Type declarations for the NanoClaw Electron renderer

interface NanoClawAppAPI {
  /** Show a native system notification */
  notify(title: string, body: string, meta?: { chatJid?: string; taskId?: string }): void;
  /** Listen to notification click events emitted by the main process */
  onNotificationClick(handler: (payload: { chatJid?: string; taskId?: string }) => void): () => void;
  /** Listen to the app shortcut that cycles the primary nav */
  onCyclePrimaryNav(handler: () => void): () => void;
  /** Open a URL in the system browser */
  openExternal(url: string): void;
  /** Open a local file in the default app */
  openFile(filePath: string): Promise<{ ok: boolean; result?: string; error?: string }>;
  /** Open file with system app picker */
  openFileWith(filePath: string): Promise<{ ok: boolean; error?: string }>;
  /** Reveal a file in the system file manager */
  showInFolder(filePath: string): Promise<{ ok: boolean; error?: string }>;
  /** Current platform (darwin, win32, linux) */
  platform: string;
  /** Hide the window (quit Electron UI, keep NanoClaw running) */
  hideWindow(): void;
}

declare global {
  interface Window {
    nanoclawApp: NanoClawAppAPI;
  }
}

export {};
