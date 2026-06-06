// Lumen Browser Control — MV3 service worker.
//
// Holds CDP on the active tab via chrome.debugger and bridges it to the Lumen
// app over an outbound localhost WebSocket. No --remote-debugging-port, no
// profile clone: chrome.debugger attaches to the user's REAL default-profile
// tab. The yellow "started debugging this browser" banner Chrome shows is
// unavoidable for chrome.debugger and expected.
//
// Protocol (must match src-tauri/src/bridge.rs verbatim):
//   Lumen -> ext : {"id":N,"op":"eval","expr":"<js>"}
//                  {"id":N,"op":"cdp","method":"<Domain.method>","params":{...}}
//   ext -> Lumen : {"id":N,"ok":true,"value":"..."} | {"id":N,"ok":false,"error":"..."}
//                  on connect: {"op":"hello"}

const PORT = 9222;
const TOKEN = "lumen-bridge-v1";
const WS_URL = `ws://127.0.0.1:${PORT}/lumen?t=${TOKEN}`;
const PROTOCOL = "1.3";

let ws = null;
let backoff = 1000; // ms, grows to BACKOFF_MAX
const BACKOFF_MAX = 5000;

// tabIds we currently hold a chrome.debugger session on.
const attached = new Set();

// ---- connection ----------------------------------------------------------

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws.onopen = () => {
    backoff = 1000;
    send({ op: "hello" });
  };
  ws.onmessage = (ev) => {
    handleMessage(ev.data);
  };
  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    // onclose fires next; reconnect is scheduled there.
    try { ws && ws.close(); } catch (e) {}
  };
}

function scheduleReconnect() {
  const delay = backoff;
  backoff = Math.min(backoff * 2, BACKOFF_MAX);
  setTimeout(connect, delay);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Keepalive: MV3 workers idle-suspend and drop the socket. A periodic alarm
// re-wakes the worker; reconnect if the socket isn't open.
chrome.alarms.create("lumen-keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "lumen-keepalive") connect();
});

// ---- chrome.debugger lifecycle -------------------------------------------

// Resolve the active tab, lazily attach the debugger, run fn(tabId).
async function withActiveTab(fn) {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || tab.id == null) throw new Error("no active tab");
  const url = tab.url || "";
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") ||
      url.startsWith("edge://") || url.startsWith("devtools://") ||
      url.includes("chromewebstore.google.com") || url.includes("chrome.google.com/webstore")) {
    throw new Error(`cannot control a browser system page (${url || "blank"})`);
  }
  const tabId = tab.id;
  if (!attached.has(tabId)) {
    await debuggerAttach(tabId);
    attached.add(tabId);
  }
  return await fn(tabId);
}

function debuggerAttach(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, PROTOCOL, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        // Already attached by us is fine; anything else (e.g. DevTools open) is fatal.
        if (/already attached/i.test(err.message)) return resolve();
        return reject(new Error(err.message));
      }
      resolve();
    });
  });
}

function sendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      resolve(result);
    });
  });
}

chrome.debugger.onDetach.addListener((source) => {
  if (source && source.tabId != null) attached.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
});

// ---- command dispatch -----------------------------------------------------

async function handleMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return; // ignore non-JSON
  }
  const { id, op } = msg;
  if (id == null) return; // not a request

  try {
    let value;
    if (op === "eval") {
      value = await doEval(msg.expr);
    } else if (op === "cdp") {
      value = await withActiveTab((tabId) => sendCommand(tabId, msg.method, msg.params));
      value = JSON.stringify(value ?? null);
    } else {
      throw new Error(`unknown op: ${op}`);
    }
    send({ id, ok: true, value });
  } catch (e) {
    send({ id, ok: false, error: String((e && e.message) || e) });
  }
}

// Runtime.evaluate on the active tab; unwrap to a string.
async function doEval(expr) {
  return await withActiveTab(async (tabId) => {
    const res = await sendCommand(tabId, "Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (res && res.exceptionDetails) {
      const ex = res.exceptionDetails;
      const desc = (ex.exception && ex.exception.description) || ex.text || "JS exception";
      throw new Error(desc);
    }
    const v = res && res.result ? res.result.value : undefined;
    if (typeof v === "string") return v;
    if (v == null) return "";
    return JSON.stringify(v);
  });
}

// ---- boot -----------------------------------------------------------------

connect();
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
