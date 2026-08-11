# North Command Center

A local dashboard for **North**, a personal AI assistant running on
[OpenClaw](https://github.com/openclaw/openclaw). One place to see what North is
doing, what it can reach, how fast it is, and to talk to it.

Runs on `127.0.0.1`. No cloud, no telemetry, no dependencies.

---

## Quick start

```bash
git clone https://github.com/C0mputerrr/NorthAI.git
cd NorthAI
node scripts/doctor.js     # check what this machine can reach
npm start                  # http://127.0.0.1:4300
```

There is no build step and nothing to install — `npm start` runs it. On Windows
you can double-click **`scripts\north.cmd`**, which starts the server and opens
your browser.

**Requirements:** Node.js 20+. That is the entire list.

Run `node scripts/doctor.js` first. It probes every interface the dashboard uses
and prints one line each, so a missing binary looks different from a stopped
gateway.

---

## What you get

| Page | What it shows |
|---|---|
| **Overview** | North's status, model, session, context use, uptime, gateway latency; this PC's CPU/RAM/disk/battery/network and active window; a live activity tail |
| **Activity** | Chronological feed, filterable, distinguishing `REQUEST` · `THINKING` · `TOOL` · `RESULT` · `ERROR`, with execution durations |
| **Console** | Natural-language requests to North, with per-turn timings and the raw response available |
| **System** | Open applications, the active window, heaviest processes, and optional Open / Focus / Close |
| **Performance** | Model latency, time-to-first-byte, tool latency, dashboard overhead, payload sizes, slowest recent work — charted over time |
| **Integrations** | Windows, Browser, Telegram, Spotify, Outlook, Calendar, Claude Code, GitHub, ChatGPT, OpenClaw, Phone, Tesla, Home Assistant — each with the evidence behind its verdict |
| **Skills** | Installed OpenClaw skills, enabled state, version and last use |
| **Security** | What North is currently permitted to do, plus the dashboard's own posture |

---

## How it talks to North

```
browser  ──SSE/fetch──►  Node server  ──►  adapters  ──┬──► openclaw CLI ──► gateway (RPC)
                                                       ├──► http://127.0.0.1:18789/healthz
                                                       └──► PowerShell worker (Windows)
```

### Why the CLI, and not the gateway WebSocket

The gateway's WebSocket control plane requires an **Ed25519 device identity**, a
signed challenge/response handshake, and an operator **pairing approval** before
it accepts RPC. OpenClaw's own documentation points client authors at the
`@openclaw/gateway-client` package rather than hand-rolling that flow — but that
package is currently a **reserved `0.0.0` placeholder with no implementation**.
Reimplementing the handshake from documentation alone would be precisely the
brittle coupling this dashboard is meant to avoid.

So the transport is:

```
openclaw gateway call <method> --params '<json>' --json
```

A documented, first-class RPC passthrough that reaches the same method surface
and **delegates authentication to OpenClaw itself** — the dashboard never holds a
gateway credential. It costs one process spawn per call, which is why everything
above it is cached and de-duplicated.

If the client package ships for real, implement a `WsTransport` with the same two
methods as `CliTransport` in `server/adapters/transport.js` and select it in
`createTransport()`. Nothing else changes.

### Interfaces used

| Source | Used for |
|---|---|
| `gateway call status`, `sessions.list`, `models.list`, `usage.status` | North status, model, session, context |
| `gateway call audit.activity.list` | Activity feed |
| `gateway call logs.tail` | Latency spans (`durationMs`, `timeToFirstByteMs`, payload bytes) |
| `gateway call skills.status` | Skills page |
| `gateway call channels.status`, `plugins.list`, `node.list` | Integrations |
| `gateway call tools.effective`, `commands.list`, `exec.approvals.get` | Security |
| `gateway call sessions.dispatch` / `chat.send` | Console |
| `GET /healthz` | Fast liveness (no process spawn — this is what the status strip polls) |
| PowerShell worker | CPU, RAM, disk, battery, network, windows, processes |

The adapter tries several method names per concern and degrades to the next when
a build does not expose one, so the dashboard survives OpenClaw version drift
without version sniffing.

---

## Real data, and the absence of it

**The dashboard never fabricates a value.** Every adapter returns a Result
envelope:

```js
{ state: 'ok' | 'unavailable' | 'not_configured' | 'unknown' | 'error',
  data, reason, source, ms }
```

The only path from a non-`ok` Result to the screen is an explicit block naming
what is missing and why. A panel cannot render a number it does not have,
because there is no code path that produces one.

The distinction is deliberate:

- **`unavailable`** — the interface exists but could not be reached now.
- **`not_configured`** — reachable, but you have not set this up.
- **`unknown`** — genuinely undeterminable. Used where a guess would be worse
  than admitting ignorance.

This matters most on **Integrations**. When the gateway is unreachable, every
service shows **UNKNOWN**, not "not connected" — we did not observe a
disconnection, we only failed to ask. Each card lists its evidence, and a service
reported healthy by one source and failing by another resolves to **PARTIAL**
with both lines shown rather than burying the failure.

### Live now

- North status, gateway health, event-loop diagnostics, model, sessions, context
- Activity feed with per-event durations
- Latency: model, time-to-first-byte, tool execution, dashboard overhead
- Skills, integrations, capabilities
- Console requests and replies
- Full Windows telemetry (CPU / RAM / disk / battery / network / windows / processes)

### Conditional

| Thing | Depends on |
|---|---|
| System telemetry | **Windows only.** On other platforms it reports unavailable rather than guessing |
| Model / tool latency | OpenClaw writing `durationMs` and `timeToFirstByteMs` to its logs |
| Token & context use | `usage.status` being available on your build |
| Skill "last used" | OpenClaw recording it — shown as *not reported* otherwise |
| Recent approvals | `approval.history` being available |
| Open / Focus / Close | `allowProcessActions: true` (off by default) |

### Not implemented

- **Direct WebSocket transport** — blocked on the client package, as above. The
  practical cost is a process spawn per call, visible on Performance as
  *Dashboard → gateway overhead*.
- **Live streaming replies** — the Console shows a completed reply, not tokens
  as they arrive. Token streaming needs the WS session subscription.
- **Browser tab/history inspection** — no OpenClaw interface exposes it, and
  reading browser profile data directly would mean touching cookie and session
  files. Deliberately not done.

---

## Security

- **Binds to `127.0.0.1`.** Not reachable from your network.
- **Host header is validated**, so a hostile web page cannot drive this API
  through your browser via DNS rebinding. Binding to loopback alone would not
  prevent that.
- **No secrets are read.** The config reader pulls a fixed allowlist of
  non-secret scalars from `openclaw.json` — port, bind mode, auth *mode*, log
  path — then drops the document. Tokens and API keys are never loaded into
  memory, so no future edit to a route can leak one.
- **Subprocess output is scrubbed** for token-shaped strings before it can
  become a UI message or a log line.
- **Protected processes** (`lsass`, `csrss`, `winlogon`, Defender, …) are
  filtered inside the PowerShell probe and are never listed or actionable.
  `Close` sends the same polite request as the title-bar X — never a force kill.
- **Nothing weakens your existing setup.** The dashboard reads OpenClaw's
  configuration and never writes it. The startup task runs unelevated.

Two switches, both in `north.config.json`:

```jsonc
"allowConsole": true,          // set false for a strictly read-only dashboard
"allowProcessActions": false   // Open / Focus / Close on the System page
```

---

## Configuration

Everything is discovered at startup. Copy `north.config.example.json` to
`north.config.json` only if you need to override something.

The one field you may actually need:

```jsonc
{
  // Only if `openclaw` is not on your PATH
  "openclawBin": "C:\\Users\\you\\AppData\\Roaming\\npm\\openclaw.cmd"
}
```

`node scripts/doctor.js` tells you whether this is necessary.

---

## Start automatically at login

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-startup.ps1
```

Registers a hidden Scheduled Task that starts the dashboard at logon and
restarts it if it exits. Runs as you, **unelevated**.

```powershell
Start-ScheduledTask -TaskName 'North Command Center'                    # start now
powershell -File scripts\install-startup.ps1 -Uninstall                 # remove
```

A Scheduled Task is used instead of a Startup-folder shortcut because it runs
without a console window, restarts on crash, and removes cleanly in one command.

---

## Performance

Built to sit open all day:

- **Zero runtime dependencies.** Node built-ins only. Cold start is ~60 ms and
  resident memory sits around 45 MB.
- **No frontend build.** Plain ES modules and CSS, served from disk.
- **Polling only runs while a browser tab is open.** With the dashboard closed,
  the process is idle — it does not spawn PowerShell or `openclaw` into the void.
- **One persistent PowerShell worker** instead of a process per poll. A fresh
  `powershell.exe` costs 200–400 ms plus a C# compile for the window API; a
  long-lived host makes each probe a few milliseconds.
- **Cached and de-duplicated calls.** Four open tabs cause one underlying call,
  not four.
- **SSE, not WebSocket**, for updates — the data flow is one-directional and SSE
  reconnects on its own.

If the dashboard itself feels slow, check *Dashboard → gateway overhead* on the
Performance page. That is this tool's cost, charted separately from North's.

---

## Project structure

```
server/
  index.js                  HTTP server, routes, SSE broadcast, polling lifecycle
  config.js                 Settings resolution + allowlisted openclaw.json read
  static.js                 Static file serving
  lib/
    result.js               The Result envelope — the no-fake-data contract
    cache.js                TTL cache with in-flight de-duplication
    json5.js                Minimal JSON5 reader for openclaw.json
    redact.js               Secret scrubbing for subprocess output
  adapters/
    transport.js            THE ONLY module that talks to OpenClaw
    openclaw.js             RPC surface → dashboard shapes
    windows.js              Persistent PowerShell worker
    windows/worker.ps1      The probe script itself
    metrics.js              Latency accounting
    integrations.js         Integration verdicts + evidence
    security.js             Capability resolution

web/
  index.html                Shell
  css/app.css               Design system
  js/
    app.js                  Hash router, page lifecycle, status strip
    api.js                  fetch + SSE
    ui.js                   Rendering primitives, incl. Result state blocks
    charts.js               SVG line charts, meters, sparklines
    pages/*.js              One module per page

scripts/
  doctor.js                 Environment check
  north.cmd                 Double-click launcher
  install-startup.ps1       Scheduled Task installer

tests/fixtures/
  fake-openclaw.mjs         Stand-in gateway for development
```

### Working without a live gateway

```bash
node tests/fixtures/fake-openclaw.mjs --serve &          # fake gateway on :18789
echo '{"openclawBin":"'$PWD'/tests/fixtures/openclaw-shim"}' > north.config.json
npm start
```

The fixture implements the same two surfaces the transport uses, with payloads in
the shapes OpenClaw documents. Useful for UI work; never used at runtime.

---

## Adding an integration

Add an entry to `CATALOG` in `server/adapters/integrations.js`:

```js
{ id: 'obsidian', label: 'Obsidian', kind: 'service', match: ['obsidian'] }
```

`match` is tested against channel ids, plugin names and node names reported by
OpenClaw. The verdict and its evidence are derived automatically — including the
correct UNKNOWN when nothing reports.
