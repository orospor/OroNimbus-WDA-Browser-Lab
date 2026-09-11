const form = document.querySelector('#location-form');
const locationInput = document.querySelector('#location');
const mode = document.querySelector('#mode');
const readback = document.querySelector('#readback');
const defenses = document.querySelector('#defenses');
const processLabel = document.querySelector('#process');
const reload = document.querySelector('#reload');
const liveWdaMode = document.querySelector('#live-wda-mode');
const toggleWdaButton = document.querySelector('#toggle-wda');
const cigInspectButton = document.querySelector('#cig-inspect');
const moduleScanButton = document.querySelector('#module-scan');
const modulePanel = document.querySelector('#module-panel');
const modulePanelClose = document.querySelector('#module-panel-close');
const moduleSummary = document.querySelector('#module-summary');
const moduleEvents = document.querySelector('#module-events');
const processMapButton = document.querySelector('#process-map');
const processPanel = document.querySelector('#process-panel');
const processPanelClose = document.querySelector('#process-panel-close');
const processSummary = document.querySelector('#process-summary');
const processRows = document.querySelector('#process-rows');
const fullscreenButton = document.querySelector('#fullscreen');
const exitButton = document.querySelector('#exit');
let fullscreenActive = false;
let currentState;
let wdaChangePending = false;
let modulePanelOpen = false;
let processPanelOpen = false;

const affinityLabel = (value) => ({
  0x00: 'WDA_NONE (0x00)',
  0x01: 'WDA_MONITOR (0x01)',
  0x11: 'WDA_EXCLUDEFROMCAPTURE (0x11)',
}[value] ?? `Unknown (0x${Number(value).toString(16)})`);

const moduleClassificationLabel = (value) => ({
  application: 'app tree',
  windows: 'Windows tree',
  'other-path': 'other path',
  'unknown-path': 'unknown path',
}[value] ?? 'unknown path');

function renderModulePanel(state) {
  if (state.moduleLastError) {
    moduleSummary.textContent = `Enumeration error: ${state.moduleLastError}`;
  } else if (!state.moduleBaselineReady) {
    moduleSummary.textContent = state.moduleMonitorEnabled
      ? 'Waiting for the main-process baseline…'
      : 'No baseline yet. Scan to inventory the main process.';
  } else {
    moduleSummary.textContent = [
      `PID ${state.pid}`,
      'main process only',
      `${state.moduleCurrentCount} current`,
      `${state.moduleBaselineCount} at baseline`,
      `${state.moduleOtherPathBaseline} other-path at baseline`,
      `${state.moduleFirstSeen} distinct first-seen`,
      `${state.moduleOtherPathFirstSeen} first-seen from other paths`,
      `${state.moduleScanCount} scans`,
    ].join(' · ');
  }

  moduleEvents.replaceChildren();
  const recentEvents = Array.isArray(state.moduleRecentEvents)
    ? state.moduleRecentEvents
    : [];
  const baselineEntries = Array.isArray(state.moduleBaselineOtherPathEntries)
    ? state.moduleBaselineOtherPathEntries
    : [];
  const events = [...recentEvents, ...baselineEntries].slice(0, 20);
  if (events.length === 0) {
    const item = document.createElement('li');
    item.textContent = state.moduleBaselineReady
      ? `No paths first observed after baseline ${state.moduleBaselineAt ?? ''}`
      : 'Recent events appear here after a baseline is established.';
    moduleEvents.append(item);
    return;
  }

  for (const event of events) {
    const item = document.createElement('li');
    const classification = document.createElement('span');
    classification.className = 'module-classification';
    const timing = event.presentAtBaseline ? 'present at baseline' : 'first-seen';
    const observedAt = event.observedAt
      ? new Date(event.observedAt).toLocaleTimeString()
      : 'time unavailable';
    classification.textContent = `[${moduleClassificationLabel(event.classification)} · ${timing} · ${observedAt}] `;
    const modulePath = document.createElement('code');
    modulePath.textContent = event.path || event.name || '(path unavailable)';
    item.append(classification, modulePath);
    moduleEvents.append(item);
  }
}

function renderProcessPanel(state) {
  const processes = Array.isArray(state.processTopologyProcesses)
    ? state.processTopologyProcesses
    : [];
  if (state.processTopologyLastError) {
    processSummary.textContent = `Metrics error: ${state.processTopologyLastError}`;
  } else if (processes.length === 0) {
    processSummary.textContent = state.processTopologyEnabled
      ? 'Waiting for Electron process metrics…'
      : 'Live sampling is off. Open this panel to take a manual sample.';
  } else {
    const roleCounts = Object.entries(state.processTopologyRoles ?? {})
      .map(([type, count]) => `${count} ${type}`)
      .join(' · ');
    processSummary.textContent = `${processes.length} OroNimbus processes · ${roleCounts} · updated ${new Date(state.processTopologyLastScanAt).toLocaleTimeString()}`;
  }

  processRows.replaceChildren();
  if (processes.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.textContent = 'No process metrics available yet.';
    row.append(cell);
    processRows.append(row);
    return;
  }

  for (const entry of processes) {
    const row = document.createElement('tr');
    if (entry.wdaOwner) row.className = 'wda-owner';
    const cigEffective = Boolean(
      state.cig?.getOk && state.cig?.signaturePolicyEffective,
    );
    const values = [
      entry.role,
      String(entry.pid),
      entry.type,
      entry.sandboxed === null ? 'n/a' : (entry.sandboxed ? 'yes' : 'no'),
      `${entry.cpuPercent.toFixed(1)}%`,
      `${(entry.workingSetKb / 1024).toFixed(1)} MiB`,
      entry.wdaOwner
        ? `WDA owner · CIG ${cigEffective ? 'active' : 'inactive'}`
        : 'Chromium child',
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    processRows.append(row);
  }
}

function renderState(state) {
  currentState = state;
  mode.textContent = state.error ? 'ERROR' : state.requestedMode.toUpperCase();
  mode.className = `mode ${state.error ? 'error' : state.requestedMode}`;
  readback.textContent = state.error
    ? state.error
    : `${state.matchesRequested ? 'Matched' : 'Drift detected'} · ${state.getOk ? affinityLabel(state.readback) : `read failed (${state.getLastError})`}`;
  processLabel.textContent = `WDA owner · PID ${state.pid} · ${state.arch}`;
  const hardening = state.dllSearchHardening;
  const hardeningOk = Boolean(
    hardening?.defaultDirectoriesOk && hardening?.currentDirectoryRemovedOk,
  );
  const watchdogLabel = state.watchdogEnabled
    ? `WD ${state.watchdogChecks} checks / ${state.watchdogRepairs} repairs`
    : 'Watchdog off';
  const hardeningLabel = state.dllSearchHardeningRequested
    ? `DLL search ${hardeningOk ? 'hardened' : 'failed'}`
    : 'DLL search baseline';
  const cig = state.cig;
  const cigProbe = state.cigProbe;
  const cigEffective = Boolean(cig?.getOk && cig?.signaturePolicyEffective);
  const microsoftPolicyEffective = Boolean(
    cig?.getOk && cig?.microsoftSignedOnlyEffective,
  );
  const exactPolicy = cig?.microsoftSignedOnly
    ? 'Microsoft-only'
    : (cig?.storeSignedOnly ? 'Store-only' : (cig?.mitigationOptIn ? 'Microsoft/Store/WHQL' : 'unknown'));
  const cigLabel = state.cigRequested
    ? (microsoftPolicyEffective ? 'CIG Microsoft-only' : (cigEffective ? `CIG ${exactPolicy}` : 'CIG failed'))
    : (cigEffective ? `CIG ${exactPolicy} pre-existing` : 'CIG off');
  defenses.textContent = `${watchdogLabel} · ${hardeningLabel} · ${cigLabel}`;
  defenses.className = `defenses ${state.watchdogEnabled || hardeningOk || cigEffective ? 'active' : ''}`;
  cigInspectButton.textContent = cigLabel;
  cigInspectButton.className = `wide ${cigEffective ? 'active' : (state.cigRequested ? 'notice' : '')}`;
  if (cig?.error) {
    cigInspectButton.title = `CIG error: ${cig.error}`;
  } else if (cigEffective) {
    const probeResult = cigProbe?.blockedByCodeIntegrity
      ? `unsigned probe blocked (Win32 ${cigProbe.loadLastError})`
      : 'unsigned probe did not prove blocking';
    cigInspectButton.title = `${exactPolicy} signature policy active · flags 0x${Number(cig?.flags ?? 0).toString(16)} · ${probeResult} · ${cig?.timing ?? 'unknown timing'} · verified on main/WDA-owner PID only · restart required to disable`;
  } else if (state.cigRequested) {
    cigInspectButton.title = `CIG was requested but is not effective · flags 0x${Number(cig?.flags ?? 0).toString(16)} · unsigned probe ${cigProbe?.loaded ? 'loaded' : 'did not load'}`;
  } else {
    cigInspectButton.title = `CIG not active · unsigned probe ${cigProbe?.loaded && cigProbe?.freed ? 'loaded and freed as expected' : 'not yet verified'} · click to refresh`;
  }
  if (state.requestedMode !== 'none') liveWdaMode.value = state.requestedMode;
  const protectedRequested = state.requestedMode !== 'none';
  const protectedEffective = protectedRequested
    && state.getOk
    && state.matchesRequested;
  toggleWdaButton.textContent = protectedRequested
    ? (protectedEffective ? 'Turn WDA off' : 'Cancel WDA request')
    : 'Turn WDA on';
  toggleWdaButton.className = `wide ${protectedEffective ? 'active' : (protectedRequested ? 'notice' : '')}`;

  const moduleError = state.moduleLastError;
  if (moduleError) {
    moduleScanButton.textContent = 'Modules error';
    moduleScanButton.className = 'wide notice';
    moduleScanButton.title = String(moduleError);
  } else if (!state.moduleBaselineReady) {
    moduleScanButton.textContent = state.moduleMonitorEnabled ? 'Modules starting' : 'Scan modules';
    moduleScanButton.className = `wide ${state.moduleMonitorEnabled ? 'active' : ''}`;
  } else {
    moduleScanButton.textContent = `Modules ${state.moduleFirstSeen} first-seen / ${state.moduleOtherPathFirstSeen} other-path`;
    moduleScanButton.className = `wide ${state.moduleOtherPathFirstSeen > 0 ? 'notice' : 'active'}`;
    const latest = state.moduleRecentEvents?.[0];
    moduleScanButton.title = latest
      ? `Latest first-seen module from ${moduleClassificationLabel(latest.classification)}: ${latest.path}`
      : `Baseline ${state.moduleBaselineCount}; ${state.moduleOtherPathBaseline} other-path modules at baseline. Main PID and loader-visible modules only; not proof of injection.`;
  }
  renderModulePanel(state);
  if (state.processTopologyLastError) {
    processMapButton.textContent = 'Processes error';
    processMapButton.className = 'wide notice';
  } else {
    processMapButton.textContent = `Processes ${state.processTopologyCount ?? 0}`;
    processMapButton.className = `wide ${state.processTopologyCount > 0 ? 'active' : ''}`;
  }
  renderProcessPanel(state);
  if (typeof state.fullscreen === 'boolean') {
    fullscreenActive = state.fullscreen;
    fullscreenButton.textContent = fullscreenActive ? 'Windowed' : 'Fullscreen';
  }
}

async function changeWdaMode(nextMode) {
  if (wdaChangePending) return;
  wdaChangePending = true;
  toggleWdaButton.disabled = true;
  liveWdaMode.disabled = true;
  try {
    renderState(await window.oroNimbus.setAffinityMode(nextMode));
  } catch (error) {
    readback.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    wdaChangePending = false;
    toggleWdaButton.disabled = false;
    liveWdaMode.disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  window.oroNimbus.navigate(locationInput.value);
});
document.querySelector('#back').addEventListener('click', () => window.oroNimbus.back());
document.querySelector('#forward').addEventListener('click', () => window.oroNimbus.forward());
reload.addEventListener('click', () => window.oroNimbus.reload());
document.querySelector('#inspect').addEventListener('click', () => window.oroNimbus.inspect());
document.querySelector('#clear').addEventListener('click', () => window.oroNimbus.clearAffinity());
cigInspectButton.addEventListener('click', () => window.oroNimbus.inspectCig());
toggleWdaButton.addEventListener('click', () => {
  const nextMode = currentState?.requestedMode === 'none' ? liveWdaMode.value : 'none';
  changeWdaMode(nextMode);
});
liveWdaMode.addEventListener('change', () => {
  if (currentState?.requestedMode !== 'none') changeWdaMode(liveWdaMode.value);
});
moduleScanButton.addEventListener('click', async () => {
  modulePanelOpen = !modulePanelOpen;
  modulePanel.hidden = !modulePanelOpen;
  if (modulePanelOpen && processPanelOpen) {
    processPanelOpen = false;
    processPanel.hidden = true;
    await window.oroNimbus.setProcessPanelOpen(false);
  }
  await window.oroNimbus.setModulePanelOpen(modulePanelOpen);
  if (!modulePanelOpen) return;
  moduleScanButton.disabled = true;
  try {
    renderState(await window.oroNimbus.scanModules());
  } catch (error) {
    moduleScanButton.textContent = 'Modules error';
    moduleScanButton.title = error instanceof Error ? error.message : String(error);
  } finally {
    moduleScanButton.disabled = false;
  }
});
processMapButton.addEventListener('click', async () => {
  processPanelOpen = !processPanelOpen;
  processPanel.hidden = !processPanelOpen;
  if (processPanelOpen && modulePanelOpen) {
    modulePanelOpen = false;
    modulePanel.hidden = true;
    await window.oroNimbus.setModulePanelOpen(false);
  }
  await window.oroNimbus.setProcessPanelOpen(processPanelOpen);
  if (!processPanelOpen) return;
  processMapButton.disabled = true;
  try {
    renderState(await window.oroNimbus.scanProcesses());
  } catch (error) {
    processMapButton.textContent = 'Processes error';
    processMapButton.title = error instanceof Error ? error.message : String(error);
  } finally {
    processMapButton.disabled = false;
  }
});
processPanelClose.addEventListener('click', async () => {
  processPanelOpen = false;
  processPanel.hidden = true;
  await window.oroNimbus.setProcessPanelOpen(false);
});
modulePanelClose.addEventListener('click', async () => {
  modulePanelOpen = false;
  modulePanel.hidden = true;
  await window.oroNimbus.setModulePanelOpen(false);
});
fullscreenButton.addEventListener('click', async () => {
  fullscreenActive = await window.oroNimbus.toggleFullscreen();
  fullscreenButton.textContent = fullscreenActive ? 'Windowed' : 'Fullscreen';
});
exitButton.addEventListener('click', () => window.oroNimbus.exit());

document.addEventListener('keydown', async (event) => {
  if (event.key === 'F11' || (event.key === 'Escape' && fullscreenActive)) {
    event.preventDefault();
    fullscreenActive = await window.oroNimbus.toggleFullscreen();
    fullscreenButton.textContent = fullscreenActive ? 'Windowed' : 'Fullscreen';
  }
});

window.oroNimbus.onState(renderState);
window.oroNimbus.onLocation((url) => { locationInput.value = url; });
window.oroNimbus.onLoading((loading) => { reload.textContent = loading ? '×' : '↻'; });
window.oroNimbus.onFullscreen((fullscreen) => {
  fullscreenActive = fullscreen;
  fullscreenButton.textContent = fullscreen ? 'Windowed' : 'Fullscreen';
});
window.oroNimbus.getState().then(renderState);
