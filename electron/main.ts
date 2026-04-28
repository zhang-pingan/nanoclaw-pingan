import {
  app,
  BrowserWindow,
  Menu,
  MenuItemConstructorOptions,
  shell,
  ipcMain,
  Notification,
  globalShortcut,
  screen,
  desktopCapturer,
  systemPreferences,
  nativeImage,
} from 'electron';
import path from 'path';
import { execFile } from 'child_process';
import { readFile, unlink } from 'fs/promises';

const mainDir = __dirname;
const QUICK_CHAT_SHORTCUT = 'Command+`';
const WORKSTATION_URL = 'http://localhost:3000/';
const QUICK_CHAT_URL = `${WORKSTATION_URL}?quick-chat=1`;
const OPEN_WORKSTATION_ARG = '--nanoclaw-open-workstation';

// Track whether we're doing a full quit (Quit All) vs just hiding
let isQuitting = false;
let mainWindow: BrowserWindow | null = null;
let quickChatWindow: BrowserWindow | null = null;
let pendingWorkstationOpenUrl: string | undefined;

const isMac = process.platform === 'darwin';

interface ShowNotificationPayload {
  title: string;
  body: string;
  meta?: {
    chatJid?: string;
    taskId?: string;
  };
}

interface DesktopCapturePayload {
  displayId?: string;
  maxWidth?: number;
  includeImage?: boolean;
  includeWindows?: boolean;
}

interface DesktopCaptureDisplayInfo {
  id: string;
  label?: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  workArea: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  scaleFactor: number;
  rotation: number;
  internal: boolean;
  primary: boolean;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeWorkstationUrl(target?: string): string {
  const raw = typeof target === 'string' && target.trim() ? target : WORKSTATION_URL;
  try {
    const url = new URL(raw);
    const isLocalWorkstation =
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      url.port === '3000';
    return isLocalWorkstation ? url.toString() : WORKSTATION_URL;
  } catch {
    return WORKSTATION_URL;
  }
}

function getWorkstationOpenArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === OPEN_WORKSTATION_ARG) {
      return normalizeWorkstationUrl(argv[i + 1]);
    }
    if (arg.startsWith(`${OPEN_WORKSTATION_ARG}=`)) {
      return normalizeWorkstationUrl(arg.slice(OPEN_WORKSTATION_ARG.length + 1));
    }
  }
  return undefined;
}

pendingWorkstationOpenUrl = getWorkstationOpenArg(process.argv);
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    openWorkstationInClient(getWorkstationOpenArg(argv) || WORKSTATION_URL);
  });
}

function getMacAppBundlePath(): string | undefined {
  const match = process.execPath.match(/^(.*?\.app)(?:\/|$)/);
  return match?.[1];
}

function getMacScreenCaptureDiagnostics(extra?: string): string | undefined {
  if (!isMac) return extra;

  const appBundlePath = getMacAppBundlePath();
  const lines = [
    extra,
    `screenPermission=${systemPreferences.getMediaAccessStatus('screen')}`,
    `appName=${app.getName()}`,
    appBundlePath ? `appBundlePath=${appBundlePath}` : undefined,
    `isPackaged=${app.isPackaged}`,
    `execPath=${process.execPath}`,
    `pid=${process.pid}`,
  ];
  return lines.filter(Boolean).join('\n');
}

function execFileAsync(
  file: string,
  args: string[],
  timeout = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout }, (err, _stdout, stderr) => {
      if (err) {
        const message = stderr?.trim()
          ? `${err.message}\n${stderr.trim()}`
          : err.message;
        reject(new Error(message));
        return;
      }
      resolve();
    });
  });
}

async function captureDesktopWithMacScreencapture(args: {
  targetDisplay?: DesktopCaptureDisplayInfo;
  displays: DesktopCaptureDisplayInfo[];
  windows?: { id: string; name: string }[];
  maxWidth: number;
  desktopCapturerError: string;
  windowSourceError?: string;
}) {
  const filename = `nanoclaw-desktop-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}.png`;
  const outputPath = path.join(app.getPath('temp'), filename);
  const captureArgs = ['-x', '-t', 'png'];

  if (args.targetDisplay) {
    const { x, y, width, height } = args.targetDisplay.bounds;
    captureArgs.push('-R', `${x},${y},${width},${height}`);
  }
  captureArgs.push(outputPath);

  try {
    await execFileAsync('/usr/sbin/screencapture', captureArgs);
    if (args.maxWidth > 0) {
      await execFileAsync('/usr/bin/sips', [
        '-Z',
        String(args.maxWidth),
        outputPath,
      ]);
    }

    const png = await readFile(outputPath);
    const size = nativeImage.createFromBuffer(png).getSize();
    if (png.length === 0 || size.width === 0 || size.height === 0) {
      return {
        ok: false,
        error: 'macOS screencapture returned an empty image.',
        details: getMacScreenCaptureDiagnostics(
          [
            `desktopCapturerError=${args.desktopCapturerError}`,
            args.windowSourceError
              ? `windowSourceError=${args.windowSourceError}`
              : undefined,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        displays: args.displays,
        windows: args.windows,
      };
    }

    return {
      ok: true,
      capturedAt: new Date().toISOString(),
      platform: process.platform,
      screenPermission: systemPreferences.getMediaAccessStatus('screen'),
      displays: args.displays,
      windows: args.windows,
      imageBase64: png.toString('base64'),
      mimeType: 'image/png',
      width: size.width,
      height: size.height,
      displayId: args.targetDisplay?.id,
      details: getMacScreenCaptureDiagnostics(
        [
          'captureMethod=screencapture',
          `desktopCapturerError=${args.desktopCapturerError}`,
          args.windowSourceError
            ? `windowSourceError=${args.windowSourceError}`
            : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    };
  } catch (err) {
    return {
      ok: false,
      error: 'Failed to capture desktop with Electron desktopCapturer and macOS screencapture.',
      details: getMacScreenCaptureDiagnostics(
        [
          `desktopCapturerError=${args.desktopCapturerError}`,
          `screencaptureError=${formatError(err)}`,
          args.windowSourceError
            ? `windowSourceError=${args.windowSourceError}`
            : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
      ),
      displays: args.displays,
      windows: args.windows,
    };
  } finally {
    await unlink(outputPath).catch(() => undefined);
  }
}

function clampDesktopCaptureMaxWidth(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1920;
  return Math.min(Math.max(Math.round(numeric), 320), 4096);
}

function getDesktopCaptureDisplays(): DesktopCaptureDisplayInfo[] {
  const primaryId = String(screen.getPrimaryDisplay().id);
  return screen.getAllDisplays().map((display) => ({
    id: String(display.id),
    label: display.label || undefined,
    bounds: display.bounds,
    workArea: display.workArea,
    scaleFactor: display.scaleFactor,
    rotation: display.rotation,
    internal: display.internal,
    primary: String(display.id) === primaryId,
  }));
}

async function captureDesktop(payload: DesktopCapturePayload = {}) {
  const includeImage = payload.includeImage !== false;
  const includeWindows = payload.includeWindows === true;
  const maxWidth = clampDesktopCaptureMaxWidth(payload.maxWidth);
  const displays = getDesktopCaptureDisplays();
  const targetDisplay =
    displays.find((display) => display.id === payload.displayId) ||
    displays.find((display) => display.primary) ||
    displays[0];

  const targetWidth = targetDisplay?.bounds.width || maxWidth;
  const targetHeight = targetDisplay?.bounds.height || Math.round(maxWidth * 0.625);
  const scale = Math.min(1, maxWidth / Math.max(targetWidth, 1));
  const thumbnailSize = includeImage
    ? {
        width: Math.max(1, Math.round(targetWidth * scale)),
        height: Math.max(1, Math.round(targetHeight * scale)),
      }
    : { width: 1, height: 1 };

  let windowSourceError: string | undefined;
  const windowSources = includeWindows
    ? await desktopCapturer
        .getSources({
          types: ['window'],
          thumbnailSize: { width: 1, height: 1 },
          fetchWindowIcons: false,
        })
        .then((sources) =>
          sources
            .filter((source) => source.id.startsWith('window:'))
            .map((source) => ({
              id: source.id,
              name: source.name,
            })),
        )
        .catch((err) => {
          windowSourceError = formatError(err);
          return undefined;
        })
    : undefined;

  if (!includeImage) {
    return {
      ok: true,
      capturedAt: new Date().toISOString(),
      platform: process.platform,
      screenPermission:
        process.platform === 'darwin'
          ? systemPreferences.getMediaAccessStatus('screen')
          : undefined,
      displays,
      windows: windowSources,
      details: windowSourceError
        ? getMacScreenCaptureDiagnostics(`windowSourceError=${windowSourceError}`)
        : undefined,
    };
  }

  let screenSources: Electron.DesktopCapturerSource[];
  try {
    screenSources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize,
    });
  } catch (err) {
    const desktopCapturerError = formatError(err);
    if (isMac) {
      return captureDesktopWithMacScreencapture({
        targetDisplay,
        displays,
        windows: windowSources,
        maxWidth,
        desktopCapturerError,
        windowSourceError,
      });
    }

    return {
      ok: false,
      error: 'Failed to get desktop screen sources.',
      details: desktopCapturerError,
      displays,
      windows: windowSources,
    };
  }

  const source =
    screenSources.find((item) => item.display_id === targetDisplay?.id) ||
    screenSources[0];
  if (!source) {
    return {
      ok: false,
      error: 'No desktop screen source is available.',
      details: getMacScreenCaptureDiagnostics(
        windowSourceError ? `windowSourceError=${windowSourceError}` : undefined,
      ),
      displays,
      windows: windowSources,
    };
  }

  const png = source.thumbnail.toPNG();
  const size = source.thumbnail.getSize();
  if (png.length === 0 || size.width === 0 || size.height === 0) {
    return {
      ok: false,
      error: 'Desktop capture returned an empty image.',
      details:
        process.platform === 'darwin'
          ? getMacScreenCaptureDiagnostics(
              windowSourceError
                ? `windowSourceError=${windowSourceError}`
                : undefined,
            )
          : undefined,
      displays,
      windows: windowSources,
    };
  }

  return {
    ok: true,
    capturedAt: new Date().toISOString(),
    platform: process.platform,
    screenPermission:
      process.platform === 'darwin'
        ? systemPreferences.getMediaAccessStatus('screen')
        : undefined,
    displays,
    windows: windowSources,
    imageBase64: png.toString('base64'),
    mimeType: 'image/png',
    width: size.width,
    height: size.height,
    displayId: source.display_id || targetDisplay?.id,
    details: windowSourceError
      ? getMacScreenCaptureDiagnostics(`windowSourceError=${windowSourceError}`)
      : undefined,
  };
}

function bringMainWindowToFront(): void {
  if (!mainWindow) return;

  if (isMac) {
    app.focus({ steal: true });
  }

  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.moveTop();
  mainWindow.focus();
}

function sendWorkstationOpenTarget(url: string): void {
  if (!mainWindow) return;
  try {
    if (!new URL(url).searchParams.get('assistantTarget')) return;
  } catch {
    return;
  }

  const send = () => {
    mainWindow?.webContents.send('open-workstation-target', { url });
  };

  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', send);
    return;
  }

  send();
}

function openWorkstationInClient(target?: string): void {
  const url = normalizeWorkstationUrl(target);
  pendingWorkstationOpenUrl = url;

  if (!app.isReady()) return;

  if (!mainWindow) {
    createWindow(url);
    return;
  }

  bringMainWindowToFront();
  sendWorkstationOpenTarget(url);
}

function bringWindowToFront(win: BrowserWindow | null): void {
  if (!win) return;

  if (isMac) {
    app.focus({ steal: true });
  }

  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.moveTop();
  win.focus();
}

function placeWindowOnPrimaryDisplay(win: BrowserWindow): void {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { x, y, width, height } = primaryDisplay.workArea;
  const bounds = win.getBounds();
  const targetX = Math.round(x + (width - bounds.width) / 2);
  const targetY = Math.round(y + Math.max((height - bounds.height) * 0.18, 28));
  win.setPosition(targetX, targetY);
}

function createQuickChatWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 320,
    minWidth: 640,
    maxWidth: 840,
    minHeight: 260,
    maxHeight: 420,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'MixClaw Quick Chat',
    backgroundColor: '#00000000',
    vibrancy: isMac ? 'under-window' : undefined,
    visualEffectState: isMac ? 'active' : undefined,
    webPreferences: {
      preload: path.join(mainDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadURL(QUICK_CHAT_URL);
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    // Prevent Electron from switching the app to UIElement mode, which
    // makes the Dock icon disappear after the quick chat window is shown.
    skipTransformProcessType: true,
  });

  win.on('blur', () => {
    if (!isQuitting) {
      win.hide();
    }
  });

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    quickChatWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  return win;
}

function showQuickChatWindow(): void {
  if (!quickChatWindow) {
    quickChatWindow = createQuickChatWindow();
  }
  placeWindowOnPrimaryDisplay(quickChatWindow);
  bringWindowToFront(quickChatWindow);
}

function hideQuickChatWindow(): void {
  if (quickChatWindow && quickChatWindow.isVisible()) {
    quickChatWindow.hide();
  }
}

function toggleQuickChat(): void {
  if (quickChatWindow?.isVisible()) {
    hideQuickChatWindow();
    return;
  }
  showQuickChatWindow();
}

function createWindow(initialUrl: string = WORKSTATION_URL): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'MixClaw',
    backgroundColor: '#f0f2f5',
    webPreferences: {
      preload: path.join(mainDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Load the NanoClaw web channel UI
  mainWindow.loadURL(normalizeWorkstationUrl(initialUrl));

  // Show window when ready to prevent white flash
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Intercept close — hide instead of quitting (NanoClaw daemon continues running)
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open external links in browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Intercept app-level shortcuts and forward them into the renderer.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const isCyclePrimaryNavShortcut = isMac && input.type === 'keyDown' && input.meta && !input.control && !input.alt && !input.shift && input.key.toLowerCase() === 'q';
    const isToggleTodayPlanShortcut = isMac && input.type === 'keyDown' && input.meta && !input.control && !input.alt && !input.shift && input.key.toLowerCase() === 'w';

    if (isCyclePrimaryNavShortcut) {
      event.preventDefault();
      mainWindow?.webContents.send('cycle-primary-nav');
      return;
    }

    if (isToggleTodayPlanShortcut) {
      event.preventDefault();
      mainWindow?.webContents.send('toggle-today-plan');
    }
  });
}
function buildAppMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: `About ${app.name}`, role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Quit App Only',
                click: () => {
                  // Only quit the Electron UI — NanoClaw daemon keeps running
                  isQuitting = false;
                  mainWindow?.hide();
                },
              },
              {
                label: 'Quit All (Support Group + App)',
                click: () => {
                  // Full quit: stop NanoClaw then quit Electron
                  isQuitting = true;
                  fetch('http://localhost:3000/api/shutdown', {
                    method: 'POST',
                  }).catch(() => {
                    // NanoClaw might not have the shutdown endpoint; just quit anyway
                  });
                  // Give NanoClaw a moment to shut down gracefully
                  setTimeout(() => {
                    app.quit();
                  }, 1500);
                },
              },
              { type: 'separator' as const },
              { label: 'Hide Support Group', role: 'hide' as const },
              { label: 'Hide Others', role: 'hideOthers' as const },
              { label: 'Show All', role: 'unhide' as const },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),

    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', role: 'undo' as const },
        { label: 'Redo', role: 'redo' as const },
        { type: 'separator' },
        { label: 'Cut', role: 'cut' as const },
        { label: 'Copy', role: 'copy' as const },
        { label: 'Paste', role: 'paste' as const },
        { label: 'Select All', role: 'selectAll' as const },
      ],
    },

    // View menu
    {
      label: 'View',
      submenu: [
        { label: 'Reload', role: 'reload' as const },
        { label: 'Force Reload', role: 'forceReload' as const },
        { label: 'Toggle DevTools', role: 'toggleDevTools' as const },
        { type: 'separator' },
        { label: 'Actual Size', role: 'resetZoom' as const },
        { label: 'Zoom In', role: 'zoomIn' as const },
        { label: 'Zoom Out', role: 'zoomOut' as const },
        { type: 'separator' },
        { label: 'Toggle Full Screen', role: 'togglefullscreen' as const },
      ],
    },

    // Window menu
    {
      label: 'Window',
      submenu: [
        { label: 'Minimize', role: 'minimize' as const },
        { label: 'Zoom', role: 'zoom' as const },
        ...(isMac
          ? [{ type: 'separator' as const }, { label: 'Bring All to Front', role: 'front' as const }]
          : [{ label: 'Close', role: 'close' as const }]),
      ],
    },

    // Help menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'Support Group Docs',
          click: () => {
            shell.openExternal('https://github.com/qwibitai/nanoclaw');
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

// Dock icon click (macOS) — show window
app.on('activate', () => {
  if (!gotSingleInstanceLock) return;
  if (mainWindow === null) {
    createWindow(pendingWorkstationOpenUrl);
  } else {
    bringMainWindowToFront();
  }
});

// macOS: handle dock menu or app menu Quit while window is hidden
app.on('before-quit', () => {
  isQuitting = true;
});

// Electron ready
app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  Menu.setApplicationMenu(buildAppMenu());
  createWindow(pendingWorkstationOpenUrl);
  globalShortcut.register(QUICK_CHAT_SHORTCUT, () => {
    toggleQuickChat();
  });

  ipcMain.on('show-main-window', () => {
    bringMainWindowToFront();
  });

  ipcMain.on('quick-chat-open-main-group', () => {
    bringMainWindowToFront();
    mainWindow?.webContents.send('quick-chat-open-main-group');
    hideQuickChatWindow();
  });

  // Handle open-file IPC from renderer
  ipcMain.handle('open-file', async (_event, filePath: string) => {
    try {
      const result = await shell.openPath(filePath);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // Handle open-file-with: triggers OS app picker
  ipcMain.handle('open-file-with', async (_event, filePath: string) => {
    try {
      if (process.platform === 'darwin') {
        // macOS: list all .app bundles from /Applications and let user choose
        const script = 'set appPaths to paragraphs of (do shell script "ls -d /Applications/*.app ~/Applications/*.app 2>/dev/null || true")\n'
          + 'set appNames to {}\n'
          + 'repeat with p in appPaths\n'
          + '  set end of appNames to (do shell script "basename " & quoted form of p & " .app")\n'
          + 'end repeat\n'
          + 'choose from list appNames with prompt "Open with:" with title "Choose Application"';
        execFile('osascript', ['-e', script], (err, stdout) => {
          if (err || !stdout.trim() || stdout.trim() === 'false') return;
          const appName = stdout.trim();
          execFile('open', ['-a', appName, filePath]);
        });
        return { ok: true };
      }
      // Linux
      execFile('mimeopen', ['-d', [filePath]]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // Handle show-in-folder
  ipcMain.handle('show-in-folder', async (_event, filePath: string) => {
    try {
      shell.showItemInFolder(filePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle('desktop-capture', async (_event, payload: DesktopCapturePayload) => {
    try {
      return await captureDesktop(payload || {});
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // Handle native system notifications from renderer via preload bridge.
  ipcMain.on('show-notification', (_event, payload: ShowNotificationPayload) => {
    if (!Notification.isSupported()) return;
    // Avoid duplicate disturbance when app window is already foregrounded.
    if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) return;

    const title = typeof payload?.title === 'string' ? payload.title : 'NanoClaw';
    const body = typeof payload?.body === 'string' ? payload.body : '';
    const notification = new Notification({ title, body });
    notification.on('click', () => {
      if (mainWindow) {
        bringMainWindowToFront();
        const meta = payload?.meta || {};
        const chatJid = meta.chatJid;
        const taskId = meta.taskId;
        if (
          (typeof chatJid === 'string' && chatJid.length > 0) ||
          (typeof taskId === 'string' && taskId.length > 0)
        ) {
          mainWindow.webContents.send('notification-clicked', { chatJid, taskId });
        }
      }
    });
    notification.show();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit();
  }
});
