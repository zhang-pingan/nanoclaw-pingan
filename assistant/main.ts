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
import path from 'path';

const WINDOW_WIDTH = 390;
const WINDOW_HEIGHT = 430;
const WORKSTATION_URL = 'http://localhost:3000/';

let assistantWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

function rendererPath(filename: string): string {
  return path.join(process.cwd(), 'assistant', 'renderer', filename);
}

function clampWindowToWorkArea(x: number, y: number): { x: number; y: number } {
  const currentBounds = assistantWindow?.getBounds() || {
    x,
    y,
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
  };
  const display = screen.getDisplayMatching(currentBounds);
  const area = display.workArea;
  return {
    x: Math.min(Math.max(Math.round(x), area.x), area.x + area.width - WINDOW_WIDTH),
    y: Math.min(Math.max(Math.round(y), area.y), area.y + area.height - WINDOW_HEIGHT),
  };
}

function createAssistantWindow(): void {
  if (assistantWindow && !assistantWindow.isDestroyed()) {
    assistantWindow.show();
    assistantWindow.focus();
    return;
  }

  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  assistantWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: area.x + area.width - WINDOW_WIDTH - 34,
    y: area.y + area.height - WINDOW_HEIGHT - 42,
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
  const image = nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('NanoClaw Personal Assistant');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示个人助手', click: () => createAssistantWindow() },
      {
        label: '打开工作站',
        click: () => shell.openExternal(WORKSTATION_URL),
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
  const url =
    typeof target === 'string' && target.startsWith('http')
      ? target
      : WORKSTATION_URL;
  await shell.openExternal(url);
});

ipcMain.handle(
  'assistant:set-always-on-top',
  (_event, enabled: boolean) => {
    assistantWindow?.setAlwaysOnTop(Boolean(enabled), 'floating');
  },
);

ipcMain.handle('assistant:move-by', (_event, dx: number, dy: number) => {
  if (!assistantWindow || assistantWindow.isDestroyed()) return;
  const bounds = assistantWindow.getBounds();
  const next = clampWindowToWorkArea(bounds.x + dx, bounds.y + dy);
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
