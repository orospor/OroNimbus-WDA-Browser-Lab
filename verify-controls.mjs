const endpoint = process.argv[2];
if (!endpoint) throw new Error('Expected a DevTools WebSocket endpoint');
const expectedMode = process.argv[3];
const expectedFeatures = new Set(process.argv.slice(4));
const expectWatchdog = expectedFeatures.has('watchdog');
const expectDllHardening = expectedFeatures.has('dll-hardening');
const expectLiveWda = expectedFeatures.has('live-wda');
const expectModuleMonitor = expectedFeatures.has('module-monitor');
const expectedReadbacks = { exclude: 0x11, monitor: 0x01, none: 0x00 };
if (expectedMode && !Object.hasOwn(expectedReadbacks, expectedMode)) {
  throw new Error(`Unsupported expected WDA mode: ${expectedMode}`);
}

const socket = new WebSocket(endpoint);
let nextId = 1;
const pending = new Map();

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

function command(method, params = {}) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text);
  }
  return result.result.value;
}

const state = await evaluate(`(async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const value = await window.oroNimbus.getState();
    if (value.setOk && value.getOk) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return window.oroNimbus.getState();
})()`);

if (expectedMode) {
  if (state.requestedMode !== expectedMode) {
    throw new Error(`Expected mode ${expectedMode}, received ${state.requestedMode}`);
  }
  if (!state.setOk || !state.getOk || state.readback !== expectedReadbacks[expectedMode]) {
    throw new Error(`WDA verification failed: ${JSON.stringify(state)}`);
  }
}

if (expectDllHardening) {
  const hardening = state.dllSearchHardening;
  if (!state.dllSearchHardeningRequested
      || !hardening?.defaultDirectoriesOk
      || !hardening?.currentDirectoryRemovedOk) {
    throw new Error(`DLL search hardening verification failed: ${JSON.stringify(state)}`);
  }
}

let watchdogState = null;
let repair = null;
if (expectWatchdog) {
  watchdogState = await evaluate(`(async () => {
    for (let attempt = 0; attempt < 45; attempt += 1) {
      const value = await window.oroNimbus.getState();
      if (value.watchdogChecks > 0) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return window.oroNimbus.getState();
  })()`);
  const expectedReadback = expectedMode ? expectedReadbacks[expectedMode] : null;
  if (!watchdogState.watchdogEnabled
      || watchdogState.watchdogChecks < 1
      || watchdogState.watchdogLastError !== null
      || !watchdogState.getOk
      || !watchdogState.matchesRequested
      || (expectedMode && watchdogState.watchdogLastReadback !== expectedReadback)) {
    throw new Error(`WDA watchdog did not run: ${JSON.stringify(watchdogState)}`);
  }

  if (expectedMode && expectedMode !== 'none') {
    repair = await evaluate(`(async () => {
      const before = await window.oroNimbus.getState();
      await window.oroNimbus.clearAffinity();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const value = await window.oroNimbus.getState();
        if (value.watchdogRepairs > before.watchdogRepairs
            && value.readback === ${expectedReadbacks[expectedMode]}) {
          return { before, after: value };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { before, after: await window.oroNimbus.getState() };
    })()`);
    if (repair.after.watchdogRepairs <= repair.before.watchdogRepairs
        || repair.after.readback !== expectedReadbacks[expectedMode]) {
      throw new Error(`WDA watchdog did not repair lab-induced drift: ${JSON.stringify(repair)}`);
    }
  }
}

let moduleMonitorState = null;
let manualModuleScan = null;
let modulePanelUi = null;
if (expectModuleMonitor) {
  moduleMonitorState = await evaluate(`(async () => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const value = await window.oroNimbus.getState();
      if (value.moduleBaselineReady
          && value.moduleBaselineCount > 0
          && value.moduleCurrentCount > 0
          && value.moduleLastError === null) {
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return window.oroNimbus.getState();
  })()`);
  if (!moduleMonitorState.moduleMonitorEnabled
      || moduleMonitorState.moduleScope !== 'electron-main-process'
      || !moduleMonitorState.moduleBaselineReady
      || moduleMonitorState.moduleBaselineCount < 1
      || moduleMonitorState.moduleCurrentCount < 1
      || moduleMonitorState.moduleLastError !== null) {
    throw new Error(`Self-process module monitor did not establish a usable baseline: ${JSON.stringify(moduleMonitorState)}`);
  }

  manualModuleScan = await evaluate('window.oroNimbus.scanModules()');
  if (!manualModuleScan.moduleBaselineReady
      || manualModuleScan.moduleBaselineCount < 1
      || manualModuleScan.moduleCurrentCount < 1
      || manualModuleScan.moduleScanCount <= moduleMonitorState.moduleScanCount
      || manualModuleScan.moduleLastError !== null) {
    throw new Error(`Manual self-process module scan failed: ${JSON.stringify(manualModuleScan)}`);
  }

  const moduleUiCopy = await evaluate(`(() => {
    const text = document.querySelector('#module-panel')?.textContent ?? '';
    return {
      hasHeuristic: /heuristic/i.test(text),
      hasMainPidOnly: /main pid only/i.test(text),
      hasNotProof: /not proof of injection/i.test(text),
    };
  })()`);
  if (!moduleUiCopy.hasHeuristic
      || !moduleUiCopy.hasMainPidOnly
      || !moduleUiCopy.hasNotProof) {
    throw new Error(`Module-monitor limits are not visible in the UI: ${JSON.stringify(moduleUiCopy)}`);
  }

  modulePanelUi = await evaluate(`(async () => {
    const trigger = document.querySelector('#module-scan');
    const panel = document.querySelector('#module-panel');
    const close = document.querySelector('#module-panel-close');
    trigger.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const opened = !panel.hidden;
    const hasSummary = Boolean(document.querySelector('#module-summary')?.textContent?.trim());
    close.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { opened, closed: panel.hidden, hasSummary };
  })()`);
  if (!modulePanelUi.opened || !modulePanelUi.closed || !modulePanelUi.hasSummary) {
    throw new Error(`Module details panel controls failed: ${JSON.stringify(modulePanelUi)}`);
  }
}

let liveWda = null;
let liveWdaUi = null;
if (expectLiveWda && expectedMode === 'none') {
  liveWda = await evaluate(`(async () => {
    const verifyWatchdogFollowsLiveMode = ${expectWatchdog ? 'true' : 'false'};

    async function setAndWait(mode, expectedReadback) {
      await window.oroNimbus.setAffinityMode(mode);
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const value = await window.oroNimbus.getState();
        if (value.requestedMode === mode
            && value.setOk
            && value.getOk
            && value.readback === expectedReadback
            && value.matchesRequested) {
          return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return window.oroNimbus.getState();
    }

    async function clearAndWaitForRepair(mode, expectedReadback) {
      if (!verifyWatchdogFollowsLiveMode) return null;
      const before = await window.oroNimbus.getState();
      await window.oroNimbus.clearAffinity();
      for (let attempt = 0; attempt < 70; attempt += 1) {
        const value = await window.oroNimbus.getState();
        if (value.requestedMode === mode
            && value.watchdogRepairs > before.watchdogRepairs
            && value.readback === expectedReadback
            && value.matchesRequested) {
          return { before, after: value };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { before, after: await window.oroNimbus.getState() };
    }

    async function waitForStableNone() {
      if (!verifyWatchdogFollowsLiveMode) return null;
      const before = await window.oroNimbus.getState();
      for (let attempt = 0; attempt < 45; attempt += 1) {
        const value = await window.oroNimbus.getState();
        if (value.watchdogChecks > before.watchdogChecks
            && value.requestedMode === 'none'
            && value.readback === ${expectedReadbacks.none}
            && value.matchesRequested
            && value.watchdogRepairs === before.watchdogRepairs) {
          return { before, after: value };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { before, after: await window.oroNimbus.getState() };
    }

    const monitor = await setAndWait('monitor', ${expectedReadbacks.monitor});
    const monitorRepair = await clearAndWaitForRepair('monitor', ${expectedReadbacks.monitor});
    const exclude = await setAndWait('exclude', ${expectedReadbacks.exclude});
    const excludeRepair = await clearAndWaitForRepair('exclude', ${expectedReadbacks.exclude});
    const restored = await setAndWait('none', ${expectedReadbacks.none});
    return {
      monitor,
      monitorRepair,
      exclude,
      excludeRepair,
      restored,
      noneStable: await waitForStableNone(),
    };
  })()`);

  for (const [mode, value] of [
    ['monitor', liveWda.monitor],
    ['exclude', liveWda.exclude],
    ['none', liveWda.restored],
  ]) {
    if (value.requestedMode !== mode
        || !value.setOk
        || !value.getOk
        || !value.matchesRequested
        || value.readback !== expectedReadbacks[mode]) {
      throw new Error(`Live WDA transition to ${mode} failed: ${JSON.stringify(liveWda)}`);
    }
  }

  if (expectWatchdog) {
    for (const [mode, repairState] of [
      ['monitor', liveWda.monitorRepair],
      ['exclude', liveWda.excludeRepair],
    ]) {
      if (!repairState
          || repairState.after.watchdogRepairs <= repairState.before.watchdogRepairs
          || repairState.after.requestedMode !== mode
          || repairState.after.readback !== expectedReadbacks[mode]
          || !repairState.after.matchesRequested) {
        throw new Error(`Watchdog did not follow live ${mode} selection: ${JSON.stringify(liveWda)}`);
      }
    }
    if (!liveWda.noneStable
        || liveWda.noneStable.after.watchdogChecks <= liveWda.noneStable.before.watchdogChecks
        || liveWda.noneStable.after.requestedMode !== 'none'
        || liveWda.noneStable.after.readback !== expectedReadbacks.none
        || !liveWda.noneStable.after.matchesRequested
        || liveWda.noneStable.after.watchdogRepairs !== liveWda.noneStable.before.watchdogRepairs) {
      throw new Error(`Watchdog did not remain stable after live WDA off: ${JSON.stringify(liveWda)}`);
    }
  }

  liveWdaUi = await evaluate(`(async () => {
    const select = document.querySelector('#live-wda-mode');
    const toggle = document.querySelector('#toggle-wda');
    select.value = 'monitor';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    toggle.click();
    let enabled = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const value = await window.oroNimbus.getState();
      if (value.requestedMode === 'monitor'
          && value.readback === ${expectedReadbacks.monitor}
          && value.matchesRequested) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        enabled = { state: value, label: toggle.textContent };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    toggle.click();
    let disabled = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const value = await window.oroNimbus.getState();
      if (value.requestedMode === 'none'
          && value.readback === ${expectedReadbacks.none}
          && value.matchesRequested) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        disabled = { state: value, label: toggle.textContent };
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return { enabled, disabled };
  })()`);
  if (!liveWdaUi.enabled
      || !liveWdaUi.disabled
      || liveWdaUi.enabled.label !== 'Turn WDA off'
      || liveWdaUi.disabled.label !== 'Turn WDA on') {
    throw new Error(`Live WDA UI controls failed: ${JSON.stringify(liveWdaUi)}`);
  }
}

const fullscreen = await evaluate(`(async () => {
  const button = document.querySelector('#fullscreen');
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 700));
  return { label: button.textContent, exists: Boolean(button) };
})()`);

const windowed = await evaluate(`(async () => {
  const button = document.querySelector('#fullscreen');
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 700));
  return { label: button.textContent, exists: Boolean(button) };
})()`);

console.log(JSON.stringify({
  state,
  watchdogState,
  repair,
  moduleMonitorState,
  manualModuleScan,
  modulePanelUi,
  liveWda,
  liveWdaUi,
  fullscreen,
  windowed,
}));

try {
  await evaluate(`(() => {
    const button = document.querySelector('#exit');
    button.click();
    return { exists: Boolean(button) };
  })()`);
} catch {
  // Expected when the Exit handler closes the page before the protocol reply.
}
