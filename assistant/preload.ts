import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('assistantHost', {
  getWebToken: () => ipcRenderer.invoke('assistant:get-web-token'),
  openWorkstation: (target?: string) =>
    ipcRenderer.invoke('assistant:open-workstation', target),
  showContextMenu: (options?: { chatMode?: boolean }) =>
    ipcRenderer.invoke('assistant:show-context-menu', options),
  onChatModeRequest: (handler: (enabled: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, enabled: boolean) => {
      handler(Boolean(enabled));
    };
    ipcRenderer.on('assistant:chat-mode-request', listener);
    return () => {
      ipcRenderer.removeListener('assistant:chat-mode-request', listener);
    };
  },
  setAlwaysOnTop: (enabled: boolean) =>
    ipcRenderer.invoke('assistant:set-always-on-top', enabled),
  setChatOpen: (open: boolean) =>
    ipcRenderer.invoke('assistant:set-chat-open', open),
  setChatMode: (enabled: boolean) =>
    ipcRenderer.invoke('assistant:set-chat-mode', enabled),
  setMousePassthrough: (enabled: boolean) =>
    ipcRenderer.invoke('assistant:set-mouse-passthrough', enabled),
  moveBy: (dx: number, dy: number) =>
    ipcRenderer.invoke('assistant:move-by', dx, dy),
  hide: () => ipcRenderer.invoke('assistant:hide'),
  platform: process.platform,
});
