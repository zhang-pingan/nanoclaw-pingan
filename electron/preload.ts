import { contextBridge, BrowserWindow, ipcRenderer } from 'electron';

// Expose a safe API to the renderer process for the NanoClaw web channel.

// The renderer connects via standard WebSocket/HTTP to localhost:3000
// where the NanoClaw web channel runs. The preload only bridges
// Electron-specific capabilities (notifications, tray, etc.).

contextBridge.exposeInMainWorld('nanoclawApp', {
  // Show a native macOS notification
  notify: (title: string, body: string, meta?: { chatJid?: string; taskId?: string }) => {
    ipcRenderer.send('show-notification', { title, body, meta });
  },

  // Listen for notification click events from the main process.
  onNotificationClick: (handler: (payload: { chatJid?: string; taskId?: string }) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { chatJid?: string; taskId?: string }
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

  onQuickChatOpenMainGroup: (handler: () => void) => {
    const listener = () => {
      handler();
    };
    ipcRenderer.on('quick-chat-open-main-group', listener);
    return () => ipcRenderer.removeListener('quick-chat-open-main-group', listener);
  },

  // Open external URL in system browser
  openExternal: (url: string) => {
    // This would go through IPC in a real implementation
    // For now, let the renderer handle it via window.open with target=_blank
    // which the main process intercepts
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

  // Platform info
  platform: process.platform,

  showMainWindow: () => {
    ipcRenderer.send('show-main-window');
  },

  openMainGroupFromQuickChat: () => {
    ipcRenderer.send('quick-chat-open-main-group');
  },

  // Quit the app (hide only, not "Quit All")
  hideWindow: () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.hide();
  },
});
