const endpoint = process.argv[2];
if (!endpoint) throw new Error('Expected a DevTools WebSocket endpoint');
const expectedMode = process.argv[3];
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

console.log(JSON.stringify({ state, fullscreen, windowed }));

try {
  await evaluate(`(() => {
    const button = document.querySelector('#exit');
    button.click();
    return { exists: Boolean(button) };
  })()`);
} catch {
  // Expected when the Exit handler closes the page before the protocol reply.
}
