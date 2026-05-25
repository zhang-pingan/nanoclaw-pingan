import {
  app,
  BrowserWindow,
  globalShortcut,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  screen,
  shell,
} from 'electron';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import type { MenuItemConstructorOptions } from 'electron';

const ASSISTANT_COMPACT_WINDOW_WIDTH = 540;
const ASSISTANT_COMPACT_WINDOW_HEIGHT = 430;
const ASSISTANT_EXPANDED_WINDOW_WIDTH = 1010;
const ASSISTANT_EXPANDED_WINDOW_HEIGHT = 520;
const WORKSTATION_URL = 'http://localhost:3000/';
const TRAY_ICON_SIZE = process.platform === 'darwin' ? 18 : 20;
const OPEN_WORKSTATION_ARG = '--icarus-open-workstation';
const ASSISTANT_CHAT_MENU_ACCELERATORS = ['Command+`', 'Command+~'];
const ASSISTANT_CHAT_GLOBAL_ACCELERATORS = [
  ...ASSISTANT_CHAT_MENU_ACCELERATORS,
  'Command+·',
  'Command+§',
  'Command+±',
];

let assistantWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let assistantChatOpen = false;
let assistantChatMode = false;
let lastContextMenuPopupAt = 0;

function rendererPath(filename: string): string {
  return path.join(process.cwd(), 'assistant', 'renderer', filename);
}

function assetPath(filename: string): string {
  return path.join(process.cwd(), 'assets', filename);
}

function electronClientEntryPath(): string {
  return path.join(process.cwd(), 'dist-electron', 'main.cjs');
}

function electronBinPath(): string {
  const binary = process.platform === 'win32' ? 'electron.cmd' : 'electron';
  return path.join(process.cwd(), 'node_modules', '.bin', binary);
}

function localWorkstationUrl(target?: string): string | null {
  const raw =
    typeof target === 'string' && target.trim() ? target : WORKSTATION_URL;
  try {
    const url = new URL(raw);
    const isLocalWebClient =
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      url.port === '3000';
    return isLocalWebClient ? url.toString() : null;
  } catch {
    return WORKSTATION_URL;
  }
}

function openWorkstationClient(target?: string): void {
  const url = localWorkstationUrl(target);
  if (!url) {
    if (target) void shell.openExternal(target);
    return;
  }

  const entry = electronClientEntryPath();
  if (!existsSync(entry)) {
    void shell.openExternal(url);
    return;
  }

  const localElectron = electronBinPath();
  const electronExecutable = existsSync(localElectron)
    ? localElectron
    : process.execPath;
  const child = spawn(
    electronExecutable,
    [entry, `${OPEN_WORKSTATION_ARG}=${url}`],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    },
  );
  child.once('error', () => {
    void shell.openExternal(url);
  });
  child.unref();
}

function sendAssistantChatModeRequest(enabled: boolean): void {
  if (!assistantWindow || assistantWindow.isDestroyed()) return;
  if (!enabled && assistantWindow.isFullScreen()) return;
  assistantWindow.webContents.send('assistant:chat-mode-request', enabled);
}

function setAssistantWindowChatControlsEnabled(enabled: boolean): void {
  if (!assistantWindow || assistantWindow.isDestroyed()) return;
  assistantWindow.setResizable(enabled);
  assistantWindow.setFullScreenable(enabled);
}

function handleAssistantEscapeKey(): boolean {
  if (!assistantWindow || assistantWindow.isDestroyed()) return false;

  if (assistantWindow.isFullScreen()) {
    assistantWindow.setFullScreen(false);
    return true;
  }

  if (assistantChatMode) {
    sendAssistantChatModeRequest(false);
    return true;
  }

  return false;
}

function handleAssistantCommandBacktickKey(): boolean {
  bringAssistantWindowToFront();
  if (!assistantWindow || assistantWindow.isDestroyed()) return false;

  if (!assistantChatMode) {
    sendAssistantChatModeRequest(true);
    return true;
  }

  if (!assistantWindow.isFullScreen()) {
    assistantWindow.setFullScreen(true);
    return true;
  }

  return true;
}

function registerAssistantShortcuts(): void {
  for (const accelerator of ASSISTANT_CHAT_GLOBAL_ACCELERATORS) {
    try {
      const registered = globalShortcut.register(accelerator, () => {
        handleAssistantCommandBacktickKey();
      });
      if (!registered) {
        console.warn(`assistant shortcut not registered: ${accelerator}`);
      }
    } catch (err) {
      console.warn(`assistant shortcut registration failed: ${accelerator}`, err);
    }
  }
}

function unregisterAssistantShortcuts(): void {
  for (const accelerator of ASSISTANT_CHAT_GLOBAL_ACCELERATORS) {
    globalShortcut.unregister(accelerator);
  }
}

function assistantShortcutMenuItems(): MenuItemConstructorOptions[] {
  return ASSISTANT_CHAT_MENU_ACCELERATORS.map((accelerator, index) => ({
    label: index === 0 ? '个人助手聊天模式' : '个人助手聊天模式备用快捷键',
    accelerator,
    visible: false,
    click: () => {
      handleAssistantCommandBacktickKey();
    },
  }));
}

function installAssistantApplicationMenu(): void {
  try {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        ...(process.platform === 'darwin'
          ? [
              {
                label: app.name,
                submenu: [
                  ...assistantShortcutMenuItems(),
                  { type: 'separator' as const },
                  { role: 'hide' as const },
                  { role: 'hideOthers' as const },
                  { role: 'unhide' as const },
                  { type: 'separator' as const },
                  { role: 'quit' as const },
                ],
              },
            ]
          : []),
        {
          label: 'Edit',
          submenu: [
            { role: 'undo' as const },
            { role: 'redo' as const },
            { type: 'separator' as const },
            { role: 'cut' as const },
            { role: 'copy' as const },
            { role: 'paste' as const },
            { role: 'selectAll' as const },
          ],
        },
      ]),
    );
  } catch (err) {
    console.warn('assistant application menu installation failed', err);
  }
}

function isCommandBackquoteInput(input: Electron.Input): boolean {
  if (!input.meta || input.shift || input.control || input.alt) return false;
  return (
    input.code === 'Backquote' ||
    input.key === '`' ||
    input.key === '~' ||
    input.key === '·' ||
    input.key === '§' ||
    input.key === '±'
  );
}

function showAssistantContextMenu(options: { chatMode?: boolean } = {}): void {
  if (!assistantWindow || assistantWindow.isDestroyed()) return;

  const now = Date.now();
  if (now - lastContextMenuPopupAt < 180) return;
  lastContextMenuPopupAt = now;

  const chatMode = options.chatMode ?? assistantChatMode;
  const isFullScreen = assistantWindow.isFullScreen();
  const exitChatModeDisabled = chatMode && isFullScreen;
  const template: MenuItemConstructorOptions[] = [
    {
      label: exitChatModeDisabled
        ? '请先退出全屏'
        : chatMode
          ? '退出聊天模式'
          : '进入聊天模式',
      enabled: !exitChatModeDisabled,
      click: () => sendAssistantChatModeRequest(!chatMode),
    },
    {
      label: '打开工作站',
      click: () => openWorkstationClient(),
    },
    { type: 'separator' },
    {
      label: isFullScreen ? '退出全屏' : '全屏',
      enabled: chatMode,
      click: () => {
        if (!assistantWindow || assistantWindow.isDestroyed()) return;
        assistantWindow.setFullScreen(!assistantWindow.isFullScreen());
      },
    },
    {
      label: '隐藏个人助手',
      click: () => assistantWindow?.hide(),
    },
  ];

  Menu.buildFromTemplate(template).popup({ window: assistantWindow });
}

function bringAssistantWindowToFront(): void {
  createAssistantWindow();
  if (!assistantWindow || assistantWindow.isDestroyed()) return;

  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  }

  if (assistantWindow.isMinimized()) assistantWindow.restore();
  assistantWindow.show();
  assistantWindow.moveTop();
  assistantWindow.focus();
  assistantWindow.webContents.focus();
}

function toggleAssistantWindow(): void {
  if (
    assistantWindow &&
    !assistantWindow.isDestroyed() &&
    assistantWindow.isVisible()
  ) {
    assistantWindow.hide();
    return;
  }

  bringAssistantWindowToFront();
}

function assistantWindowSize(expanded = false): {
  width: number;
  height: number;
} {
  return expanded
    ? {
        width: ASSISTANT_EXPANDED_WINDOW_WIDTH,
        height: ASSISTANT_EXPANDED_WINDOW_HEIGHT,
      }
    : {
        width: ASSISTANT_COMPACT_WINDOW_WIDTH,
        height: ASSISTANT_COMPACT_WINDOW_HEIGHT,
      };
}

function clampWindowToWorkArea(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const currentBounds = assistantWindow?.getBounds() || {
    x,
    y,
    width,
    height,
  };
  const display = screen.getDisplayMatching(currentBounds);
  const area = display.workArea;
  return {
    x: Math.min(Math.max(Math.round(x), area.x), area.x + area.width - width),
    y: Math.min(Math.max(Math.round(y), area.y), area.y + area.height - height),
  };
}

function createAssistantWindow(): void {
  if (assistantWindow && !assistantWindow.isDestroyed()) {
    assistantWindow.show();
    assistantWindow.focus();
    assistantWindow.webContents.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const size = assistantWindowSize();
  assistantWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: area.x + area.width - size.width - 34,
    y: area.y + area.height - size.height - 42,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    fullscreenable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  assistantWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
  });
  setAssistantWindowChatControlsEnabled(false);
  assistantWindow.loadFile(rendererPath('index.html'));
  assistantWindow.webContents.on('context-menu', () => {
    showAssistantContextMenu();
  });
  assistantWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape' || input.code === 'Escape') {
      if (handleAssistantEscapeKey()) event.preventDefault();
      return;
    }
    if (isCommandBackquoteInput(input)) {
      if (handleAssistantCommandBacktickKey()) event.preventDefault();
    }
  });

  assistantWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    assistantWindow?.hide();
  });
}

function setAssistantWindowExpanded(expanded: boolean): void {
  if (!assistantWindow || assistantWindow.isDestroyed()) return;
  if (!expanded && assistantChatMode && assistantWindow.isFullScreen()) {
    sendAssistantChatModeRequest(true);
    return;
  }

  assistantChatOpen = expanded;
  if (expanded) {
    assistantWindow.show();
    assistantWindow.focus();
    assistantWindow.webContents.focus();
  }
  if (!expanded) {
    assistantChatMode = false;
    setAssistantWindowChatControlsEnabled(false);
  }
  if (!expanded && assistantWindow.isFullScreen()) {
    assistantWindow.setFullScreen(false);
  }

  const bounds = assistantWindow.getBounds();
  const size = assistantWindowSize(expanded);
  if (
    assistantWindow.isFullScreen() ||
    (bounds.width === size.width && bounds.height === size.height)
  ) {
    return;
  }

  const next = clampWindowToWorkArea(
    bounds.x + bounds.width - size.width,
    bounds.y + bounds.height - size.height,
    size.width,
    size.height,
  );
  assistantWindow.setBounds({
    ...next,
    width: size.width,
    height: size.height,
  });
}

function setAssistantWindowChatMode(enabled: boolean): void {
  if (!assistantWindow || assistantWindow.isDestroyed()) return;
  if (!enabled && assistantWindow.isFullScreen()) {
    sendAssistantChatModeRequest(true);
    return;
  }

  assistantChatMode = enabled;
  assistantChatOpen = true;
  assistantWindow.show();
  assistantWindow.focus();
  assistantWindow.webContents.focus();
  setAssistantWindowChatControlsEnabled(enabled);

  const resizeToExpanded = () => setAssistantWindowExpanded(true);
  resizeToExpanded();
}

function createTray(): void {
  const image = nativeImage
    .createFromPath(assetPath('claw-icon.png'))
    .resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  tray = new Tray(image);
  tray.setToolTip('Icarus Personal Assistant');
  tray.on('click', toggleAssistantWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示个人助手', click: () => bringAssistantWindowToFront() },
      {
        label: '打开工作站',
        click: () => openWorkstationClient(),
      },
      { type: 'separator' },
      {
        label: '退出个人助手',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

ipcMain.handle('assistant:get-web-token', () => process.env.WEB_TOKEN || '');

ipcMain.handle(
  'assistant:open-workstation',
  async (_event, target?: string) => {
    openWorkstationClient(target);
  },
);

ipcMain.handle(
  'assistant:show-context-menu',
  async (_event, options?: { chatMode?: boolean }) => {
    showAssistantContextMenu({
      chatMode:
        typeof options?.chatMode === 'boolean' ? options.chatMode : undefined,
    });
  },
);

ipcMain.handle('assistant:set-always-on-top', (_event, enabled: boolean) => {
  assistantWindow?.setAlwaysOnTop(Boolean(enabled), 'floating');
});

ipcMain.handle('assistant:set-chat-open', (_event, open: boolean) => {
  setAssistantWindowExpanded(Boolean(open));
});

ipcMain.handle('assistant:set-chat-mode', (_event, enabled: boolean) => {
  setAssistantWindowChatMode(Boolean(enabled));
});

ipcMain.handle(
  'assistant:set-mouse-passthrough',
  (_event, enabled: boolean) => {
    if (!assistantWindow || assistantWindow.isDestroyed()) return;
    if (enabled) {
      assistantWindow.setIgnoreMouseEvents(true, { forward: true });
      return;
    }
    assistantWindow.setIgnoreMouseEvents(false);
  },
);

ipcMain.handle('assistant:move-by', (_event, dx: number, dy: number) => {
  if (!assistantWindow || assistantWindow.isDestroyed()) return;
  const bounds = assistantWindow.getBounds();
  const next = clampWindowToWorkArea(
    bounds.x + dx,
    bounds.y + dy,
    bounds.width,
    bounds.height,
  );
  assistantWindow.setBounds({ ...bounds, ...next });
});

ipcMain.handle('assistant:hide', () => {
  assistantWindow?.hide();
});

app.whenReady().then(() => {
  installAssistantApplicationMenu();
  createTray();
  createAssistantWindow();
  registerAssistantShortcuts();
});

app.on('activate', () => {
  createAssistantWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('will-quit', () => {
  unregisterAssistantShortcuts();
});
