import { contextBridge, ipcRenderer } from 'electron';

// Expose a safe API to the renderer process for the Icarus web channel.

// The renderer connects via standard WebSocket/HTTP to localhost:3000
// where the Icarus web channel runs. The preload only bridges
// Electron-specific capabilities (notifications, tray, etc.).

contextBridge.exposeInMainWorld('icarusApp', {
  // Show a native macOS notification
  notify: (
    title: string,
    body: string,
    meta?: {
      chatJid?: string;
      taskId?: string;
      collaborationGroupId?: string;
      collaborationTurnId?: string;
    },
  ) => {
    ipcRenderer.send('show-notification', { title, body, meta });
  },

  // Listen for notification click events from the main process.
  onNotificationClick: (
    handler: (payload: {
      chatJid?: string;
      taskId?: string;
      collaborationGroupId?: string;
      collaborationTurnId?: string;
    }) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: {
        chatJid?: string;
        taskId?: string;
        collaborationGroupId?: string;
        collaborationTurnId?: string;
      },
    ) => {
      handler(payload || {});
    };
    ipcRenderer.on('notification-clicked', listener);
    return () => ipcRenderer.removeListener('notification-clicked', listener);
  },

  // Listen for app-level shortcuts forwarded by the main process.
  onCyclePrimaryNav: (handler: () => void) => {
    const listener = () => {
      handler();
    };
    ipcRenderer.on('cycle-primary-nav', listener);
    return () => ipcRenderer.removeListener('cycle-primary-nav', listener);
  },

  onToggleTodayPlan: (handler: () => void) => {
    const listener = () => {
      handler();
    };
    ipcRenderer.on('toggle-today-plan', listener);
    return () => ipcRenderer.removeListener('toggle-today-plan', listener);
  },

  onOpenWorkstationTarget: (handler: (payload: { url?: string }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { url?: string },
    ) => {
      handler(payload || {});
    };
    ipcRenderer.on('open-workstation-target', listener);
    return () =>
      ipcRenderer.removeListener('open-workstation-target', listener);
  },

  // Open external URL in system browser
  openExternal: (url: string) => {
    return ipcRenderer.invoke('open-external-url', url);
  },

  // Open an existing Codex App Server thread in the Codex desktop app.
  openCodexThread: (threadId: string) => {
    return ipcRenderer.invoke('open-codex-thread', threadId);
  },

  // Open a local file in its default application
  openFile: (filePath: string) => {
    return ipcRenderer.invoke('open-file', filePath);
  },

  // Open file with system app picker
  openFileWith: (filePath: string) => {
    return ipcRenderer.invoke('open-file-with', filePath);
  },

  // Show file in folder
  showInFolder: (filePath: string) => {
    return ipcRenderer.invoke('show-in-folder', filePath);
  },

  // Capture current desktop display metadata and, optionally, a screenshot.
  captureDesktop: (options?: {
    displayId?: string;
    maxWidth?: number;
    includeImage?: boolean;
    includeWindows?: boolean;
  }) => {
    return ipcRenderer.invoke('desktop-capture', options || {});
  },

  // Platform info
  platform: process.platform,
});
