import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('assistantHost', {
  getWebToken: () => ipcRenderer.invoke('assistant:get-web-token'),
  openWorkstation: (target?: string) =>
    ipcRenderer.invoke('assistant:open-workstation', target),
  setAlwaysOnTop: (enabled: boolean) =>
    ipcRenderer.invoke('assistant:set-always-on-top', enabled),
  moveBy: (dx: number, dy: number) => ipcRenderer.invoke('assistant:move-by', dx, dy),
  hide: () => ipcRenderer.invoke('assistant:hide'),
  platform: process.platform,
});
