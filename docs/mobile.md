# somora mobile — PWA chat client

A second web app shipped with somora, mounted at `/mobile`. Designed
for chatting with your agents from a phone over Tailscale. Minimal-
scope by intent: no tmux terminals, no file viewer, no multi-window
layout — just chat, switch between agents, send + receive.

## Installing on your phone

Prerequisites:

1. Tailscale installed and connected on your phone.
2. somora running with TLS via Tailscale-cert (see [setup.md](setup.md)
   → "HTTPS via Tailscale"). Plain HTTP works for testing but PWAs need
   a secure context to install.

Then:

1. On the phone, open the somora URL in Safari (iOS) or Chrome
   (Android): `https://<your-host>.<your-tailnet>.ts.net:18737/mobile/`
2. **iOS:** tap the share icon (square + up arrow) → "Add to Home
   Screen". Confirm.
3. **Android:** Chrome surfaces an "install" prompt automatically (or
   tap menu → "Install app").

The icon (the somora koala) lands on your home screen. Tapping it
opens somora in standalone PWA mode — no browser chrome, full screen,
own app switcher entry.

## Using it

- **Avatar row at the top** lists every agent registered on the
  server. Tap to switch the active agent. The last-selected agent is
  remembered across reloads — opening the PWA again drops you straight
  back into your last conversation.
- **Chat area** shows the running history of the active agent's `main`
  session. Markdown rendering for code blocks, links, lists, etc.
  Pinch-to-zoom is disabled; tap-to-zoom into a code block by scrolling
  the block horizontally.
- **Input bar** at the bottom: paperclip (attachments), mic (voice),
  textarea, send. Enter sends, Shift+Enter inserts a newline.
- **Voice input:** tap the mic — it goes red and pulses while
  recording. Tap again to stop; the transcript lands in the textarea
  ready for you to edit before sending. Never auto-sends. Requires
  `stt.enabled: true` in the server config and a browser that
  supports `getUserMedia` + `MediaRecorder` (every modern phone
  browser does). The button is hidden when either prerequisite is
  missing.
- **Attachments:** tap the paperclip to open the phone's native file
  picker — iOS / Android both let you choose Camera, Photo Library, or
  Files there. Pictures (`image/*`) and PDFs are accepted. Picked
  files upload to the server immediately and appear as chips above
  the textarea; tap the × on a chip to drop it before sending. You
  can send with attachments only (no text).
- **Typing indicator:** when you've sent and the agent is still
  thinking / running tools, a three-dot pulse appears in an agent
  bubble. It's replaced by the actual streaming response as soon as
  the model starts emitting text.
- **Connection-lost banner** appears when the SSE stream drops (e.g.
  Tailscale wakes up, server briefly down). The browser auto-reconnects
  the EventSource; the banner clears once the stream is back.

## Scope: what's in vs what's not

**Phase 1 (current):**
- One agent at a time, one main session per agent
- Live streaming of agent responses with a typing-cursor indicator
- Markdown rendering of agent replies
- localStorage-persisted last-agent

**Phase 2 (current):**
- Voice input via STT (mic-button → record → transcript editable in
  input → send manually)
- Camera / photo-roll attachments via the native picker
- Typing-indicator while the agent is working
- Smarter reconnect handling

**Phase 3+ (planned):**
- Streaming-state dot on agent avatars when an agent is mid-reply
- Per-agent unread badges
- Maskable PNG icons, splash screens, theme polish

**Not planned for the mobile client (use `/web` from a real screen):**
- tmux session attach / shell terminal
- File viewer windows
- Pin-note windows
- Multi-window layout, drag/resize
- Dream-runner-controls UI, dream-state badges
- Project switcher (still works if you preset projects server-side)

## Configuration

```yaml
mobile:
  show:
    tools: false      # default off — toggle on to render `[tool call · …]`
                      # and `[tool result · …]` rows inline in the mobile
                      # chat. Cluttery on small screens, hence default off.
    memory: false     # default off — toggle on to render `[memory · …]`
                      # inject rows.
```

Both flags read at server start and exposed via `GET /mobile-config`.
Toggle either to `true` and restart somora to pick up the change.

## Authentication / security

Same posture as `/web`: LAN-trust on the tailnet. The PWA only works
when the phone is on the same Tailscale net as the somora server. No
external public access. There's no login screen — Tailscale is your
auth boundary. Auth credentials (Anthropic OAuth, OpenAI Codex login)
stay server-side; the phone just speaks to the somora HTTP API.

## Troubleshooting

**"Couldn't install" / no install prompt on iOS:**
- iOS only offers "Add to Home Screen" via the share menu, not via a
  banner. Tap share → scroll → "Add to Home Screen".
- The page must be served over HTTPS. Plain HTTP-served somora won't
  qualify as a PWA.

**Chat is blank / agents don't load:**
- Check that Tailscale is connected on the phone (Tailscale app, status
  should say "Connected" and list your nodes).
- `curl -k https://<your-host>.<your-tailnet>.ts.net:18737/healthz`
  from a laptop on the same tailnet should return `ok`.

**Service-worker stuck on old version after deploy:**
- The service-worker bumps cache name on each release, but if you saw
  a bug fixed in a new release: pull-to-refresh the PWA twice (first
  refresh swaps the worker, second sees the new cache).
- Hard reset: long-press the home-screen icon → "Remove app" → reinstall
  via the share menu.

**Voice input greyed out:**
- The button is permanently disabled when `stt.enabled` is `false`
  in the server's `config.yaml`. Flip to `true`, configure the
  provider + model (see [setup.md](setup.md) → "Speech-to-Text"),
  and restart somora.
- iOS Safari needs explicit microphone permission the first time —
  tap the mic, accept the prompt. Once accepted, the permission
  sticks for the PWA.
- If you see the mic spinner forever after stopping a recording:
  `/stt/transcribe` is timing out (the worker model might be down
  or overloaded). Check the somora server logs for the request.

**Attachment upload fails / chip never appears:**
- Big files: somora caps per-kind upload sizes (see
  `src/attachments/store.ts`). If the picker accepted a file but
  the upload errors out, the server's response message appears
  briefly above the input — it tells you what limit was hit.
- HEIC photos from iOS: most somora pipelines accept HEIC fine, but
  if an agent reports inability to read the image, set your iPhone's
  Camera setting to "Most Compatible" (Settings → Camera → Formats)
  so it captures JPEG instead.

## Building from source

The mobile PWA lives under `web-mobile/` in the somora repo:

```text
web-mobile/
├── package.json        # vite + react, isolated from web/
├── vite.config.ts      # base: '/mobile/', dev-server :5174
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

Built via root `package.json`'s `build:mobile` script, which runs `cd
web-mobile && npm ci && npm run build`. `npm pack`'s `prepack` hook
runs `build:all` so the tarball always contains both `web/dist` and
`web-mobile/dist`. `somora update` picks this up automatically — no
manual step needed for end users.
