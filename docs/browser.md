# Shared browser

A real Chromium on the somora host that an agent drives with the
`browser` tool — and that you can watch and take over in the web
client, so a login with credentials the agent does not have, a 2FA
code or a passkey is yours to do and the agent continues in the same,
now signed-in tab. Everything else it does on its own — a captcha or
image puzzle included: it screenshots, reads the picture with a vision
model and tries, and asks for you only when that keeps failing.

The web client includes the live picture, manual control, browser list,
a chat notice with **Open browser** when an agent asks for you, and a
taskbar marker for pending requests. Chat, taskbar and list share one
change stream; reconnecting restores the current state automatically.

## Setup

```yaml
browser:
  enabled: true
  # executablePath: /usr/bin/chromium     # auto-detected when unset
  headed: false                           # true = Chromium with a window, see "Headed mode"
  extraArgs: []                           # extra Chromium flags, e.g. ["--proxy-server=http://proxy:3128"]
  maxTabsPerAgent: 8
  idleStopMinutes: 30
  viewport: { width: 1280, height: 800 }
  allowPrivate: []                        # LAN hosts/CIDRs agents may open
  deny: []                                # hostnames never opened
  profiles: {}                            # shared profiles, see below
```

somora looks for `chromium`, `chromium-browser`, `google-chrome` and
the macOS app bundles; set `executablePath` for anything else. Without a
browser the tool is still listed but every op answers with what was
tried. `playwright-core` (no bundled browser) drives it.

The tool appears only when `browser.enabled` is true, and can be denied
per agent like any other toolset (`tools.deny: ['toolset:browser']` in
agent.yaml, or the Abilities window).

## Headed mode

Headless Chromium tells every server and every page what it is: the
user agent reads `HeadlessChrome/151…` and `navigator.webdriver` is
true. Services with any bot filtering see that on the first request.
`headed: true` starts Chromium with a window instead, without the
automation flag and without Blink's `AutomationControlled` feature —
the user agent is the normal `Chrome/151…` and `navigator.webdriver`
is false, like a browser a person opened.

On a desktop the window goes to `$DISPLAY`. On a server without a
display somora starts a virtual X server per browser — **Xvfb**, a
system package you install once (Debian/Ubuntu `sudo apt install
xvfb`, Fedora `sudo dnf install xorg-x11-server-Xvfb`, Arch `sudo
pacman -S xorg-server-xvfb`; macOS needs nothing). It is stopped with
the browser. Nobody looks at that screen; the web client's live view
keeps working, it streams over CDP either way.

Without a display and without Xvfb the browser **refuses to start**
and says so — in the tool result, in `browser status`, in the browser
list of the web client and as `browser.headed_unavailable` in the log.
It does not fall back to headless, because that would silently bring
back the signals you switched headed on to avoid. Headed rendering
costs some CPU and memory more per browser.

What headed does not do: TLS fingerprints, canvas and behaviour
analysis, Turnstile-style challenges. A service with serious bot
protection may still tell.

`extraArgs` appends Chromium launch flags verbatim (proxy, window
size, sandbox flags). Both settings are per process: they apply to
every profile and take effect on the next browser start.

## Per-tab device and locale

An agent can open a tab as a phone or in another language, the way
the device mode in Chrome DevTools does:

```
browser { op: "open", url: "https://example.com", device: "iPhone 15", locale: "de-AT" }
```

`device` is a Playwright device name (`iPhone 15`, `Pixel 7`, `iPad
Pro 11`, …; an unknown name is refused with examples) and sets user
agent, viewport, pixel ratio and touch of that one tab. `locale` is a
BCP-47 tag and sets `Accept-Language` and `navigator.language`. Other
tabs of the same browser are untouched; the tab's `emulation` field
in `tabs`/`status` shows what is active. Ask an agent "open the mobile
version" and it uses this.

## Profiles and windows

A Chromium profile is a cookie jar. Every agent gets its own under
`~/.somora/browser/profiles/<agent>/`, so naxon being signed in to a
site does not sign lisa in. A profile is one Chromium process; it
starts on the first `open` and stops after `idleStopMinutes` without a
tool call — the profile, and with it the logins, stays on disk.

Agents that should share logins get a named profile:

```yaml
browser:
  profiles:
    firma:
      agents: [naxon, hans]
```

Shared means shared cookies and one Chromium process — Chromium allows
only one process per profile directory. It does **not** mean shared
tabs: every agent gets its own **window** on that process.

A window is `<browser id>@<agent>`, for example `profile:firma@hans`
or `agent:loki@loki`. It is the unit for everything you and the agents
touch:

- Each window lists and drives only its own tabs. An agent cannot
  snapshot or click a tab in another agent's window, and `stop` closes
  its own window; the process ends when the last window is gone.
- `maxTabsPerAgent` counts per window, not per process.
- Control, handoff and take-over are per window. While you drive hans'
  window, lisa keeps working in hers, on the same Chromium.
- A login is still shared, because the cookie jar is. That is the point
  of a shared profile: sign in once in hans' window and lisa is signed
  in too.

An agent not listed on a profile cannot touch it.

`open` with `ephemeral: true` uses a throw-away profile next to the
agent's own — for "look at this without my logins" — deleted on `stop`.

## The `browser` tool

One tool, `op`-variants:

| op | what |
|---|---|
| `open` | `url`, optional `tab` to navigate an existing tab, `ephemeral`, `device` / `locale` (per-tab emulation, see above). Returns `tab`, `generation`. |
| `snapshot` | Compact accessibility tree of a tab; interactive elements carry `[ref=e12]`. `full: true` for the raw tree. |
| `act` | `action` `click` / `fill` / `press` / `scroll` / `select` on a `ref` (`press`/`scroll` also without one), optional `value`, optional `generation`. |
| `screenshot` | PNG into `<workspace>/browser/<agent>/`, path returned. |
| `tabs`, `status` | What is open in **your** window; whether the browser runs, which profile and window (`view_id`), who controls it, the headed plan (`headless` / `display` / `xvfb` / `unavailable` with reason) and operator warnings. |
| `request_handoff` | `reason`, optional `resume_note`. Marks the browser as waiting for you. |
| `close_tab`, `stop` | Clean up. `stop` closes your window and keeps the profile; the Chromium stays up for other agents that still have one. |

The loop an agent runs is `open` → `snapshot` → `act` → `snapshot`.
Refs are valid until the next snapshot or navigation of that tab; the
tab's `generation` bumps on every navigation and `act` refuses a ref or
generation from an older page state, so a click never lands on an
element that happens to be new. Snapshot text is data from a website —
the tool description says so to the model.

## Navigation policy

Public http(s) hosts are allowed unless on `deny`. Private networks
(RFC1918, loopback, link-local, ULA) are blocked unless the host or CIDR
is on `allowPrivate` — a page an agent reads could otherwise send it to
an internal service. Hostnames are resolved before the check. `file:`,
`chrome:` and everything else never load.

Checked before every `open`, on every document request the browser
makes (route interception) and after every navigation: a redirect into
a forbidden host cannot be intercepted before Chromium follows it, so
the tab is reset to `about:blank` right after and the next op reports
where it was sent. That first request has been made by then — same
limit OpenClaw documents; not a network firewall.

## In the web client

A **browser** tile appears on the desktop once `browser.enabled` is
true. It opens the **browser sessions** list: one row per open window,
named by the agent that owns it, with its profile, tab count, the
active tab's title and the control state — *agent controls*, *waiting
for you*, *human controls*. Two agents on a shared profile are two
rows. A row opens that window.

Only running windows are listed, the way the tmux session list only
shows live sessions. The single exception is a stopped browser that
still holds an unanswered handoff: it stays, with **Reopen browser**,
because it is the only trail back to that request.

The window streams the active tab live (JPEG screencast over a
WebSocket, paced so a slow viewer drops frames instead of buffering
them), with a tab bar, URL bar, back/forward/reload and the two
buttons that matter:

- **Take over** — you take control of this window: clicks, wheel,
  typing (umlauts, dead keys and paste included) and the URL bar go to
  the page, the remote viewport follows your window size, and this
  agent's operations are refused until you hand back. Another agent
  sharing the profile keeps working in its own window. Other viewers of
  the same window keep watching. A tab you open here belongs to this
  window, so the agent can use it afterwards.
- **Hand back** — hands control back. If the agent had asked for
  you (`request_handoff`), it is woken once in the session it asked
  from and told to take a fresh snapshot. If you took over on your own
  and did something (navigated, clicked, typed), the owner of this
  window is woken, in the session of the last tab it used here.
  The window you worked in decides who is woken, never the busiest
  agent on the process. Looking and handing back unchanged wakes nobody. The wake shows up
  in the chat as a centered *browser · <agent> · handed back* divider
  (`from_system: 'browser'`), like tmux and sentinel wakes.

Watching needs no take-over. Closing the window stops the stream, not
the browser and not the agent's work. Control is per window, not per
tab: while you hold it, none of that agent's tabs move. The footer shows the streamed tab, the viewport size, the page
generation and the frame counter — useful when a picture looks stale
right after a navigation.

## Handing the browser over

When a page needs you, the agent calls `request_handoff` and ends its
turn. The browser is now `handoff_requested`: every agent op is refused
with `BROWSER_HUMAN_CONTROL`, and the tool description tells the model
not to retry. The take-over buttons live in the browser window; the same
switch is an HTTP route:

```bash
curl -sk -X POST https://localhost:18737/browser/agent:naxon@naxon/control \
  -H 'Content-Type: application/json' -d '{"mode":"human"}'
# … sign in …
curl -sk -X POST https://localhost:18737/browser/agent:naxon@naxon/control \
  -H 'Content-Type: application/json' -d '{"mode":"agent","handoffId":"<id>"}'
```

The path is the window id. A bare browser id still works while only one
agent has a window on that process.

Handing back schedules one wake for the requesting agent in the session it
asked from (idempotent per handoff id) with the reason and its own
resume note; the wake tells it to take a fresh snapshot first. A pending
handoff survives a server restart. It belongs to one window: another
agent on the same profile neither sees the request nor the hand-back.

The notice appears in the requesting chat, including when that chat is
opened later. Its reason and **Open browser** button remain until the
handoff is returned. The taskbar marker opens the browser list even
when that chat or browser window is closed. These are current-state
notices, not historical transcript messages.

`GET /browser/status` lists the open windows, plus stopped ones that
still hold a pending handoff.
`GET /browser/stream` sends that state initially and on changes; the web
client uses this stream instead of repeatedly fetching the list.

## Recovery and limits

A viewer reconnects after a broken connection and keeps its selected
tab and controller identity. A disconnect never gives control back to
the agent. A different viewer can explicitly take over; only the current
controller can send input or hand back through the viewer socket.
Old-tab or old-navigation frames are discarded, and inputs based on
an obsolete frame are refused. Capture replacement waits for the old
CDP session to stop.

After a browser crash or server restart, every window that existed
comes back with its control state, and pending handoffs remain visible. **Reopen browser** launches a blank page in the
same persistent profile; saved cookies remain, but old tabs, submitted
forms and clicks are not replayed. Temporary profiles lose their data.
A pending handoff must still be returned by the user. Without a pending
handoff, a new explicit agent `open` may resume a stopped profile.

State writes use an atomic file replacement. A failed control-state write
refuses the transition. The wake is dispatched after the handoff is
cleared; there is no durable wake queue. If the server dies between that
write and dispatch, or the wake fails, the user must continue the chat
manually. Missing or archived source sessions are refused rather than
creating a new conversation under an arbitrary name.

Capture uses `browser.stream.maxFps` (default 15, capped at 20 by ack
pacing). A viewer with 2 MB buffered drops frames; a slow status reader
gets coalesced snapshots. Viewer input is limited to 64 KiB per message
and 64 pending commands. WebSocket ping/pong detects a dead viewer after
80 seconds. The status stream has heartbeats and bounded writes too.
Idle cleanup does not stop a browser with a pending handoff, human
control, or an operation in progress.

The global browser switch and per-agent browser ability apply to direct
`/browser/op` requests as well as tool visibility. Human viewer access
uses the web application's existing access boundary.

## Verification

Run `node --import tsx src/browser/service.test.mts` for real-Chromium
service tests, and the `change-stream.test.mts`, `screencast.test.mts`,
and `session.test.mts` files in the same directory for focused tests
(use `SOMORA_HOME=/tmp/somora-browser-unit` for isolated test logs).
After `npm --prefix web run build`, run:

```bash
SOMORA_BROWSER_WEB_SMOKE=1 node --import tsx src/browser/web-smoke.test.mts
```

This starts an isolated server, local OTP page and local model fixture,
with two agents on one shared profile, then drives `/web` through
takeover, OTP entry, reconnect and hand-back. It checks that the list
shows one row per window, that the second agent keeps working while you
control the first, notice removal, exactly one wake into the session
that asked, and the direct ability gate. It uses
temporary profiles and requires Chromium and permission to bind local
ports; the running installation is not used.

## What it does not do (yet)

No upload/download UI, no passkeys or hardware keys (the remote
browser cannot see your devices), no audio/video, no free JavaScript
evaluation. Anti-bot detection is not evaded: a site that blocks
automation blocks this too, so test with your own applications before
a service like LinkedIn.
