import { contextBridge, BrowserWindow } from 'electron';

// Expose a safe API to the renderer process for the NanoClaw web channel.

// The renderer connects via standard WebSocket/HTTP to localhost:3000
// where the NanoClaw web channel runs. The preload only bridges
// Electron-specific capabilities (notifications, tray, etc.).

contextBridge.exposeInMainWorld('nanoclawApp', {
  // Show a native macOS notification
  notify: (title: string, body: string) => {
    if (Notification.permission === 'granted') {
      new Notification(title, { body });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') new Notification(title, { body });
      });
    }
  },

  // Open external URL in system browser
  openExternal: (url: string) => {
    // This would go through IPC in a real implementation
    // For now, let the renderer handle it via window.open with target=_blank
    // which the main process intercepts
  },

  // Platform info
  platform: process.platform,

  // Quit the app (hide only, not "Quit All")
  hideWindow: () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win) win.hide();
  },
});
