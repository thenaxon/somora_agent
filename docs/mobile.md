# Mobile app

A chat app for your phone. It ships with somora, is served at `/mobile`
and installs to the home screen like a native app. It does one thing:
talking to your agents.

## What you get

- **Chat with every agent**, in any of its sessions, with live answers.
- **Sessions and model in the header.** Switch or start a session and
  pick the model with one tap.
- **Steer or queue.** While an agent works, send a note into the
  running turn or queue the next message behind it.
- **Thinking level per session**, in the same sheet as the model.
- **What the agent is doing.** The tools switch shows a turn's tool
  calls in the chat, and a builder's current task, while it works.
- **A builder's panel.** Mode, phase, Go, its task list and its
  acceptance list, which you accept or reject item by item.
- **Voice in and out.** Dictate a message, have the answer read aloud.
- **Photos and PDFs** from the camera, the photo library or files.
- **Dots that show what happens elsewhere**: which agents are working,
  where something unread is waiting.
- **Picks up where it left off** after the phone slept or the
  connection dropped.

Terminals, file windows and the multi-window desktop stay in the
[web client](web.md).

## Install it

You need three things first:

1. iOS or iPadOS 16.4, or a current Chrome on Android (version 111 or
   newer).
2. Tailscale installed and connected on the phone.
3. somora served over HTTPS. A home-screen app only installs from a
   secure address. The setup guide covers this under
   "HTTPS (Tailscale)".

Then open this address on the phone:

```
https://<your-host>.<your-tailnet>.ts.net:18737/mobile/
```

| Phone | How to install |
|---|---|
| **iOS** (Safari) | Share icon, then "Add to Home Screen". |
| **Android** (Chrome) | Accept the install prompt, or menu, then "Install app". |

The somora koala appears on the home screen. The app opens full screen,
without the browser's bars.

The first time, the app asks for the server's key. On the server, run
`somora key link` and scan the QR code with the phone's camera: the
link signs the app in. Or paste what `somora key` prints. The phone
remembers it for a year.

The QR code only helps when the phone can reach the server: with HTTPS
via Tailscale, or with `server.host: 0.0.0.0` on the same network.
Otherwise the link points at `127.0.0.1`, which the phone cannot open.

## The screen

| Part | What it does |
|---|---|
| **Header** | Shows `agent · session ▾ model`. Tap it to switch session or model. On the right: the work badge, the **tools** switch (a wrench; on a wide screen with its name), in a builder session the **builder** button (a clipboard, with the number of open tasks), the screen-awake toggle and the voice toggle. |
| **Avatar row** | One tile per agent. Tap to switch. The app remembers the last agent. Long-press a tile to change the order, see below. |
| **Chat** | The history of the open session, newest first loaded. Scroll to the top, or tap **Load older messages**, for the next older part. Replies are rendered as Markdown. A wide code block scrolls sideways. |
| **Input bar** | Paperclip, microphone, text field, Send. Enter sends, Shift+Enter starts a new line. |

On a phone whose camera island and status indicator sit at a side
(a foldable when folded, a phone with a notch held sideways), the
header and the status banners keep their content out from under them,
and the avatar row scrolls far enough to bring its first and last agent
clear. The chat keeps the full width.

### Agent order

Long-press any agent tile, or tap the header and then **Agent order…**
at the end of the sheet. Each agent is a row: drag it by its handle
(☰), or move it with ↑ and ↓. The top of the list is the first tile on
the left.

**Done** saves the order on the server, so every phone and tablet
shows the same one, also after the app is installed again. Agents not
in the saved order, such as a new one, follow at the end by
name. Without a saved order the tiles are sorted by name.

## Sessions and model

Tap the header. A sheet opens with two lists.

**Sessions.** `main` is first, then the most recently used. Tap one to
switch. **+ New** asks for a name and opens the new session. If the
name exists already, that session opens. A dot marks a session with
something unread, `running` one that is working right now.

**Archived.** The last row of the list. Tap it to see the agent's
archived sessions, newest first, each with the time it was archived.
**Restore** brings one back as a normal session and opens it, with its
whole history. A session `/reset` archived comes back as
`<name>-archive`. Several archives can share that name, for example one
per reset of `main`: the time tells them apart.

**Compact this conversation.** Shortens the session right away: the
earlier conversation is summarised and you keep talking. Greyed out
while a turn runs. See [Compact by hand](compaction.md#compact-by-hand).

**Model for this session.** Tap a model to use it for this session
only. The agent's own model is tagged `default`. Choosing it again
removes the session's own choice. A model somora cannot reach at the
moment is tagged `unreachable`.

**Thinking.** Above the models: the thinking level for this session,
with where it comes from (`set for this session`, `agent's default`,
`model's default`, or `nothing set — the model decides`). The buttons
read **auto**, **off**, **low**, **med** and **high**. Tap **off**
to **high** to set it for this session. **auto** removes the session's
own level, so the agent's or the model's default applies again; the
line `in effect: <level>` then shows which one.

With a model that cannot think the level has no effect,
and the sheet says so. The [thinking guide](thinking.md) explains the
order.

Good to know:

- Each agent reopens in the session you left it in on this phone.
- A model switch during a running turn applies from the next turn.
- A switch made elsewhere, by another client or by an agent, shows up
  in the header right away.
- When a backup model answered the last turn, the header shows that
  model with `⇄` in the warning colour.

Renaming, archiving and resetting a session are done in the web client.
Restoring an archived one works here too.

## Sending messages

### While the agent is working

You can keep typing. While a turn runs, a row above the text field says
what the next message does. Tap it to switch:

| Row | What the message does |
|---|---|
| `⌛ queue after this turn` | Waits until the turn is done. Shows `⌛ queued`, or `⌛ queued · N ahead`. Queued messages run in order. |
| `⚡ steer into this turn` | Goes into the running turn. The model reads it at its next step. Shows `⚡ steering…`, then `⚡ steered`. |

The agent's `steering:` setting in `agent.yaml` decides which way the
row starts, the same as in the web client. When nothing steerable is
running any more, a steered message queues as usual.

- **↩ edit** next to a queued message takes it back into the text
  field. Send it again and it joins the end of the queue.
- **Stop** is the red square beside Send, and a second one on the
  streaming reply. Both do the same: they cancel the running turn only.
  Queued messages keep their place.

### Questions from the agent

A question with options appears as a card above the text field. A chat
agent's question in a conversation with you does not hold the turn: the
card stays until you answer. Tap an option to send it as your next
message, or write anything else, which answers it too. A card with
several questions, or one that allows several answers, has a **Send**
button.

A question that waits, such as an external agent's permission request,
shows how long it still waits. The card is read again after
a reload or a dropped connection.

### The work badge

The badge in the header counts everything on the session, whoever
started it, for example `waiting 3 · running · 1 arriving`. Tap it for
a sheet with four sections: Running, Waiting, Arriving, From here.

| Button | Where | What it does |
|---|---|---|
| **×** | a waiting entry | Removes it. Your own message returns to the text field. Another agent's question is reported back to it as failed, a sub-agent brief as cancelled, a sentinel fire as skipped. |
| **×** | under "From here" | Removes a sub-agent or question that has not started. |
| **■** | under "From here" | Stops one that is running. A sub-agent stops with everything it started. |

A line under "From here" that belongs to an agent on this phone can be
tapped to jump to that session.

### Attachments

Tap the paperclip. The phone offers camera, photo library and files.
Pictures and PDFs are accepted. Each file uploads at once and appears as
a chip above the text field. Tap × on a chip to drop it. You can send
attachments without text.

### Voice

**Dictating.** Tap the microphone. It turns red while recording. Tap
again and the transcript lands in the text field for you to check. It
is never sent by itself. The button is greyed out when `stt.enabled` is
off or the browser cannot record.

**Spoken replies.** With text-to-speech configured, the header shows a
`🔊`/`🔇` toggle. When it is on and you sent the message by voice, the
reply is also played. The toggle is remembered per agent. Replies with
audio get a Play button. Details are in the [voice guide](voice.md).

### Keeping the screen awake

The `☀️`/`🌙` toggle in the header keeps the display on while the app
is open. It is off by default and remembered per browser.

> **Note:** On an iPhone this needs iOS 18.4 or newer. Older versions
> accept the request and let the screen sleep anyway. The toggle still
> switches there, and its tooltip says so.

## What the chat shows

| Marker | Meaning |
|---|---|
| Three pulsing dots | The agent is thinking or running tools. The reply replaces them. With the tools switch on, the activity card stands in their place. |
| Activity card or `▸ N tool calls · time` line | The turn's tool calls, see "Tool activity" below. Only with the tools switch on. |
| `🧠 thinking` | The model's reasoning, when the engine provides it. While it thinks, the newest line peeks below. Tap the row to read all of it. |
| `memory · N notes` line | The notes recalled for the turn, see "Recalled notes" below. Only with the memory switch on. |
| `⇄ fallback · <model>` | A backup model answered. The tooltip names the models that failed and why. |
| **⚠** block | The turn ended in an error. |
| `◌ history compacted …` divider | The history was compacted: before a turn, by hand, or by the engine itself. When somora compacted, the line says by how much. |
| Media line | The reply produced a picture or video. The phone shows a line naming it. Open the web client to see it. |
| `Image from <host>` with **Show** and **Always show** | A picture from another website, held back until you allow it. See [Security](security.md#pictures-from-other-websites). |

The thinking row only exists when the server captures reasoning.
`thinkingContent.capture: false` in `config.yaml` hides it everywhere.

### Tool activity

The **tools** switch in the header shows what the agent does between
its messages. A builder writes almost no text while it works, so
without it a build of several hours shows an empty chat.

While a turn runs, a card stands where its reply will appear:

```text
<builder> is working · 2:08 h · 168 tool calls
Task 15 of 23: Fix the tool ceiling tests
· exec        pytest tests/test_tool_ceiling.py   running for 4 min
· file_patch  tests/test_tool_ceiling.py
· file_read   backend/models.py
Tap for all tasks and calls
```

It shows the last three calls. A call that is still running says for
how long, so a hanging command stands out. The task line, the count and
the time come from the server for a builder, so they are right even when
you open the app in the middle of a long turn.

Tap the card for every call of the turn and, for a builder, its task
list and acceptance list. To change anything, open the
[builder panel](#builder-panel).

Once the turn has ended, the card becomes one line above the reply,
such as `▸ 214 tool calls · 2:41 h · tasks 23/23 · acceptance 6/7
passed`. Tap it to open the calls again. A turn without tools has no
card.

The switch is kept per session on this phone. Until you touch it, it
is on in a builder's sessions and follows `mobile.show.tools` for chat
agents, off by default.

### Recalled notes

The **memory** switch in the header shows which notes somora gave the
agent before a turn. A line stands above the reply:

```text
memory · 3 notes  top 0.71  wiki/people/anna  memory/2026-11-02  +1 more   show
```

Tap it to read the text the agent was given. A turn with nothing
recalled has no line. The line is drawn while you watch; when you open
a session later, earlier turns show none.

The switch is kept per session on this phone. Until you touch it, it
follows `mobile.show.memory`, off by default.

### Builder panel

In a builder's session the header has a **builder** button. A yellow
number on it counts the open tasks. Tap it for the builder's panel as a
sheet from the bottom, the same panel as in the
[web client](builder.md#the-task-panel):

| Part | What you do there |
|---|---|
| **Running for** | While a turn runs: how long, how many tool calls, the last tool. |
| **Switches** | Tap **attended / unattended** for the mode, **plan / build** for the phase, **list required / list optional** for the [acceptance list](builder.md#the-acceptance-list). **▶ Go** approves the plan while the session plans. |
| **Plan, folders** | The plan file and the folders the builder may also write in. |
| **Tasks** | The task list, `✓` done, `▶` in progress, `○` open. |
| **Acceptance** | Per requirement its status and evidence. Tap a requirement for its whole evidence. **accept** accepts the item; **reject** opens a field for the reason, then **reject** below it sends the review. |

A question from the builder is answered on the card above the input,
as for every agent; the panel only points to it. The sheet reads the
panel every two seconds while it is open. Tap outside it to close it.

The acceptance list is required on its own when another agent gave the
order. For your own orders, turn it on with **list optional** before
you send the order, or at any time later.

## Dots on the avatars

| Dot | Meaning |
|---|---|
| **Pulsing** | A turn is running in one of that agent's sessions, also one that started before you opened the app. |
| **Unread**, top left | Something arrived since you last looked: a reply, a message from another agent, or a sentinel message. Your own messages and sub-agent sessions do not count. |
| **REM / DEEP / LUCID pulse** | The agent is in a dream phase. |
| **Number badge** | REM findings waiting for review. |
| **Violet wiki chip** | Lucid runs waiting for review. |
| **Sign in the bottom-left corner** | An [external agent](external-agents.md). The header shows its system instead of a model, the session sheet has no model list, and a question it asks appears as a card with buttons above the input. |

The unread dot covers every session of an agent except the one on
screen. The session sheet shows which session it is. Opening the session
clears the dot on all your clients, the web client and the TUI included.
The state survives a server restart.

## When config.yaml has a mistake

A red banner at the top says that `config.yaml` does not validate.
somora keeps running on the last valid version until the file is
fixed, then the banner goes away. See
[A broken config file](setup.md#a-broken-config-file).

## When the connection drops

A banner appears while the live connection is down. The app reconnects
by itself and then asks the server what it missed, so an answer that was
streaming during the gap is restored.

A phone in the pocket is a special case. iOS freezes the connection of
a background app without reporting an error. When you return, the app
checks how long the server has been silent. After more than 45 seconds
it reconnects and reloads the history.

## Not on the phone

Use the [web client](web.md) for these:

- Terminal sessions and the shell
- File viewer and pin-note windows
- Several windows side by side
- Renaming, archiving or resetting a session
- Switching the project of a session
- Reading a builder's plan file. The [builder panel](#builder-panel)
  shows its path; the file opens in the web client's file viewer.

REM, Deep and Lucid have no button in any client. Ask the agent to run
one, for example "catch up on your memories": it starts the phase with
`dream_run`. Over HTTP it is `POST /agents/:agent/dream/run-rem`, see the
[dream phases](dream-phases.md).

## Settings

```yaml
mobile:
  show:
    tools: false
    memory: false
```

| Setting | Default | Meaning |
|---|---|---|
| `mobile.show.tools` | `false` | Whether the tools switch starts on for a chat agent's session. Builders always start on. Your choice per session on the phone wins. |
| `mobile.show.memory` | `false` | Whether the memory switch starts on. Your choice per session on the phone wins. |

Both are reported by `GET /mobile-config`.

Settings the phone depends on elsewhere:

| What | Setting | Where |
|---|---|---|
| Dictating | `stt.enabled` and the speech-to-text provider | setup guide, "Speech-to-Text" |
| Spoken replies | `tts.*` | [voice guide](voice.md) |
| Thinking row | `thinkingContent.capture` | [thinking guide](thinking.md) |

## Security

The app needs the server's key once and keeps it as a cookie. It also
works only while the phone is on the same Tailscale network as the
server. Your model logins stay on the server. The phone only talks to
the somora API. After `somora key rotate` the app asks for the key
again. The app has no sign-out button: to sign the phone out, clear
the site's data in the browser settings.

## Troubleshooting

**No install option on iOS.** iOS never shows an install banner. Use
the share icon, scroll, then "Add to Home Screen". The address must be
HTTPS.

**Blank chat, no agents.** Check that Tailscale is connected on the
phone. From a laptop on the same network this must answer `ok`:

```bash
curl -k https://<your-host>.<your-tailnet>.ts.net:18737/healthz
```

**The app asks for the key, or shows errors after an update.** An app
that stayed open across the update still runs the old version. Close it
fully and open it again, then sign in with the key.

**The app shows an old version after an update.** Close the app fully
and open it again. If it still looks old, do it a second time. As a last
resort remove the app from the home screen and install it again.

**Microphone button greyed out.** `stt.enabled` is `false`,
or no speech-to-text provider is configured. Set it up and restart
somora. On iOS, allow the microphone the first time the phone asks.

**Recording never finishes transcribing.** The speech-to-text model is
down or overloaded. Look for the `/stt/transcribe` request in the server
log.

**An upload fails.** The file is over the size limit for its kind. The
server's message appears briefly above the text field and names the
limit.

**The agent cannot read an iPhone photo.** Switch the camera to
"Most Compatible" under Settings, Camera, Formats, so it saves JPEG.

## Building from source

The app lives in `web-mobile/` in the somora repository:

```text
web-mobile/
├── package.json        # vite + react, separate from web/
├── vite.config.ts      # base: '/mobile/', dev server on :5174
├── src/
│   ├── components/
│   ├── hooks/
│   └── main.tsx
└── public/
    ├── manifest.webmanifest
    ├── service-worker.js
    ├── favicon.svg
    └── icon-{192,512}.png
```

`npm run build:mobile` builds it. `npm pack` builds both web apps
first, so a release always contains them, and `somora update` needs no
extra step.

## See also

- [Web client](web.md): the full desktop
- [Voice](voice.md): speech-to-text and spoken replies
- [Thinking](thinking.md): which engines show their reasoning
- [Setup](setup.md): HTTPS via Tailscale, speech-to-text
- [API](api.md): `GET /activity/stream`, `DELETE /chat/queue/:id`,
  `GET /mobile-config`, `GET`/`PUT /mobile-agent-order`
