import { app, BrowserWindow, Menu, MenuItemConstructorOptions, shell, ipcMain, Notification } from 'electron';
import path from 'path';

// CJS: use native __dirname; ESM: use import.meta.url
const _dir = typeof __dirname !== 'undefined'
  ? __dirname
  : path.dirname(String(import.meta.url));

// Track whether we're doing a full quit (Quit All) vs just hiding
let isQuitting = false;
let mainWindow: BrowserWindow | null = null;

const isMac = process.platform === 'darwin';

interface ShowNotificationPayload {
  title: string;
  body: string;
  meta?: {
    chatJid?: string;
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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 600,
    minHeight: 400,
    title: 'MixClaw',
    backgroundColor: '#f0f2f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Load the NanoClaw web channel UI
  mainWindow.loadURL('http://localhost:3000');

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
  if (mainWindow === null) {
    createWindow();
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
  Menu.setApplicationMenu(buildAppMenu());
  createWindow();

  // Handle open-file IPC from renderer
  ipcMain.handle('open-file', async (_event, filePath: string) => {
    try {
      const result = await shell.openPath(filePath);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: String(err) };
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
        const chatJid = payload?.meta?.chatJid;
        if (typeof chatJid === 'string' && chatJid.length > 0) {
          mainWindow.webContents.send('notification-clicked', { chatJid });
        }
      }
    });
    notification.show();
  });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
  if (!isMac) {
    app.quit();
  }
});
