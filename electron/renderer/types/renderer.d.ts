// Type declarations for the NanoClaw Electron renderer

interface NanoClawAppAPI {
  /** Show a native system notification */
  notify(title: string, body: string): void;
  /** Open a URL in the system browser */
  openExternal(url: string): void;
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
