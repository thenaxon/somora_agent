# Mobile app

A chat app for your phone. It ships with somora, is served at `/mobile`
and installs to the home screen like a native app. It does one thing:
talking to your agents.

## What you get

- **Chat with every agent**, in any of its sessions, with live answers.
- **Sessions and model in the header.** Switch or start a session and
  pick the model with one tap.
- **Voice in and out.** Dictate a message, have the answer read aloud.
- **Photos and PDFs** from the camera, the photo library or files.
- **Dots that show what happens elsewhere**: which agents are working,
  where something unread is waiting.
- **Picks up where it left off** after the phone slept or the
  connection dropped.

Terminals, file windows and the multi-window desktop stay in the
[web client](web.md).

## Install it

You need two things first:

1. Tailscale installed and connected on the phone.
2. somora served over HTTPS. A home-screen app only installs from a
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

## The screen

| Part | What it does |
|---|---|
| **Header** | Shows `agent · session ▾ model`. Tap it to switch session or model. On the right: the work badge, the screen-awake toggle and the voice toggle. |
| **Avatar row** | One tile per agent. Tap to switch. The app remembers the last agent. |
| **Chat** | The history of the open session. Replies are rendered as Markdown. A wide code block scrolls sideways. |
| **Input bar** | Paperclip, microphone, text field, Send. Enter sends, Shift+Enter starts a new line. |

## Sessions and model

Tap the header. A sheet opens with two lists.

**Sessions.** `main` is first, then the most recently used. Tap one to
switch. **+ New** asks for a name and opens the new session. If the
name exists already, that session opens. A dot marks a session with
something unread, `running` one that is working right now.

**Model for this session.** Tap a model to use it for this session
only. The agent's own model is tagged `default`. Choosing it again
removes the session's own choice. A model somora cannot reach at the
moment is tagged `unreachable`.

Good to know:

- Each agent reopens in the session you left it in on this phone.
- A model switch during a running turn applies from the next turn.
- A switch made elsewhere, by another client or by an agent, shows up
  in the header right away.
- When a backup model answered the last turn, the header shows that
  model with `⇄` in the warning colour.

Renaming, archiving and resetting a session are done in the web client.

## Sending messages

### While the agent is working

You can keep typing. A message sent during a running turn is queued and
shows `⌛ queued`, or `⌛ queued · N ahead`. Queued messages run in
order.

- **↩ edit** next to a queued message takes it back into the text
  field. Send it again and it joins the end of the queue.
- **Stop** is the red square beside Send, and a second one on the
  streaming reply. Both do the same: they cancel the running turn only.
  Queued messages keep their place.

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
| Three pulsing dots | The agent is thinking or running tools. The reply replaces them. |
| `🧠 thinking` | The model's reasoning, when the engine provides it. While it thinks, the newest line peeks below. Tap the row to read all of it. |
| `⇄ fallback · <model>` | A backup model answered. The tooltip names the models that failed and why. |
| **⚠** block | The turn ended in an error. |
| Media line | The reply produced a picture or video. The phone shows a line naming it. Open the web client to see it. |

The thinking row only exists when the server captures reasoning.
`thinkingContent.capture: false` in `config.yaml` hides it everywhere.

## Dots on the avatars

| Dot | Meaning |
|---|---|
| **Pulsing** | A turn is running in one of that agent's sessions. |
| **Unread** | Something arrived since you last looked: a reply, a message from another agent, or a sentinel message. Your own messages do not count. |
| **REM / DEEP / LUCID pulse** | The agent is in a dream phase. |
| **Number badge** | REM findings waiting for review. |
| **Violet wiki chip** | Lucid runs waiting for review. |

The unread dot covers every session of an agent except the one on
screen. The session sheet shows which session it is. Opening the session
clears the dot on all your clients, the web client and the TUI included.
The state survives a server restart.

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
- Starting REM, Deep or Lucid by hand
- Switching the project of a session
- A builder's task panel: plan, Go, task list and questions. You can
  chat with a builder from the phone, but its plan is approved and its
  questions are answered in the web client.

## Settings

```yaml
mobile:
  show:
    tools: false
    memory: false
```

| Setting | Default | Meaning |
|---|---|---|
| `mobile.show.tools` | `false` | Reserved for showing tool calls in the mobile chat. |
| `mobile.show.memory` | `false` | Reserved for showing recalled notes in the mobile chat. |

Both are reported by `GET /mobile-config`. The mobile app does not draw
tool or memory rows yet, so they change nothing today.

Settings the phone depends on elsewhere:

| What | Setting | Where |
|---|---|---|
| Dictating | `stt.enabled` and the speech-to-text provider | setup guide, "Speech-to-Text" |
| Spoken replies | `tts.*` | [voice guide](voice.md) |
| Thinking row | `thinkingContent.capture` | [thinking guide](thinking.md) |

## Security

The phone app has no login screen. It works only while the phone is on
the same Tailscale network as the server, and Tailscale is the access
boundary. Your model logins stay on the server. The phone only talks to
the somora API.

## Troubleshooting

**No install option on iOS.** iOS never shows an install banner. Use
the share icon, scroll, then "Add to Home Screen". The address must be
HTTPS.

**Blank chat, no agents.** Check that Tailscale is connected on the
phone. From a laptop on the same network this must answer `ok`:

```bash
curl -k https://<your-host>.<your-tailnet>.ts.net:18737/healthz
```

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
  `GET /mobile-config`
