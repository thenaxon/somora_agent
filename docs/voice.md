# Voice

Somora supports two voice flows:

1. **STT in chat** — the web and mobile-PWA clients have a mic button
   next to send. Tap, talk, tap again — Somora transcribes via your
   configured Whisper-compatible upstream and drops the text into the
   chat input.
2. **TTS reply (optional)** — when you submit a message via mic and
   the per-chat auto-play toggle is on, Somora generates spoken audio
   for the assistant's reply and plays it automatically. A Play-button
   on the bubble lets you replay any time.

Both flows route through OpenAI-compatible endpoints on a provider
you already configured (`oMLX`, faster-whisper-server, OpenAI itself,
etc.) — no extra credentials.

A third endpoint, `POST /voice/turn`, is the audio-in/audio-out HTTP
contract for integrations: a wall panel, voice satellite or bridge
sends a recording, somora runs STT + a normal agent turn + TTS, and
returns spoken audio. See [api.md](api.md#voice) for the wire format.

## Configuration

Voice features are opt-in. Add the blocks below to `~/.somora/config.yaml`
— omit them entirely if you don't want voice.

### Speech-to-Text (STT)

```yaml
stt:
  enabled: true
  provider: omlx                              # references providers.omlx
  model: mlx-community/whisper-large-v3-turbo
  language: de                                # optional default hint
```

`provider` must reference an `openai-compatible` entry from your
`providers` block — Somora reuses its `baseUrl` and `apiKey`. The STT
model is intentionally NOT listed under `providers.<x>.models` (it's
not a chat model the agent can pick).

### Text-to-Speech (TTS)

```yaml
tts:
  enabled: true
  provider: omlx                              # references providers.omlx
  model: fish-audio-s2-pro-8bit               # whatever your upstream calls it
  language: de
  # voice: <id>                               # optional speaker selector
  cache:
    retentionDays: 7                          # 0 disables GC
    maxSizeMB: 500
  reencode:
    enabled: true                             # ffmpeg on for opus/m4a output
    opusBitrateKbps: 24
  clients:
    web:
      autoPlayVoiceReplies: false             # initial toggle state for new sessions
      allowUserOverride: true                 # show the 🔊/🔇 toggle in chat header
    mobile:
      autoPlayVoiceReplies: false
      allowUserOverride: true
```

Required dependency for re-encoding: a system `ffmpeg` on the somora
host's `$PATH`. WAV passthrough works without ffmpeg, but mobile
clients usually prefer opus/m4a for bandwidth.

## Auto-play gating

The auto-TTS hook in chat is gated by **four conditions, all must hold**:

1. `tts.enabled` is true in config.
2. The user message arrived via voice (`input_modality: 'voice'` — set
   automatically when the client filled the draft via the mic button).
3. The per-session auto-play toggle is on (the chat header `🔊` toggle,
   sticky in localStorage; default seeded from
   `tts.clients.<web|mobile>.autoPlayVoiceReplies`).
4. The assistant text is speakable (the sanitizer skips replies with
   heavy code blocks, large tables, or too little prose).

If any gate fails, no TTS is generated and no Play-button appears. The
chat behaves text-only.

This means:
- Typed turns → never get a spoken reply.
- Mic turns + toggle off → no spoken reply (toggle controls cost).
- Mic turns + toggle on, mostly-code reply → silenced by sanitizer.
- Mic turns + toggle on, prose reply → spoken, with a Play-button for
  replay.

## Per-session toggle behaviour

The chat header in web and mobile shows a `🔊`/`🔇` toggle when
`tts.enabled` is true and `clients.<web|mobile>.allowUserOverride` is
true. Tapping flips the state, persisted in `localStorage` under a key
scoped to `<agent>:<session>`.

A fresh chat seeds from the config default. Switching agents preserves
each agent's own setting. Disabling the toggle mid-conversation means
future replies are silent; existing Play-buttons on past bubbles still
work.

## Manual playback

The Play-button on an assistant bubble appears **only when audio for
that turn was already generated** (auto-play was on, or the turn ran
through `/voice/turn`). It does not generate-on-demand for past
typed-only turns. Tap to play; tap again to stop.

History reload restores the buttons for past turns where audio
existed — assistant-audio events are persisted in the session JSONL
and the cache file is content-addressed, so the same audio file
serves repeated plays.

## Cache & GC

Generated audio is cached at `~/.somora/tts-cache/<sha256>.<ext>`,
where the hash is `sha256(text + voice + model + format)`. Identical
replies (same text + same voice + same format) reuse the file —
playing the same answer twice doesn't hit the TTS upstream twice.

Two policies trim the cache:

- **`retentionDays`** — files older than this are removed at the next
  sweep tick. Sweeper runs at boot and once per day. Set to `0` to
  disable.
- **`maxSizeMB`** — when total size exceeds the cap, the oldest files
  are evicted until size is back under.

GC is best-effort; failures log a warning and continue.

## Audio formats

Somora content-negotiates the wire format from the client's `Accept`
header:

- `audio/opus` — preferred for mobile (24 kbps Opus VBR, smallest).
- `audio/mp4` / `audio/m4a` — AAC fallback (64 kbps).
- `audio/wav` — passthrough from the upstream (no re-encode).

If `tts.reencode.enabled` is false, only WAV is served regardless of
Accept. No Accept header ⇒ WAV.

## /voice/turn endpoint

The audio-in/audio-out endpoint for integrations:

```http
POST /voice/turn
Content-Type: multipart/form-data
Accept: audio/opus, audio/wav;q=0.5

agent=<name>
session=<name>          # "main" or an exact id or a new slug to create
audio=@recording.webm
voice=<voice-id>        # optional
language=<lang>         # optional
```

Returns JSON:

```json
{
  "ok": true,
  "agent": "naxon",
  "session": "main",
  "transcript": "Wie spät ist es?",
  "text": "Es ist 10:29 Uhr.",
  "audio": {
    "url": "/tts/cache/abc123….opus",
    "mime": "audio/opus",
    "durationMs": 1800,
    "cacheKey": "abc123…"
  }
}
```

Notes:

- The session lock is `priority: user` — same as `/chat/send` (this is
  human input, just audio).
- Timeout: 60s by default. Voice turns that take longer than that
  break the UX premise — pick a fast model for voice agents.
- Always generates TTS regardless of per-chat toggles. The endpoint is
  meant for display-less clients that need spoken output unconditionally.
- The assistant text is also broadcast on the session's SSE stream and
  persisted in the session JSONL — so a web client watching the same
  session sees the voice turn live, with the Play-button armed.

## Persona advice

The default persona for a "voice agent" should ask for short, natural
spoken answers and avoid Markdown / code / tables. Add something like
the following to the agent's `AGENTS.md`:

```text
This agent is often reached via voice.
Answer briefly, naturally and conversationally.
Avoid Markdown formatting, code blocks, tables, and long bullet
lists in spoken contexts — they read aloud poorly.
```

You don't need a dedicated voice-only agent — the sanitizer handles
the "what's speakable" question. A persona that's already concise
works fine. Verbose personas will hit the sanitizer's length cap (2000
chars) and get truncated mid-sentence; tighten the persona before
flipping auto-play on for them.

## Troubleshooting

- **No mic button in web/mobile** — `/stt/config` returns
  `enabled:false`, or the browser lacks MediaRecorder/getUserMedia
  (e.g. plain HTTP — Secure Context required for mic access; use the
  Tailscale TLS path).
- **No 🔊 toggle in header** — `/tts/config` returns `enabled:false`,
  or `clients.<…>.allowUserOverride: false`.
- **TTS request returns 502 "TTS upstream returned …"** — the model
  name is wrong, the upstream isn't running, or the upstream rejects
  the request shape. Tail somora server logs for `tts.upstream_error`
  with the upstream's response body for diagnostics.
- **ffmpeg failed messages** — install ffmpeg system-wide or set
  `tts.reencode.enabled: false` (WAV-only).
- **No Play-button on a mic turn with auto-play on** — the sanitizer
  likely skipped a non-speakable reply (heavy code/tables). Log line:
  `turn.auto_tts_skipped` with the reason.
