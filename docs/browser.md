# Shared browser

A real Chromium on the somora host that your agents drive with the
`browser` tool. You can watch it live in the web client and take it
over, for example to sign in. The agent then continues in the same,
now signed-in tab.

## What you get

- **Agents that use real websites.** They open pages, read them, click,
  fill forms and take screenshots.
- **Logins that stay.** Each agent has its own browser profile. Cookies
  and logins survive between turns and restarts.
- **You do the login, the agent does the rest.** When a page needs a
  password, a 2FA code or your decision, the agent asks for you and
  waits. You hand the browser back and it carries on.
- **A live picture.** Watch any agent's browser in the web client
  without interrupting it.
- **Shared logins when you want them.** Put several agents on one named
  profile. Each still gets its own window and tabs.
- **Your network stays closed.** Private addresses are blocked unless
  you list them.

## Set it up

1. Install Chromium or Chrome on the somora host, for example
   `sudo apt install chromium`.
2. Switch the browser on in `config.yaml`:

   ```yaml
   browser:
     enabled: true
   ```

3. Restart somora.
4. Ask an agent: "Open example.com and tell me what the page says."

A **browser** tile appears on the web client's desktop. Open it to see
the agent's browser and watch it work.

The `browser` tool exists only while `browser.enabled` is true. To keep
it from one agent, add `tools.deny: ['toolset:browser']` to its
`agent.yaml`, or switch it off in the Abilities window.

## How an agent browses

The agent repeats four steps: `open` a page, take a `snapshot`, `act`
on an element, take a `snapshot` again.

A snapshot is a compact text outline of the page. Every element the
agent can use carries a reference such as `[ref=e12]`. The agent passes
that reference to `act` to click, fill, press a key, scroll or select.

References are valid until the next snapshot or navigation of that tab.
Each tab has a `generation` that counts up on every navigation. `act`
refuses a reference or generation from an older page state, so a click
never lands on an element that only looks the same.

A captcha or image puzzle is not handed to you right away. The agent
takes a screenshot, reads it with a vision model and tries. It asks for
you only when that keeps failing.

> **Note:** Text in a snapshot comes from a website. The tool tells the
> model to treat it as data, never as an instruction.

## Profiles and windows

A profile is a cookie jar. Every agent has its own under
`~/.somora/browser/profiles/<agent>/`, so one agent being signed in to
a site does not sign another in.

A profile is one Chromium process. It starts on the first `open` and
stops after `idleStopMinutes` without a tool call or viewer activity.
The profile, and with it the logins, stays on disk.

### Shared profiles

Agents that should share logins get a named profile:

```yaml
browser:
  profiles:
    shared:
      agents: [ada, bea]
```

Sign in once in one agent's window and the other agent is signed in
too. Shared means shared cookies and one Chromium process. It does not
mean shared tabs: every agent gets its own window on that process. An
agent that is not listed cannot use the profile.

### One window per agent

A window has the id `<browser id>@<agent>`, for example
`profile:shared@ada` or `agent:cleo@cleo`. Everything you and the
agents touch is per window:

| What | How it behaves |
|---|---|
| Tabs | An agent lists and drives only its own tabs. A tab in another agent's window is out of reach. |
| Tab limit | `maxTabsPerAgent` counts per window, not per process. |
| Control | Take-over and handoff apply to one window. The other agent keeps working in its own. |
| `stop` | Closes the agent's own window. The process ends when the last window is gone. |

### Throw-away profile

`open` with `ephemeral: true` uses a temporary profile next to the
agent's own, for "look at this without my logins". It is deleted when
that browser stops. The browser list shows it as `<agent> (temporary)`.

## Handing the browser over

When a page needs you, the agent calls `request_handoff` with a reason
and ends its turn. Its window is now waiting for you:

1. A notice with the reason and an **Open browser** button appears in
   the chat the agent asked from. The taskbar shows
   `Browser · 1 waiting for you`.
2. You open the window, press **Take over** and do your part.
3. You press **Hand back**. The agent is woken once, in the session it
   asked from.

While the window waits or you control it, every agent operation on the
page is refused with `BROWSER_HUMAN_CONTROL`. Only `tabs` and `status`
still answer. The tool tells the model not to retry.

The wake reads:

```
[browser] The user handed browser '<window>' back to you (handoff <id>).
Reason you asked for it: <reason>. Your note: <resume note>.
```

Beside that text the turn carries the advice to take a fresh snapshot
first, because the page may have changed.

Good to know:

- The notice shows the current state. It appears when you open the chat
  later and disappears once you hand back.
- A handoff belongs to one window. Another agent on the same profile
  sees neither the request nor the hand-back.
- A pending handoff survives a server restart.
- Waking is tied to the handoff id, so handing back twice wakes once.

### Taking over without being asked

You can take over any window at any time. What happens on **Hand back**
depends on what you did:

| You did | Result |
|---|---|
| Only looked | Nobody is woken. |
| Navigated, clicked, typed, opened or closed a tab | The window's agent is woken in the session of the tab it used last. |

The wake reads:

```
[browser] The user took over browser '<window>', did something there
(navigation, clicks or typing) and handed it back to you.
```

In the chat a wake shows as a centered divider, `browser · <agent> ·
handed back` or `browser · <agent> · activity`. Messages carry
`from_system: 'browser'`, like tmux and sentinel wakes.

## In the web client

The **browser** tile appears on the desktop once `browser.enabled` is
true. It turns to the warning colour while a handoff is waiting.

### The browser list

The tile opens the **browser sessions** list, with one row per open
window. Two agents on a shared profile are two rows. Click a row to
open that window.

| In a row | Meaning |
|---|---|
| Name | The agent that owns the window. |
| Profile | `own profile` or `shared profile <name>`. |
| Tabs | Tab count and the title of the first tab. |
| State | `agent controls`, `waiting for you`, `human controls`, `paused` or `stopped`. |

Only running windows are listed. The one exception is a stopped browser
that still holds an unanswered handoff. It stays in the list as
`stopped · reopen`, because it is the only way back to that request.

Warnings, such as a missing Chromium, are shown at the top of the list.

### The browser window

The window streams the active tab live. It has a tab bar, a URL bar,
back, forward and reload, and two buttons:

- **Take over.** Clicks, the mouse wheel, typing and the URL bar now go
  to the page. Umlauts, dead keys and paste work. The remote page
  follows your window size. This agent's operations are refused until
  you hand back.
- **Hand back.** Returns control to the agent and wakes it as described
  above.

Good to know:

- Watching needs no take-over. Other viewers of the same window keep
  watching while you control it.
- Control is per window, not per tab. While you hold it, none of that
  agent's tabs move.
- A tab you open belongs to this window. The agent can use it
  afterwards.
- Closing the window stops the stream. The browser and the agent's work
  go on.
- The footer shows the viewport size, the page generation and a frame
  counter.

## Where the browser may go

| Target | Allowed |
|---|---|
| Public `http` and `https` hosts | Yes, unless listed in `deny`. |
| Private networks | No, unless the host or range is in `allowPrivate`. |
| `file:`, `chrome:` and every other scheme | Never. |

Private means loopback, the private IPv4 ranges, link-local addresses,
`100.64.0.0/10` (Tailscale addresses fall in it) and the IPv6 local
ranges. Hostnames are resolved first, so a public-looking name that
points into your LAN is caught. The reason: a page the agent reads could
otherwise send it to an internal service.

An entry in `allowPrivate` or `deny` is a hostname, a `*.suffix`
pattern, an IP address or an IPv4 range such as `192.0.2.0/24`.

The rule is checked at three points:

1. Before every `open`.
2. On every page request the browser makes, which covers links and
   pop-ups.
3. After every navigation. A redirect into a forbidden host cannot be
   stopped before Chromium follows it, so the tab is reset to
   `about:blank` and the next operation reports where it was sent.

The URL bar in the browser window follows the same rule.

> **Warning:** This is not a network firewall. Images, scripts and
> background requests of a page are not checked, and in the redirect
> case the first request to the forbidden host has already been made.

## Headed mode

Headless Chromium tells every server what it is. The user agent reads
`HeadlessChrome` and `navigator.webdriver` is true. Services with bot
filtering see that on the first request.

`headed: true` starts Chromium with a window and without the automation
flags. The user agent is the normal `Chrome` one and
`navigator.webdriver` is false, like a browser a person opened.

| Host | Where the window goes |
|---|---|
| Desktop session, macOS | The existing display. |
| Linux server without a display | A virtual screen, **Xvfb**, started per browser and stopped with it. |
| No display and no Xvfb | The browser refuses to start. |

Xvfb is a system package you install once:

| System | Command |
|---|---|
| Debian, Ubuntu | `sudo apt install xvfb` |
| Fedora | `sudo dnf install xorg-x11-server-Xvfb` |
| Arch | `sudo pacman -S xorg-server-xvfb` |

somora looks for `Xvfb` on the `PATH`. The environment variable
`SOMORA_XVFB_PATH` points it to another location.

somora never falls back to headless. That would silently bring back the
signals you switched headed mode on to avoid. The refusal is reported in
the tool result, in `status`, in the browser list and in the log.

Headed mode costs some more CPU and memory per browser. The live view
works the same in both modes.

> **Note:** Headed mode hides two signals. It does not change TLS
> fingerprints, canvas or behaviour analysis, and it does not solve
> challenge pages. A service with serious bot protection may still
> tell.

## Phone view and language

An agent can open a tab as a phone or in another language, the way the
device mode in Chrome DevTools does:

```
browser { op: "open", url: "https://example.com", device: "iPhone 15", locale: "de-AT" }
```

| Parameter | Value | Sets |
|---|---|---|
| `device` | A Playwright device name: `iPhone 15`, `Pixel 7`, `iPad Pro 11` and more | User agent, viewport, pixel ratio and touch |
| `locale` | A BCP-47 tag such as `de-AT` | `Accept-Language` and `navigator.language` |

Both apply to that one tab only. An unknown device name is refused with
examples. The tab's `emulation` field in `tabs` and `status` shows what
is active.

## After a crash or restart

| Situation | What happens |
|---|---|
| Viewer connection drops | The window reconnects by itself and keeps its tab and its control. A disconnect never hands control back to the agent. |
| Browser crashed or stopped idle | Cookies and logins remain. Tabs, forms and clicks are not replayed. Temporary profiles lose their data. |
| Handoff was pending | It stays visible. **Reopen browser** starts a blank page in the same profile. You still have to hand back. |
| No handoff pending | The agent's next `open` starts the browser again. |
| Server restarted | Same as a crash. Pending handoffs are restored from disk. |

The idle stop never closes a browser with a pending handoff, with you
in control or with an operation running.

There is no stored wake queue. If the server dies in the moment between
your hand-back and the wake, or the wake fails, continue the chat
yourself. A wake into a session that was deleted or archived is refused.
No new conversation is created in its place.

## What it does not do

- No upload or download through the browser.
- No passkeys or hardware keys. The remote browser cannot see your
  devices.
- No audio or video.
- No free JavaScript evaluation by the agent.
- No evasion of bot detection. A site that blocks automation blocks
  this too.

## Settings

```yaml
browser:
  enabled: false
  # executablePath: /usr/bin/chromium
  headed: false
  extraArgs: []
  maxTabsPerAgent: 8
  idleStopMinutes: 30
  viewport: { width: 1280, height: 800 }
  stream: { quality: 60, maxFps: 15 }
  allowPrivate: []
  deny: []
  profiles: {}
```

| Setting | Default | Meaning |
|---|---|---|
| `browser.enabled` | `false` | Switches the tool, the routes and the desktop tile on. |
| `browser.executablePath` | auto-detect | Path of the Chromium or Chrome binary. |
| `browser.headed` | `false` | Run Chromium with a window. See "Headed mode". |
| `browser.extraArgs` | `[]` | Extra Chromium launch flags, passed as written, for example `["--proxy-server=http://proxy:3128"]`. |
| `browser.maxTabsPerAgent` | `8` | Open tabs per window, 1 to 32. The next `open` is refused. |
| `browser.idleStopMinutes` | `30` | Stop an unused browser after this many minutes. Logins stay. |
| `browser.viewport` | `1280` x `800` | Page size. Minimum 320 x 240. |
| `browser.stream.quality` | `60` | JPEG quality of the live picture, 10 to 100. |
| `browser.stream.maxFps` | `15` | Frames per second of the live picture, 1 to 30. The stream never sends more than 20. |
| `browser.allowPrivate` | `[]` | Private hosts or ranges agents may open, for example `["192.0.2.0/24", "nas.local"]`. |
| `browser.deny` | `[]` | Hosts never opened, for example `["*.exampleco.com"]`. |
| `browser.profiles` | `{}` | Shared profiles: `<name>: { agents: [...] }`. Names use lowercase letters, digits, `-` and `_`. |

`headed` and `extraArgs` apply to every profile and take effect when a
browser next starts.

Without `executablePath` somora checks these locations in order:
`/usr/bin/chromium`, `/usr/bin/chromium-browser`,
`/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`,
`/snap/bin/chromium`, `/opt/homebrew/bin/chromium` and the Chromium and
Google Chrome apps under `/Applications`. somora drives the browser
with `playwright-core`, which brings no browser of its own.

Files on disk:

| Path | Content |
|---|---|
| `~/.somora/browser/profiles/<agent>/` | An agent's own profile. |
| `~/.somora/browser/profiles/shared-<name>/` | A shared profile. |
| `~/.somora/browser/state.json` | Control state and pending handoffs. |
| `<workspace>/browser/<agent>/` | Screenshots. |

## The browser tool

One tool, `browser`, with an `op` parameter:

| op | Parameters | What it does |
|---|---|---|
| `open` | `url`, optional `tab`, `ephemeral`, `device`, `locale` | Opens the URL in a new tab, or navigates the given `tab`. Returns `tab`, `generation` and `view_id`. |
| `snapshot` | `tab`, optional `full`, `max_chars` | Compact outline of the page with `[ref=e12]` references. `full: true` returns the raw tree. Default cap 20,000 characters. |
| `act` | `tab`, `action`, optional `ref`, `value`, `generation` | `action` is `click`, `fill`, `press`, `scroll` or `select`. `press` and `scroll` also work without a `ref`. |
| `screenshot` | `tab` | Saves a PNG to `<workspace>/browser/<agent>/` and returns the path. |
| `tabs` | none | The tabs in your window. |
| `status` | none | Whether the browser runs, profile, window (`view_id`), who controls it, the headed plan and warnings. |
| `request_handoff` | `reason`, optional `resume_note` | Marks the window as waiting for the user. Returns `handoff_id`. |
| `close_tab` | `tab` | Closes one tab. |
| `stop` | none | Closes your window and keeps the profile. |

`value` means text for `fill`, a key name such as `Enter` for `press`,
pixels for `scroll` (default 600) and the option for `select`. The
headed plan in `status` is `headless`, `display`, `xvfb`, or
`unavailable` with the reason. `control` is `agent_control`,
`handoff_requested`, `human_control` or `paused`.

A failed operation returns `ok: false` and an error that starts with
one of these codes:

| Code | Meaning |
|---|---|
| `BROWSER_DISABLED` | `browser.enabled` is false. |
| `BROWSER_NOT_ALLOWED` | The agent lacks the browser ability or is not on that profile. |
| `BROWSER_LAUNCH_FAILED` | No Chromium found, or headed mode without a display. The message lists what was tried. |
| `BROWSER_NOT_FOUND` | No running browser. Start with `open`. |
| `BROWSER_TAB_NOT_FOUND` | Unknown tab, or a tab in another agent's window. |
| `BROWSER_TAB_LIMIT` | The window is at `maxTabsPerAgent`. |
| `BROWSER_NAVIGATION_DENIED` | The URL is forbidden. Do not retry it. |
| `BROWSER_STALE_REF` | The reference is from an older page state. Take a new snapshot. |
| `BROWSER_HUMAN_CONTROL` | The window waits for the user or the user controls it. |
| `BROWSER_ACTION_FAILED` | Anything else: the element did not respond, the page did not load. |

## Routes

In every route `:id` is the window id. A bare browser id such as
`agent:<your-agent>` also works while only one agent has a window on
that process.

| Route | What it does |
|---|---|
| `GET /browser/status` | `enabled`, the headed plan, warnings and the list of windows, including stopped ones with a pending handoff. |
| `GET /browser/stream` | The same list as server-sent events. A `browsers` event at once and on every change. |
| `POST /browser/:id/control` | Body `{"mode":"human"}` takes over. `{"mode":"agent"}` hands back. Optional `handoffId` and `by`. |
| `POST /browser/:id/restart` | Starts a stopped browser again with a blank page. |
| `POST /browser/op` | Runs a tool operation. Body `{agent, session, input}`. |
| `GET /browser/attach` | WebSocket for the live picture and input. Query `view`, optional `tab` and `viewer`. |

With `browser.enabled` off, `GET /browser/status` answers
`enabled: false` and the others answer 503. `POST /browser/op` also
checks the agent's browser ability.

Taking over and handing back from the command line:

```bash
curl -sk -X POST https://localhost:18737/browser/agent:<your-agent>@<your-agent>/control \
  -H 'Content-Type: application/json' -d '{"mode":"human"}'
# sign in, then:
curl -sk -X POST https://localhost:18737/browser/agent:<your-agent>@<your-agent>/control \
  -H 'Content-Type: application/json' -d '{"mode":"agent","handoffId":"<id>"}'
```

Limits of the live view:

| Limit | Value |
|---|---|
| Slow viewer | Frames are dropped once 2 MB are buffered. |
| Input message size | 64 KiB |
| Pending input commands | 64 |
| Dead viewer detected | After 80 seconds without a pong. |
| Who may send input | Only the viewer that took over. Another viewer can take over explicitly. |

## Troubleshooting

**The agent says no Chromium was found.** Install Chromium or set
`browser.executablePath`. The error lists the paths that were tried.

**The browser refuses to start with `headed: true`.** The host has
neither a display nor Xvfb. Install Xvfb or set `headed: false`. The
log line is `browser.headed_unavailable`.

**The agent cannot open a page in your LAN or tailnet.** Add the host
or range to `browser.allowPrivate`. The log line is
`browser.navigation_denied`.

**Clicks in the browser window do nothing.** Press **Take over** first.
If the page just changed, wait for a fresh picture.

**The agent was not woken after Hand back.** The session it asked from
was archived or deleted, or the server restarted at that moment. Send
the agent a message to continue. The log line is `browser.wake_failed`.

## Testing from source

The tests live in `src/browser/` of the somora repository:
`service.test.mts` (real Chromium), `change-stream.test.mts`,
`screencast.test.mts` and `session.test.mts`.

```bash
SOMORA_HOME=/tmp/somora-browser-unit node --import tsx src/browser/service.test.mts
npm --prefix web run build
SOMORA_BROWSER_WEB_SMOKE=1 node --import tsx src/browser/web-smoke.test.mts
```

The last one starts an isolated server with two agents on one shared
profile and drives the web client through take-over, reconnect and
hand-back. The running installation is not used.

## See also

- [Security](security.md): what agents may reach on the network
- [Web client](web.md): the desktop, windows and the taskbar
- [Tools](tools.md): all tools and how to deny them per agent
- [Setup](setup.md): system packages such as Chromium and Xvfb
