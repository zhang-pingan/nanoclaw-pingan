import {
  app,
  BrowserWindow,
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

const COLLAPSED_WINDOW_WIDTH = 390;
const COLLAPSED_WINDOW_HEIGHT = 320;
const EXPANDED_WINDOW_WIDTH = 540;
const EXPANDED_WINDOW_HEIGHT = 430;
const WORKSTATION_URL = 'http://localhost:3000/';
const TRAY_ICON_SIZE = process.platform === 'darwin' ? 18 : 20;
const OPEN_WORKSTATION_ARG = '--nanoclaw-open-workstation';

let assistantWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let chatOpen = false;

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
  const raw = typeof target === 'string' && target.trim() ? target : WORKSTATION_URL;
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
  const electronExecutable = existsSync(localElectron) ? localElectron : process.execPath;
  const child = spawn(electronExecutable, [entry, `${OPEN_WORKSTATION_ARG}=${url}`], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
  });
  child.once('error', () => {
    void shell.openExternal(url);
  });
  child.unref();
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

function assistantWindowSize(): { width: number; height: number } {
  return chatOpen
    ? { width: EXPANDED_WINDOW_WIDTH, height: EXPANDED_WINDOW_HEIGHT }
    : { width: COLLAPSED_WINDOW_WIDTH, height: COLLAPSED_WINDOW_HEIGHT };
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

function resizeAssistantWindowForChatMode(): void {
  if (!assistantWindow || assistantWindow.isDestroyed()) return;

  const bounds = assistantWindow.getBounds();
  const size = assistantWindowSize();
  if (bounds.width === size.width && bounds.height === size.height) return;

  const bottomRightX = bounds.x + bounds.width;
  const bottomRightY = bounds.y + bounds.height;
  const next = clampWindowToWorkArea(
    bottomRightX - size.width,
    bottomRightY - size.height,
    size.width,
    size.height,
  );
  assistantWindow.setBounds({ ...next, ...size });
}

function createAssistantWindow(): void {
  if (assistantWindow && !assistantWindow.isDestroyed()) {
    assistantWindow.show();
    assistantWindow.focus();
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
    fullscreenable: false,
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
  assistantWindow.loadFile(rendererPath('index.html'));

  assistantWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    assistantWindow?.hide();
  });
}

function createTray(): void {
  const image = nativeImage
    .createFromPath(assetPath('nanoclaw-icon.png'))
    .resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  tray = new Tray(image);
  tray.setToolTip('NanoClaw Personal Assistant');
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

ipcMain.handle('assistant:open-workstation', async (_event, target?: string) => {
  openWorkstationClient(target);
});

ipcMain.handle(
  'assistant:set-always-on-top',
  (_event, enabled: boolean) => {
    assistantWindow?.setAlwaysOnTop(Boolean(enabled), 'floating');
  },
);

ipcMain.handle('assistant:set-chat-open', (_event, open: boolean) => {
  chatOpen = Boolean(open);
  resizeAssistantWindowForChatMode();
});

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
  createTray();
  createAssistantWindow();
});

app.on('activate', () => {
  createAssistantWindow();
});

app.on('before-quit', () => {
  isQuitting = true;
});
