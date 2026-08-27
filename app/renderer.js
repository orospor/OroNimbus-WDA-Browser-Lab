const form = document.querySelector('#location-form');
const locationInput = document.querySelector('#location');
const mode = document.querySelector('#mode');
const readback = document.querySelector('#readback');
const processLabel = document.querySelector('#process');
const reload = document.querySelector('#reload');
const fullscreenButton = document.querySelector('#fullscreen');
const exitButton = document.querySelector('#exit');
let fullscreenActive = false;

const affinityLabel = (value) => ({
  0x00: 'WDA_NONE (0x00)',
  0x01: 'WDA_MONITOR (0x01)',
  0x11: 'WDA_EXCLUDEFROMCAPTURE (0x11)',
}[value] ?? `Unknown (0x${Number(value).toString(16)})`);

function renderState(state) {
  mode.textContent = state.error ? 'ERROR' : state.requestedMode.toUpperCase();
  mode.className = `mode ${state.error ? 'error' : state.requestedMode}`;
  readback.textContent = state.error
    ? state.error
    : `${state.setOk ? 'Applied' : 'Apply failed'} · ${state.getOk ? affinityLabel(state.readback) : `read failed (${state.getLastError})`}`;
  processLabel.textContent = `${state.processName} · PID ${state.pid} · ${state.arch}`;
  if (typeof state.fullscreen === 'boolean') {
    fullscreenActive = state.fullscreen;
    fullscreenButton.textContent = fullscreenActive ? 'Windowed' : 'Fullscreen';
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
