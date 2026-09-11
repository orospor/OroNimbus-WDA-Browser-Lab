const path = require('node:path');
const startFullscreen = process.argv.includes('--fullscreen');
const watchdogEnabled = process.argv.includes('--watchdog');
const dllSearchHardeningRequested = process.argv.includes('--harden-dll-search');
const moduleMonitorEnabled = process.argv.includes('--module-monitor');
const cigRequested = process.argv.includes('--cig');
const processTopologyEnabled = process.argv.includes('--process-topology');
let nativeBridge;

function nativeAssetPath(fileName) {
  const nativeDirectory = path.basename(__dirname).toLowerCase() === 'app.asar'
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'native')
    : path.join(__dirname, 'native');
  return path.join(nativeDirectory, fileName);
}

function loadNativeBridge() {
  nativeBridge ??= require(nativeAssetPath('wda_native.node'));
  return nativeBridge;
}

let earlyDllSearchHardening = null;
let earlyCig = null;
if (dllSearchHardeningRequested || cigRequested) {
  try {
    const bridge = loadNativeBridge();
    if (dllSearchHardeningRequested) {
      // Run before loading Electron's JavaScript API. The Electron executable and
      // this native addon are necessarily already loaded, so this fixture protects
      // subsequent DLL searches rather than claiming pre-bootstrap coverage.
      earlyDllSearchHardening = bridge.hardenDllSearch();
    }
    if (cigRequested) {
      // This is real process-local CIG, but deliberately post-bootstrap: a strict
      // creation-time Microsoft-only policy would block the unsigned Electron
      // runtime and native addon before a usable WDA lab could exist.
      earlyCig = bridge.enableCig();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (dllSearchHardeningRequested && !earlyDllSearchHardening) {
      earlyDllSearchHardening = { error: message };
    }
    if (cigRequested && !earlyCig) {
      earlyCig = {
        requested: true,
        setAttempted: false,
        setOk: false,
        getOk: false,
        effective: false,
        error: message,
        timing: 'post-electron-executable-bootstrap',
        scope: 'electron-main-wda-owner-only',
        irreversibleForProcess: true,
      };
    }
  }
}

const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  shell,
} = require('electron');

// Make Chromium sandboxing explicit for every renderer spawned by this lab.
app.enableSandbox();

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
const PROCESS_TOPOLOGY_INTERVAL_MS = 1500;
const MAX_MODULE_EVENTS = 20;
const MAX_PROCESS_EVENTS = 20;
const BASE_TOOLBAR_HEIGHT = 106;
const MODULE_PANEL_HEIGHT = 190;
const PROCESS_PANEL_HEIGHT = 250;
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
let processTopologyTimer;
let modulePanelOpen = false;
let processPanelOpen = false;
const knownModulePaths = new Set();
const processEvents = [];
const knownRendererPids = new Map();
let cachedCigProbe = null;
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
  cigRequested,
  cig: earlyCig,
  cigProbe: null,
  cigScope: 'electron-main-wda-owner-only',
  cigTiming: 'post-electron-executable-bootstrap',
  cigCanDisableLive: false,
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
  processTopologyEnabled,
  processTopologyScope: 'oronimbus-electron-tree',
  processTopologyIntervalMs: processTopologyEnabled
    ? PROCESS_TOPOLOGY_INTERVAL_MS
    : null,
  processTopologyLastScanAt: null,
  processTopologyLastError: null,
  processTopologyCount: 0,
  processTopologyRoles: {},
  processTopologyProcesses: [],
  processTopologyEvents: [],
};

function send(channel, value) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (contents.isDestroyed()) return;
  try {
    contents.send(channel, value);
  } catch (error) {
    console.warn('[OroNimbus IPC send]', error instanceof Error ? error.message : String(error));
  }
}

function updateWindowTitle() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const titleState = protectionState.error
    ? `ERROR: ${protectionState.error}`
    : `${protectionState.matchesRequested ? 'MATCH' : 'DRIFT'} / read 0x${Number(protectionState.readback ?? 0).toString(16)}`;
  const signaturePolicyEffective = Boolean(
    protectionState.cig?.getOk && protectionState.cig?.signaturePolicyEffective,
  );
  const microsoftPolicyEffective = Boolean(
    protectionState.cig?.getOk && protectionState.cig?.microsoftSignedOnlyEffective,
  );
  const cigState = cigRequested
    ? (microsoftPolicyEffective ? 'CIG MS ON' : (signaturePolicyEffective ? 'CIG OTHER POLICY' : 'CIG FAILED'))
    : (signaturePolicyEffective ? 'CIG PRE-EXISTING' : 'CIG OFF');
  const windowMode = mainWindow.isFullScreen() ? 'FULLSCREEN' : 'WINDOWED';
  mainWindow.setTitle(`OroNimbus — ${process.arch} — ${protectionState.requestedMode.toUpperCase()} — ${cigState} — ${windowMode} — ${titleState}`);
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
    + (modulePanelOpen ? MODULE_PANEL_HEIGHT : 0)
    + (processPanelOpen ? PROCESS_PANEL_HEIGHT : 0);
  browserSurface.setBounds({
    x: 0,
    y: toolbarHeight,
    width: Math.max(1, bounds.width),
    height: Math.max(1, bounds.height - toolbarHeight),
  });
}

function refreshCigReadback({ runProbe = false } = {}) {
  try {
    const bridge = loadNativeBridge();
    const inspected = bridge.inspectCig();
    if (runProbe && !cachedCigProbe) {
      try {
        cachedCigProbe = bridge.probeImageLoad();
      } catch (error) {
        cachedCigProbe = {
          attempted: false,
          loaded: false,
          blockedByCodeIntegrity: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    protectionState = {
      ...protectionState,
      cig: {
        ...inspected,
        requested: cigRequested,
        setAttempted: earlyCig?.setAttempted ?? false,
        setOk: earlyCig?.setOk ?? false,
        setLastError: earlyCig?.setLastError ?? null,
        beforeFlags: earlyCig?.beforeFlags ?? inspected.beforeFlags,
        preexisting: earlyCig?.preexisting ?? inspected.preexisting,
        timing: earlyCig?.timing ?? 'inspection-only',
        scope: 'electron-main-wda-owner-only',
        irreversibleForProcess: true,
        error: earlyCig?.error ?? null,
      },
      cigProbe: cachedCigProbe,
    };
  } catch (error) {
    protectionState = {
      ...protectionState,
      cig: {
        ...(protectionState.cig ?? {}),
        requested: cigRequested,
        getOk: false,
        effective: false,
        error: error instanceof Error ? error.message : String(error),
        timing: 'post-electron-executable-bootstrap',
        scope: 'electron-main-wda-owner-only',
        irreversibleForProcess: true,
      },
      cigProbe: cachedCigProbe,
    };
  }
  return protectionState.cig;
}

function recordProcessEvent(event) {
  processEvents.unshift({
    observedAt: new Date().toISOString(),
    ...event,
  });
  processEvents.splice(MAX_PROCESS_EVENTS);
}

function processRole(metric, uiRendererPid, contentRendererPid) {
  if (metric.pid === process.pid) return 'Main / WDA window owner';
  if (metric.pid === uiRendererPid) return 'Lab UI renderer';
  if (metric.pid === contentRendererPid) return 'Web-content renderer';
  if (metric.type === 'GPU') return 'GPU compositor';
  if (metric.type === 'Utility') {
    return metric.name || metric.serviceName || 'Chromium utility service';
  }
  if (metric.type === 'Tab') return 'Renderer';
  return metric.name || metric.serviceName || metric.type || 'Unknown';
}

function sampleProcessTopology() {
  try {
    const uiRendererPid = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.webContents.getOSProcessId()
      : null;
    const contentRendererPid = browserSurface && !browserSurface.webContents.isDestroyed()
      ? browserSurface.webContents.getOSProcessId()
      : null;
    if (uiRendererPid > 0 && mainWindow && !mainWindow.isDestroyed()) {
      knownRendererPids.set(mainWindow.webContents.id, uiRendererPid);
    }
    if (contentRendererPid > 0 && browserSurface && !browserSurface.webContents.isDestroyed()) {
      knownRendererPids.set(browserSurface.webContents.id, contentRendererPid);
    }
    const metrics = app.getAppMetrics();
    const roles = {};
    const processes = metrics
      .map((metric) => {
        const role = processRole(metric, uiRendererPid, contentRendererPid);
        roles[metric.type] = (roles[metric.type] ?? 0) + 1;
        return {
          pid: metric.pid,
          creationTime: metric.creationTime,
          type: metric.type,
          role,
          serviceName: metric.serviceName ?? null,
          name: metric.name ?? null,
          sandboxed: metric.sandboxed ?? null,
          integrityLevel: metric.integrityLevel ?? null,
          cpuPercent: Number(metric.cpu?.percentCPUUsage ?? 0),
          workingSetKb: Number(metric.memory?.workingSetSize ?? 0),
          wdaOwner: metric.pid === process.pid,
        };
      })
      .sort((left, right) => (
        Number(right.wdaOwner) - Number(left.wdaOwner)
          || left.type.localeCompare(right.type)
          || left.pid - right.pid
      ));

    protectionState = {
      ...protectionState,
      processTopologyLastScanAt: new Date().toISOString(),
      processTopologyLastError: null,
      processTopologyCount: processes.length,
      processTopologyRoles: roles,
      processTopologyProcesses: processes,
      processTopologyEvents: [...processEvents],
    };
  } catch (error) {
    protectionState = {
      ...protectionState,
      processTopologyLastScanAt: new Date().toISOString(),
      processTopologyLastError: error instanceof Error ? error.message : String(error),
      processTopologyEvents: [...processEvents],
    };
  }
  send('lab:state', protectionState);
  return protectionState;
}

function startProcessTopology() {
  if (!processTopologyEnabled || processTopologyTimer) return;
  sampleProcessTopology();
  processTopologyTimer = setInterval(
    sampleProcessTopology,
    PROCESS_TOPOLOGY_INTERVAL_MS,
  );
}

app.on('render-process-gone', (_event, contents, details) => {
  const cachedPid = knownRendererPids.get(contents.id) ?? null;
  knownRendererPids.delete(contents.id);
  recordProcessEvent({
    kind: 'renderer-exit',
    pid: cachedPid,
    webContentsId: contents.id,
    reason: details.reason,
    exitCode: details.exitCode,
  });
  if (processTopologyEnabled) sampleProcessTopology();
});

app.on('child-process-gone', (_event, details) => {
  recordProcessEvent({
    kind: 'child-exit',
    pid: null,
    type: details.type,
    name: details.name,
    serviceName: details.serviceName,
    reason: details.reason,
    exitCode: details.exitCode,
  });
  if (processTopologyEnabled) sampleProcessTopology();
});

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
  refreshCigReadback({ runProbe: cigRequested });
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
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });

  browserSurface = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
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
    if (processTopologyTimer) {
      clearInterval(processTopologyTimer);
      processTopologyTimer = null;
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
      startProcessTopology();
    }, 100);
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  browserSurface.webContents.loadURL('https://example.com');
}

function assertTrustedSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('OroNimbus toolbar is not available');
  }
  const trustedContents = mainWindow.webContents;
  if (event.sender !== trustedContents || event.senderFrame !== trustedContents.mainFrame) {
    throw new Error('Rejected IPC from an untrusted renderer');
  }
}

function handleTrusted(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return handler(...args);
  });
}

handleTrusted('lab:get-state', () => ({
  ...protectionState,
  fullscreen: Boolean(mainWindow?.isFullScreen()),
}));
handleTrusted('lab:inspect', () => {
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
handleTrusted('lab:inspect-cig', () => {
  refreshCigReadback({ runProbe: true });
  updateWindowTitle();
  send('lab:state', protectionState);
  return protectionState;
});
handleTrusted('lab:clear-affinity', () => {
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
handleTrusted('lab:set-affinity-mode', (mode) => setAffinityMode(mode));
handleTrusted('lab:scan-modules', () => scanOwnModules({
  establishBaseline: !protectionState.moduleBaselineReady,
}));
handleTrusted('lab:set-module-panel-open', (open) => {
  modulePanelOpen = Boolean(open);
  layoutBrowserSurface();
  return modulePanelOpen;
});
handleTrusted('lab:scan-processes', () => sampleProcessTopology());
handleTrusted('lab:set-process-panel-open', (open) => {
  processPanelOpen = Boolean(open);
  layoutBrowserSurface();
  return processPanelOpen;
});
handleTrusted('browser:navigate', (value) => {
  const url = normalizeLocation(value);
  browserSurface.webContents.loadURL(url);
  return url;
});
handleTrusted('browser:back', () => {
  if (browserSurface.webContents.navigationHistory.canGoBack()) {
    browserSurface.webContents.navigationHistory.goBack();
  }
});
handleTrusted('browser:forward', () => {
  if (browserSurface.webContents.navigationHistory.canGoForward()) {
    browserSurface.webContents.navigationHistory.goForward();
  }
});
handleTrusted('browser:reload', () => browserSurface.webContents.reload());
handleTrusted('browser:external', (url) => shell.openExternal(normalizeLocation(url)));
handleTrusted('window:toggle-fullscreen', () => {
  const fullscreen = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(fullscreen);
  sendFullscreenState();
  return fullscreen;
});
handleTrusted('window:exit', () => {
  setImmediate(() => mainWindow?.close());
  return true;
});

app.setName('OroNimbus');
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
