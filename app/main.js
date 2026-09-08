const path = require('node:path');
const startFullscreen = process.argv.includes('--fullscreen');
const watchdogEnabled = process.argv.includes('--watchdog');
const dllSearchHardeningRequested = process.argv.includes('--harden-dll-search');
const moduleMonitorEnabled = process.argv.includes('--module-monitor');
let nativeBridge;

function loadNativeBridge() {
  nativeBridge ??= require(path.join(__dirname, 'native', 'wda_native.node'));
  return nativeBridge;
}

let earlyDllSearchHardening = null;
if (dllSearchHardeningRequested) {
  try {
    // Run before loading Electron's JavaScript API. The Electron executable and
    // this native addon are necessarily already loaded, so this fixture protects
    // subsequent DLL searches rather than claiming pre-bootstrap coverage.
    earlyDllSearchHardening = loadNativeBridge().hardenDllSearch();
  } catch (error) {
    earlyDllSearchHardening = {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

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
const WATCHDOG_INTERVAL_MS = 3000;
const MODULE_MONITOR_INTERVAL_MS = 2000;
const MAX_MODULE_EVENTS = 20;
const BASE_TOOLBAR_HEIGHT = 106;
const MODULE_PANEL_HEIGHT = 190;
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
let watchdogTimer;
let moduleMonitorTimer;
let modulePanelOpen = false;
const knownModulePaths = new Set();
let protectionState = {
  launchMode: requestedMode,
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
  matchesRequested: false,
  error: null,
  watchdogEnabled,
  watchdogIntervalMs: watchdogEnabled ? WATCHDOG_INTERVAL_MS : null,
  watchdogChecks: 0,
  watchdogRepairAttempts: 0,
  watchdogRepairs: 0,
  watchdogLastCheckAt: null,
  watchdogLastReadback: null,
  watchdogLastError: null,
  dllSearchHardeningRequested,
  dllSearchHardening: earlyDllSearchHardening,
  runtimeModeChanges: 0,
  lastModeChangeAt: null,
  moduleMonitorEnabled,
  moduleScope: 'electron-main-process',
  moduleMonitorIntervalMs: moduleMonitorEnabled ? MODULE_MONITOR_INTERVAL_MS : null,
  moduleBaselineReady: false,
  moduleBaselineAt: null,
  moduleBaselineCount: null,
  moduleCurrentCount: null,
  moduleScanCount: 0,
  moduleAppDirectory: path.dirname(process.execPath),
  moduleWindowsDirectory: null,
  moduleOtherPathBaseline: 0,
  moduleBaselineOtherPathEntries: [],
  moduleFirstSeen: 0,
  moduleOtherPathFirstSeen: 0,
  moduleLastScanAt: null,
  moduleLastError: null,
  moduleRecentEvents: [],
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
    : `${protectionState.matchesRequested ? 'MATCH' : 'DRIFT'} / read 0x${Number(protectionState.readback ?? 0).toString(16)}`;
  const windowMode = mainWindow.isFullScreen() ? 'FULLSCREEN' : 'WINDOWED';
  mainWindow.setTitle(`OroNimbus — ${protectionState.requestedMode.toUpperCase()} — ${windowMode} — ${titleState}`);
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
  const toolbarHeight = BASE_TOOLBAR_HEIGHT
    + (modulePanelOpen ? MODULE_PANEL_HEIGHT : 0);
  browserSurface.setBounds({
    x: 0,
    y: toolbarHeight,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height - toolbarHeight),
  });
}

function applyRequestedAffinity() {
  try {
    const expected = protectionState.requestedValue;
    const result = loadNativeBridge().apply(
      mainWindow.getNativeWindowHandle(),
      expected,
    );
    protectionState = {
      ...protectionState,
      setOk: result.setOk,
      getOk: result.getOk,
      readback: result.affinity,
      setLastError: result.setLastError,
      getLastError: result.getLastError,
      matchesRequested: result.getOk && result.affinity === expected,
      error: null,
    };
  } catch (error) {
    protectionState = {
      ...protectionState,
      setOk: false,
      getOk: false,
      readback: null,
      setLastError: null,
      getLastError: null,
      matchesRequested: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  updateWindowTitle();
  console.log('[OroNimbus WDA]', JSON.stringify(protectionState));
  send('lab:state', protectionState);
}

function runAffinityWatchdog() {
  if (!watchdogEnabled || !mainWindow || mainWindow.isDestroyed()) return;

  try {
    const bridge = loadNativeBridge();
    const handle = mainWindow.getNativeWindowHandle();
    const inspected = bridge.inspect(handle);
    const expected = protectionState.requestedValue;
    const drifted = !inspected.getOk || inspected.affinity !== expected;
    let nextState = {
      ...protectionState,
      getOk: inspected.getOk,
      readback: inspected.affinity,
      getLastError: inspected.getLastError,
      matchesRequested: inspected.getOk && inspected.affinity === expected,
      watchdogChecks: protectionState.watchdogChecks + 1,
      watchdogLastCheckAt: new Date().toISOString(),
      watchdogLastReadback: inspected.affinity,
      watchdogLastError: inspected.getOk ? null : inspected.getLastError,
      error: null,
    };

    if (drifted) {
      const repaired = bridge.apply(handle, expected);
      const repairSucceeded = repaired.setOk
        && repaired.getOk
        && repaired.affinity === expected;
      nextState = {
        ...nextState,
        setOk: repaired.setOk,
        getOk: repaired.getOk,
        readback: repaired.affinity,
        setLastError: repaired.setLastError,
        getLastError: repaired.getLastError,
        matchesRequested: repaired.getOk && repaired.affinity === expected,
        watchdogRepairAttempts: protectionState.watchdogRepairAttempts + 1,
        watchdogRepairs: protectionState.watchdogRepairs + (repairSucceeded ? 1 : 0),
        watchdogLastError: repairSucceeded
          ? null
          : (repaired.setLastError || repaired.getLastError),
      };
    }
    protectionState = nextState;
  } catch (error) {
    protectionState = {
      ...protectionState,
      getOk: false,
      readback: null,
      getLastError: null,
      matchesRequested: false,
      watchdogChecks: protectionState.watchdogChecks + 1,
      watchdogLastCheckAt: new Date().toISOString(),
      watchdogLastReadback: null,
      watchdogLastError: error instanceof Error ? error.message : String(error),
    };
  }

  updateWindowTitle();
  console.log('[OroNimbus watchdog]', JSON.stringify(protectionState));
  send('lab:state', protectionState);
}

function startAffinityWatchdog() {
  if (!watchdogEnabled || watchdogTimer) return;
  watchdogTimer = setInterval(runAffinityWatchdog, WATCHDOG_INTERVAL_MS);
}

function setAffinityMode(mode, source = 'runtime-ui') {
  const normalized = String(mode ?? '').toLowerCase();
  if (!Object.hasOwn(WDA, normalized)) {
    throw new Error(`Unsupported WDA mode: ${mode}`);
  }
  protectionState = {
    ...protectionState,
    requestedMode: normalized,
    requestedValue: WDA[normalized],
    runtimeModeChanges: protectionState.runtimeModeChanges + 1,
    lastModeChangeAt: new Date().toISOString(),
    lastModeChangeSource: source,
  };
  applyRequestedAffinity();
  return protectionState;
}

function normalizedModulePath(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  let normalized = path.win32.normalize(text).toLowerCase();
  if (normalized[0] === '\\'
      && normalized[1] === '\\'
      && normalized[2] === '?'
      && normalized[3] === '\\') {
    normalized = normalized.slice(4);
    if (normalized.startsWith('unc\\')) {
      normalized = `\\\\${normalized.slice(4)}`;
    }
  }
  return normalized;
}

function pathIsWithin(root, candidate) {
  const normalizedRoot = normalizedModulePath(root).replace(/[\\/]+$/, '');
  const normalizedCandidate = normalizedModulePath(candidate);
  return Boolean(
    normalizedRoot
    && normalizedCandidate
    && (normalizedCandidate === normalizedRoot
      || normalizedCandidate.startsWith(`${normalizedRoot}\\`)),
  );
}

function classifyModule(modulePath, windowsDirectory) {
  if (!modulePath) return 'unknown-path';
  if (pathIsWithin(path.dirname(process.execPath), modulePath)) return 'application';
  if (pathIsWithin(windowsDirectory, modulePath)) return 'windows';
  return 'other-path';
}

function scanOwnModules({ establishBaseline = false } = {}) {
  try {
    const result = loadNativeBridge().listModules();
    if (!result?.ok || !Array.isArray(result.modules)) {
      protectionState = {
        ...protectionState,
        moduleLastScanAt: new Date().toISOString(),
        moduleLastError: result?.lastError ?? 'Module enumeration failed',
      };
      send('lab:state', protectionState);
      return protectionState;
    }

    const modulesByPath = new Map();
    for (const module of result.modules) {
      const key = normalizedModulePath(module.path)
        || `name:${String(module.name ?? '').toLowerCase()}`;
      if (!modulesByPath.has(key)) modulesByPath.set(key, module);
    }
    const modules = [...modulesByPath.entries()];
    const baseline = establishBaseline || !protectionState.moduleBaselineReady;
    const windowsDirectory = result.windowsDirectory || null;
    const scannedAt = new Date().toISOString();

    if (baseline) {
      knownModulePaths.clear();
      for (const [key] of modules) knownModulePaths.add(key);
      const baselineOtherPathModules = modules.filter(([, module]) => (
        classifyModule(module.path, windowsDirectory) === 'other-path'
      ));
      const baselineOtherPathEntries = baselineOtherPathModules
        .map(([, module]) => ({
          name: module.name,
          path: module.path,
          classification: 'other-path',
          observedAt: scannedAt,
          presentAtBaseline: true,
        }))
        .slice(0, MAX_MODULE_EVENTS);
      protectionState = {
        ...protectionState,
        moduleBaselineReady: true,
        moduleBaselineAt: scannedAt,
        moduleBaselineCount: modules.length,
        moduleCurrentCount: modules.length,
        moduleScanCount: protectionState.moduleScanCount + 1,
        moduleWindowsDirectory: windowsDirectory,
        moduleOtherPathBaseline: baselineOtherPathModules.length,
        moduleBaselineOtherPathEntries: baselineOtherPathEntries,
        moduleFirstSeen: 0,
        moduleOtherPathFirstSeen: 0,
        moduleLastScanAt: scannedAt,
        moduleLastError: null,
        moduleRecentEvents: [],
      };
    } else {
      const observedAt = scannedAt;
      const newModules = modules.filter(([key]) => !knownModulePaths.has(key));
      for (const [key] of modules) knownModulePaths.add(key);
      const events = newModules.map(([, module]) => ({
        name: module.name,
        path: module.path,
        classification: classifyModule(module.path, windowsDirectory),
        observedAt,
      }));
      const otherPathFirstSeen = events.filter(
        (event) => event.classification === 'other-path',
      ).length;
      protectionState = {
        ...protectionState,
        moduleCurrentCount: modules.length,
        moduleScanCount: protectionState.moduleScanCount + 1,
        moduleWindowsDirectory: windowsDirectory,
        moduleFirstSeen: protectionState.moduleFirstSeen + events.length,
        moduleOtherPathFirstSeen:
          protectionState.moduleOtherPathFirstSeen + otherPathFirstSeen,
        moduleLastScanAt: observedAt,
        moduleLastError: null,
        moduleRecentEvents: [
          ...events.reverse(),
          ...protectionState.moduleRecentEvents,
        ].slice(0, MAX_MODULE_EVENTS),
      };
    }
  } catch (error) {
    protectionState = {
      ...protectionState,
      moduleLastScanAt: new Date().toISOString(),
      moduleLastError: error instanceof Error ? error.message : String(error),
    };
  }
  send('lab:state', protectionState);
  return protectionState;
}

function startModuleMonitor() {
  if (!moduleMonitorEnabled || moduleMonitorTimer) return;
  scanOwnModules({
    establishBaseline: !protectionState.moduleBaselineReady,
  });
  moduleMonitorTimer = setInterval(
    () => scanOwnModules(),
    MODULE_MONITOR_INTERVAL_MS,
  );
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
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (moduleMonitorTimer) {
      clearInterval(moduleMonitorTimer);
      moduleMonitorTimer = null;
    }
    browserSurface?.webContents.close();
    browserSurface = null;
    mainWindow = null;
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    setTimeout(() => {
      applyRequestedAffinity();
      startAffinityWatchdog();
      startModuleMonitor();
    }, 100);
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
    const result = loadNativeBridge().inspect(mainWindow.getNativeWindowHandle());
    protectionState = {
      ...protectionState,
      getOk: result.getOk,
      readback: result.affinity,
      getLastError: result.getLastError,
      matchesRequested: result.getOk
        && result.affinity === protectionState.requestedValue,
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
ipcMain.handle('lab:clear-affinity', () => {
  try {
    const result = loadNativeBridge().apply(mainWindow.getNativeWindowHandle(), WDA.none);
    protectionState = {
      ...protectionState,
      setOk: result.setOk,
      getOk: result.getOk,
      readback: result.affinity,
      setLastError: result.setLastError,
      getLastError: result.getLastError,
      matchesRequested: result.getOk
        && result.affinity === protectionState.requestedValue,
      error: null,
    };
  } catch (error) {
    protectionState = {
      ...protectionState,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  updateWindowTitle();
  send('lab:state', protectionState);
  return protectionState;
});
ipcMain.handle('lab:set-affinity-mode', (_event, mode) => setAffinityMode(mode));
ipcMain.handle('lab:scan-modules', () => scanOwnModules({
  establishBaseline: !protectionState.moduleBaselineReady,
}));
ipcMain.handle('lab:set-module-panel-open', (_event, open) => {
  modulePanelOpen = Boolean(open);
  layoutBrowserSurface();
  return modulePanelOpen;
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
