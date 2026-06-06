# Lumen Browser Control (Chrome extension)

Drives the user's **real, logged-in Chrome** for Lumen's web tools via the
`chrome.debugger` CDP API — no `--remote-debugging-port`, no profile clone, no
Chrome 136 block. The extension dials an **outbound** localhost WebSocket to the
Lumen app (`ws://127.0.0.1:9222/lumen?t=lumen-bridge-v1`), receives CDP command
requests, runs them via `chrome.debugger` on the active tab, and replies.

## Expected: the yellow debug banner

While Lumen is driving a tab, Chrome shows a yellow **"Lumen Browser Control
started debugging this browser"** banner. This is **unavoidable** for any
`chrome.debugger` extension and is the safe, sanctioned API. It can only be
removed by forking/bundling Chromium (out of scope).

## Stable extension ID

The `"key"` field in `manifest.json` pins a **deterministic extension ID** so
the unpacked dev build and a future Web Store build share one ID
(`cdnlimpamjkbdhplioabiemplocidbld`). That ID is what Lumen's auto-install
(phase 4) uses as the External Extensions JSON filename.

### Regenerating the key (only if you must rotate identity)

```bash
# private key — keep OUT of the bundle (repo-root extension-key.pem, gitignored)
openssl genrsa 2048 > extension-key.pem
# value for manifest.json "key":
openssl rsa -in extension-key.pem -pubout -outform DER | base64 | tr -d '\n'
# derived extension ID (first 32 hex of sha256(pubkey DER), mapped 0-9a-f -> a-p):
openssl rsa -in extension-key.pem -pubout -outform DER \
  | openssl dgst -sha256 -binary | xxd -p -c32 | head -c32 | tr '0-9a-f' 'a-p'
```

The private key is only needed to self-sign a `.crx`; unpacked dev loading
derives the ID from the public `"key"` alone.

## Load unpacked (dev)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right).
3. **Load unpacked** → select this `extension/` directory.
4. Confirm the ID is `cdnlimpamjkbdhplioabiemplocidbld`.

Until the Lumen WS bridge (phase 2) is running, the service worker just retries
the connection on a backoff — that's expected; check the service-worker console
(`chrome://extensions` → *Inspect views: service worker*) to see reconnect logs
with no thrown errors.

## Protocol

```
Lumen -> ext : {"id":N,"op":"eval","expr":"<js>"}
               {"id":N,"op":"cdp","method":"<Domain.method>","params":{...}}
ext -> Lumen : {"id":N,"ok":true,"value":"..."}
               {"id":N,"ok":false,"error":"..."}
               on connect: {"op":"hello"}
```

## Privacy Policy

**Lumen Browser Control does not collect, store, transmit, or sell any user
data.**

The extension communicates **exclusively** with the Lumen desktop application
running on the same machine, over a local loopback WebSocket
(`ws://127.0.0.1`). It opens an outbound connection to that local address only —
it contacts no remote servers, analytics endpoints, or third parties.

Page content (DOM, accessibility tree, screenshots) read via the Chrome
DevTools Protocol is passed to the local Lumen app **on demand** to fulfil the
actions you ask Lumen to perform on the active tab. This data is not persisted
by the extension and never leaves your computer through the extension.

Permissions used and why:

- **`debugger`** — read the active tab's DOM and dispatch input (click/scroll)
  via the Chrome DevTools Protocol, the sanctioned API for this control.
- **`tabs`** — identify and target the active tab to control.
- **host `127.0.0.1`** — connect to the local Lumen app only; no remote hosts.

Contact: open an issue on this repository.
