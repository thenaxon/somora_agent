# Shared browser

A real Chromium on the somora host that an agent drives with the
`browser` tool — and that you can watch and take over in the web
client, so a login, a 2FA code or a captcha is yours to do and the
agent continues in the same, now signed-in tab.

Stage 1 is the service and the tool; stage 2 (this version) adds the
live picture, manual control and the browser list in the web client.
Stage 3 brings the chat notice with an **Open** button when an agent
asks for you, and the taskbar marker.

## Setup

```yaml
browser:
  enabled: true
  # executablePath: /usr/bin/chromium     # auto-detected when unset
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

## Profiles — one per agent

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

Shared means shared cookies **and** shared tabs. An agent not listed on
a profile cannot touch it.

`open` with `ephemeral: true` uses a throw-away profile next to the
agent's own — for "look at this without my logins" — deleted on `stop`.

## The `browser` tool

One tool, `op`-variants:

| op | what |
|---|---|
| `open` | `url`, optional `tab` to navigate an existing tab, `ephemeral`. Returns `tab`, `generation`. |
| `snapshot` | Compact accessibility tree of a tab; interactive elements carry `[ref=e12]`. `full: true` for the raw tree. |
| `act` | `action` `click` / `fill` / `press` / `scroll` / `select` on a `ref` (`press`/`scroll` also without one), optional `value`, optional `generation`. |
| `screenshot` | PNG into `<workspace>/browser/<agent>/`, path returned. |
| `tabs`, `status` | What is open; whether the browser runs, which profile, who controls it. |
| `request_handoff` | `reason`, optional `resume_note`. Marks the browser as waiting for you. |
| `close_tab`, `stop` | Clean up. `stop` keeps the profile. |

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
true. It opens the list: one row per running browser (= agent profile)
with tab count, the active tab's title and the control state — *agent
controls*, *waiting for you*, *you control*. A row opens the browser
window.

The window streams the active tab live (JPEG screencast over a
WebSocket, paced so a slow viewer drops frames instead of buffering
them), with a tab bar, URL bar, back/forward/reload and the two
buttons that matter:

- **Take over** — you take control of this browser: clicks, wheel,
  typing (umlauts, dead keys and paste included) and the URL bar go to
  the page, the remote viewport follows your window size, and every
  agent operation on this browser is refused until you hand back.
  Other viewers of the same browser keep watching.
- **Hand back** — hands control back. If the agent had asked for
  you (`request_handoff`), it is woken once in the session it asked
  from and told to take a fresh snapshot. If you took over on your own
  and did something (navigated, clicked, typed), the agent that used
  this browser last is woken in that session with the same advice.
  Looking and handing back unchanged wakes nobody.

Watching needs no take-over. Closing the window stops the stream, not
the browser and not the agent's work. Control is per browser, not per
tab. The footer shows the streamed tab, the viewport size, the page
generation and the frame counter — useful when a picture looks stale
right after a navigation.

## Handing the browser over

When a page needs you, the agent calls `request_handoff` and ends its
turn. The browser is now `handoff_requested`: every agent op is refused
with `BROWSER_HUMAN_CONTROL`, and the tool description tells the model
not to retry. The take-over buttons live in the browser window; the same
switch is an HTTP route:

```bash
curl -sk -X POST https://localhost:18737/browser/agent:naxon/control \
  -H 'Content-Type: application/json' -d '{"mode":"human"}'
# … sign in …
curl -sk -X POST https://localhost:18737/browser/agent:naxon/control \
  -H 'Content-Type: application/json' -d '{"mode":"agent","handoffId":"<id>"}'
```

Handing back wakes the requesting agent exactly once in the session it
asked from (idempotent per handoff id) with the reason and its own
resume note; the wake tells it to take a fresh snapshot first. A pending
handoff survives a server restart. Control is per browser, not per tab:
while you hold it, none of that agent's tabs move.

`GET /browser/status` lists every running browser with tabs, control
state and pending handoff — what the browser list shows.

## What it does not do (yet)

No chat notice yet when an agent asks for you (stage 3 — watch the
list's *waiting for you*), no upload/download UI, no passkeys or
hardware keys (the remote
browser cannot see your devices), no audio/video, no free JavaScript
evaluation. Anti-bot detection is not evaded: a site that blocks
automation blocks this too, so test with your own applications before
a service like LinkedIn.
