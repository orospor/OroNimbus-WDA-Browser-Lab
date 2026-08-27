const path = require('node:path');
const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  shell,
} = require('electron');

const WDA = Object.freeze({
  none: 0x00,
  monitor: 0x01,
  exclude: 0x11,
});

const requestedMode = (() => {
  const argument = process.argv.find((value) => value.startsWith('--wda='));
  const mode = argument?.slice('--wda='.length).toLowerCase();
  return Object.hasOwn(WDA, mode) ? mode : 'none';
})();
const startFullscreen = process.argv.includes('--fullscreen');
const allowedProtocols = new Set(['http:', 'https:']);

// Keep remote debugging off by default. The explicit switch is honored only for
// automated verification of this controlled fixture.
const remoteDebugArgument = process.argv.find((value) => value.startsWith('--remote-debugging-port='));
if (remoteDebugArgument) {
  const port = remoteDebugArgument.slice('--remote-debugging-port='.length);
  if (/^\d{1,5}$/.test(port)) app.commandLine.appendSwitch('remote-debugging-port', port);
}

let mainWindow;
let browserSurface;
let nativeBridge;
let protectionState = {
  requestedMode,
  requestedValue: WDA[requestedMode],
  processName: path.basename(process.execPath),
  processPath: process.execPath,
  pid: process.pid,
  arch: process.arch,
  setOk: false,
  getOk: false,
  readback: null,
  setLastError: null,
  getLastError: null,
  error: null,
};

function send(channel, value) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, value);
  }
}

function updateWindowTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const titleState = protectionState.error
    ? `ERROR: ${protectionState.error}`
    : `${protectionState.setOk ? 'APPLIED' : 'FAILED'} / read 0x${Number(protectionState.readback ?? 0).toString(16)}`;
  const windowMode = mainWindow.isFullScreen() ? 'FULLSCREEN' : 'WINDOWED';
  mainWindow.setTitle(`OroNimbus — ${requestedMode.toUpperCase()} — ${windowMode} — ${titleState}`);
}

function sendFullscreenState() {
  updateWindowTitle();
  send('window:fullscreen', Boolean(mainWindow?.isFullScreen()));
}

function normalizeLocation(input) {
  const text = String(input ?? '').trim();
  if (!text) return 'https://example.com';

  try {
    const parsed = new URL(text);
    if (allowedProtocols.has(parsed.protocol)) return parsed.toString();
  } catch {}

  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(text)) {
    return `https://${text}`;
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(text)}`;
}

function layoutBrowserSurface() {
  if (!mainWindow || !browserSurface) return;
  const bounds = mainWindow.getContentBounds();
  const toolbarHeight = 106;
  browserSurface.setBounds({
    x: 0,
    y: toolbarHeight,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height - toolbarHeight),
  });
}

function applyRequestedAffinity() {
  try {
    nativeBridge ??= require(path.join(__dirname, 'native', 'wda_native.node'));
    const result = nativeBridge.apply(
      mainWindow.getNativeWindowHandle(),
      WDA[requestedMode],
    );
    protectionState = {
      ...protectionState,
      setOk: result.setOk,
      getOk: result.getOk,
      readback: result.affinity,
      setLastError: result.setLastError,
      getLastError: result.getLastError,
      error: null,
    };
  } catch (error) {
    protectionState = {
      ...protectionState,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  updateWindowTitle();
  console.log('[OroNimbus WDA]', JSON.stringify(protectionState));
  send('lab:state', protectionState);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 790,
    minWidth: 820,
    minHeight: 540,
    show: false,
    fullscreen: startFullscreen,
    title: `OroNimbus — ${requestedMode.toUpperCase()} WDA Lab`,
    backgroundColor: '#0b1018',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  browserSurface = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:oronimbus-lab',
    },
  });
  browserSurface.webContents.session.setPermissionCheckHandler(() => false);
  browserSurface.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  mainWindow.contentView.addChildView(browserSurface);
  layoutBrowserSurface();

  browserSurface.webContents.setWindowOpenHandler(({ url }) => {
    browserSurface.webContents.loadURL(normalizeLocation(url));
    return { action: 'deny' };
  });
  browserSurface.webContents.on('will-navigate', (event, url) => {
    try {
      if (!allowedProtocols.has(new URL(url).protocol)) {
        event.preventDefault();
        return;
      }
    } catch {
      event.preventDefault();
      return;
    }
    send('browser:location', url);
  });
  browserSurface.webContents.on('did-navigate', (_event, url) => {
    send('browser:location', url);
  });
  browserSurface.webContents.on('did-navigate-in-page', (_event, url) => {
    send('browser:location', url);
  });
  browserSurface.webContents.on('did-start-loading', () => {
    send('browser:loading', true);
  });
  browserSurface.webContents.on('did-stop-loading', () => {
    send('browser:loading', false);
  });

  mainWindow.on('resize', layoutBrowserSurface);
  mainWindow.on('enter-full-screen', sendFullscreenState);
  mainWindow.on('leave-full-screen', sendFullscreenState);
  mainWindow.on('closed', () => {
    browserSurface?.webContents.close();
    browserSurface = null;
    mainWindow = null;
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    setTimeout(applyRequestedAffinity, 100);
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  browserSurface.webContents.loadURL('https://example.com');
}

ipcMain.handle('lab:get-state', () => ({
  ...protectionState,
  fullscreen: Boolean(mainWindow?.isFullScreen()),
}));
ipcMain.handle('lab:inspect', () => {
  try {
    const result = nativeBridge.inspect(mainWindow.getNativeWindowHandle());
    protectionState = {
      ...protectionState,
      getOk: result.getOk,
      readback: result.affinity,
      getLastError: result.getLastError,
      error: null,
    };
  } catch (error) {
    protectionState = {
      ...protectionState,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  send('lab:state', protectionState);
  return protectionState;
});
ipcMain.handle('browser:navigate', (_event, value) => {
  const url = normalizeLocation(value);
  browserSurface.webContents.loadURL(url);
  return url;
});
ipcMain.handle('browser:back', () => {
  if (browserSurface.webContents.navigationHistory.canGoBack()) {
    browserSurface.webContents.navigationHistory.goBack();
  }
});
ipcMain.handle('browser:forward', () => {
  if (browserSurface.webContents.navigationHistory.canGoForward()) {
    browserSurface.webContents.navigationHistory.goForward();
  }
});
ipcMain.handle('browser:reload', () => browserSurface.webContents.reload());
ipcMain.handle('browser:external', (_event, url) => shell.openExternal(normalizeLocation(url)));
ipcMain.handle('window:toggle-fullscreen', () => {
  const fullscreen = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(fullscreen);
  sendFullscreenState();
  return fullscreen;
});
ipcMain.handle('window:exit', () => {
  setImmediate(() => mainWindow?.close());
  return true;
});

app.setName('OroNimbus');
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
