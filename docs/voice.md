# Voice (dictation and spoken replies)

Talk instead of type. Press the microphone in the web or mobile client,
speak, and your words land in the text field as text you can still edit.
If you like, the agent's answer is read back to you.

> **Note:** This page is not about calls. A standing conversation with
> an agent, where it listens while you speak and you can interrupt it,
> is a separate feature with its own settings under `realtimeVoice:`.
> See [Realtime voice](realtime-voice.md). Both can run side by side.

## What you get

- **Dictation in every chat.** A microphone button next to Send turns
  one recording into text. Nothing is sent until you send it.
- **Spoken replies when you want them.** A dictated message can get an
  answer that is played aloud. Typed messages stay silent.
- **A Play button for replay.** Every reply that has audio can be
  played again, also after a reload.
- **A voice per agent.** Each agent can speak with its own speaker or
  style.
- **No extra account.** Both directions use a provider you already
  configured, through its OpenAI-compatible audio endpoints.
- **An endpoint for devices.** A wall panel or voice satellite sends a
  recording and gets spoken audio back.

## Set it up

Voice is off until you add the two blocks below to
`~/.somora/config.yaml`. Leave out the one you do not need.

```yaml
stt:
  enabled: true
  provider: omlx                              # an entry of your providers block
  model: mlx-community/whisper-large-v3-turbo
  language: de                                # optional hint

tts:
  enabled: true
  provider: omlx
  model: fish-audio-s2-pro-8bit               # whatever your upstream calls it
  language: de
```

Then restart somora. Changes under `stt` and `tts` only apply after a
restart.

Three things to know:

- `provider` must name an entry of your `providers` block whose engine
  is `openai-compatible`. somora reuses its `baseUrl` and `apiKey`.
  Servers that fit include oMLX, faster-whisper-server and OpenAI.
- Do not list the speech models under `providers.<name>.models`. They
  are not chat models an agent can pick.
- The browser only allows the microphone on a secure address. Serve
  somora over HTTPS, or open it on `localhost`.

## Dictating a message

1. Tap the microphone. It turns red while it records.
2. Tap again. The recording is transcribed.
3. The text is appended to the text field. Edit it, then send.

Dictation never sends by itself.

The web client hides the microphone when `stt.enabled` is off or the
browser cannot record. The mobile app shows it greyed out in the same
cases.

## Spoken replies

A reply is spoken only when all four of these hold:

1. `tts.enabled` is `true`.
2. You dictated the message. Text that came from the microphone marks
   the message as voice, also when you edited it before sending.
3. The auto-play toggle of the chat is on.
4. The reply is speakable. See "What gets read aloud" below.

If one of them fails, no audio is made and the chat behaves as text
only.

| You do this | Result |
|---|---|
| Type a message | Never a spoken reply. |
| Dictate, toggle off | No audio. The toggle is how you control cost. |
| Dictate, toggle on, reply is mostly code | No audio. |
| Dictate, toggle on, reply is prose | Spoken, with a Play button for replay. |

The audio is made after the text reply is complete, so the text shows
first and the voice follows a moment later.

## The auto-play toggle

The chat header shows a `🔊`/`🔇` toggle when `tts.enabled` is `true`
and `allowUserOverride` is `true` for that client.

| Client | Remembered per | First value |
|---|---|---|
| Web | agent and session, in the browser | `tts.clients.web.autoPlayVoiceReplies` |
| Mobile | agent, on the phone | `tts.clients.mobile.autoPlayVoiceReplies` |

Turning the toggle off silences future replies. Play buttons on earlier
replies keep working.

With `allowUserOverride: false` the toggle is hidden and the configured
value applies. Use this for a kiosk.

## Playing a reply again

A Play button appears on a reply only when audio was made for that turn.
It never creates audio for an old typed turn. Tap to play, tap again to
stop.

The buttons come back when you reload the history, because the audio is
recorded in the session log and the file sits in the cache.

## What gets read aloud

Before a reply is spoken, somora turns the Markdown into plain speech.

| In the reply | What is spoken |
|---|---|
| Bold, italics, headings, list markers, inline code marks | Removed, the words stay. |
| A code block | `[Codeblock]` |
| A web address | `[Link]` |
| A table | `[table omitted]` |

A reply is not spoken at all when:

- 40 percent or more of it is code blocks,
- it has more than 6 table rows,
- fewer than 8 characters are left after cleaning.

Text beyond 2000 characters is cut off, at the end of a sentence when
one is close.

## A voice per agent

Many open-source speech engines ignore the OpenAI `voice` field. Fish
Audio S2 Pro is one of them. They pick the speaker from tags inside the
text. For those, somora can put a prefix in front of every text it
sends.

```yaml
tts:
  textPrefix: "<|speaker:0|>"
  agentVoices:
    ada: "[deep male voice] "
    bea: "<|speaker:7|>[male voice] "
    cleo: "<|speaker:2|>"
```

Which prefix is used:

1. `agentVoices.<agent>`, if the agent has an entry.
2. Otherwise `textPrefix`, if set.
3. Otherwise none.

Examples for Fish Audio S2 Pro:

| Prefix | Effect |
|---|---|
| `"<\|speaker:0\|>"` | Locks speaker 0. The model has many. |
| `"[deep male voice] "` | A style tag that shapes the voice. |
| `"[calm] "` | An emotion tag. |
| `"<\|speaker:7\|>[male voice] "` | Speaker and style combined. |

To find tags that work with your model, make a few samples and listen.

An engine that does not know the tags speaks them as words. That sounds
odd but breaks nothing. For an engine that honours the `voice` field,
set `tts.voice` instead.

> **Note:** somora always sends a `voice` field, with the value `alloy`
> when `tts.voice` is not set. The OpenAI speech format requires it, and
> routers such as LiteLLM reject a request without it.

## The audio cache

Generated audio is stored in `~/.somora/tts-cache/` as
`<sha256>.<ext>`. The name is a hash of the text with its prefix, the
voice, the model and the format. The same reply in the same voice is
made once and then served from the file.

Two rules keep the folder small. They run when somora starts and once a
day after that.

| Setting | What it does |
|---|---|
| `tts.cache.retentionDays` | Files older than this are removed. `0` turns this rule off. |
| `tts.cache.maxSizeMB` | Above this total size the oldest files are removed until the folder fits. Always active. |

A file that cannot be removed is logged as a warning and the sweep goes
on.

## Audio formats

| Format | Sent as | Details |
|---|---|---|
| Opus | `audio/opus`, file `.opus` | Smallest. 24 kbit/s by default, set with `tts.reencode.opusBitrateKbps`. |
| AAC | `audio/mp4`, file `.m4a` | 64 kbit/s. |
| WAV | `audio/wav`, file `.wav` | As the speech server delivered it, not converted. |

Spoken replies in the chat are Opus. With `tts.reencode.enabled: false`
they are WAV.

`POST /tts/synthesize` and `POST /voice/turn` choose by the `Accept`
header: `audio/opus` wins, then `audio/mp4`, `audio/m4a` or `audio/aac`,
otherwise WAV. No `Accept` header means WAV. With
`tts.reencode.enabled: false` it is always WAV.

> **Note:** Opus and AAC need `ffmpeg` on the `$PATH` of the machine
> that runs somora. WAV works without it.

## Audio in and audio out for integrations

`POST /voice/turn` is for clients without a screen: a wall panel, a
voice satellite, a bridge. They send a recording. somora transcribes it,
runs a normal agent turn and returns the answer as audio. Both `stt` and
`tts` must be enabled.

```http
POST /voice/turn
Content-Type: multipart/form-data
Accept: audio/opus, audio/wav;q=0.5

agent=<name>
session=<name>
audio=@recording.webm
voice=<voice-id>
language=<lang>
```

| Field | Required | Meaning |
|---|---|---|
| `audio` | yes | The recording. |
| `agent` | no | Agent name. Without it the default agent answers. |
| `session` | no | `main` (the default), an exact session id, or a new name, which creates that session. |
| `voice` | no | Voice for the spoken answer. Default: `tts.voice`. |
| `language` | no | Language for the spoken answer. Default: `tts.language`. The transcription always uses `stt.language`. |

The answer is JSON:

```json
{
  "ok": true,
  "agent": "<your-agent>",
  "session": "main",
  "transcript": "What time is it?",
  "text": "It is 10:29.",
  "audio": {
    "url": "/tts/cache/abc123….opus",
    "mime": "audio/opus",
    "durationMs": 1800,
    "cacheKey": "abc123…"
  }
}
```

Fetch the audio from `audio.url`. `durationMs` is only present for WAV.

Good to know:

- The turn counts as a message from a person, with the same priority as
  one sent through `/chat/send`.
- There is no timeout of its own. The response waits for the whole
  turn, so pick a fast model for an agent that is reached by voice.
- Audio is always made, whatever the chat toggles say.
- A reply that cannot be read aloud is replaced by a short spoken
  sentence that points to the chat history. The `text` field still
  holds the full reply.
- The turn appears live in web and mobile clients that have the session
  open, with the Play button ready, and is stored in the session log.

## Writing for the ear

An agent that is often reached by voice should answer briefly and
without Markdown. Add something like this to its `AGENTS.md`:

```text
This agent is often reached via voice.
Answer briefly, naturally and conversationally.
Avoid Markdown formatting, code blocks, tables, and long bullet
lists in spoken contexts. They read aloud poorly.
```

You do not need a separate agent for voice. An agent that is already
concise works fine. A wordy one runs into the 2000-character limit and
its spoken reply stops early, so tighten the persona before you turn
auto-play on.

## Settings

```yaml
stt:
  enabled: false
  provider: <name>              # required, no default
  model: <model-id>             # required, no default
  # language: de

tts:
  enabled: false
  provider: <name>              # required, no default
  model: <model-id>             # required, no default
  # voice: <id>
  # language: de
  # textPrefix: "<|speaker:0|>"
  agentVoices: {}
  cache:
    retentionDays: 7
    maxSizeMB: 500
  reencode:
    enabled: true
    opusBitrateKbps: 24
  clients:
    web:
      autoPlayVoiceReplies: false
      allowUserOverride: true
    mobile:
      autoPlayVoiceReplies: false
      allowUserOverride: true
```

Both blocks are optional. A block that is present must have `provider`
and `model`.

| Setting | Default | Meaning |
|---|---|---|
| `stt.enabled` | `false` | Turns dictation on. Off: no usable microphone button, `/stt/transcribe` answers 503. |
| `stt.provider` | required | Name of an `openai-compatible` entry in `providers`. |
| `stt.model` | required | Model id the speech-to-text server expects. |
| `stt.language` | not set | Language hint such as `de` or `en`. Without it the model detects the language. A hint is faster and safer for short recordings. |
| `tts.enabled` | `false` | Turns spoken replies on. Off: no toggle, no Play buttons, `/tts/synthesize` answers 503. |
| `tts.provider` | required | Name of an `openai-compatible` entry in `providers`. |
| `tts.model` | required | Model id the text-to-speech server expects. |
| `tts.voice` | not set | Speaker for engines that use the OpenAI `voice` field. Sent as `alloy` when not set. |
| `tts.language` | not set | Language hint, passed on as `language`. |
| `tts.textPrefix` | not set | Text put in front of everything that is spoken. |
| `tts.agentVoices` | `{}` | Prefix per agent name. Replaces `textPrefix` for that agent. |
| `tts.cache.retentionDays` | `7` | Days a cached file is kept. `0` keeps files regardless of age. Range 0 to 3650. |
| `tts.cache.maxSizeMB` | `500` | Size limit of the cache folder. Minimum 1. |
| `tts.reencode.enabled` | `true` | Convert to Opus or AAC with `ffmpeg`. Off: WAV only. |
| `tts.reencode.opusBitrateKbps` | `24` | Opus bitrate. Range 8 to 256. |
| `tts.clients.web.autoPlayVoiceReplies` | `false` | First value of the toggle in the web client. |
| `tts.clients.web.allowUserOverride` | `true` | Show the toggle in the web client. |
| `tts.clients.mobile.autoPlayVoiceReplies` | `false` | First value of the toggle in the mobile app. |
| `tts.clients.mobile.allowUserOverride` | `true` | Show the toggle in the mobile app. |

## Routes

| Route | What it does |
|---|---|
| `GET /stt/config` | `{ enabled, language }`. Clients use it to decide about the microphone button. |
| `POST /stt/transcribe` | Multipart with `file` (the audio) and optional `language`. Returns `{ text }`. |
| `GET /tts/config` | `{ enabled, formats, language, voice, clients }`. Clients use it for the toggle. |
| `POST /tts/synthesize` | JSON with `text` (at most 4000 characters) and optional `voice`, `language`, `agent`. Returns the audio. |
| `GET /tts/cache/:filename` | Serves a cached file. Supports range requests for seeking. |
| `POST /voice/turn` | Audio in, audio out. See above. |

The web and mobile clients mark a dictated message on `POST /chat/send`
with `input_modality: "voice"` and ask for audio with
`auto_play_requested: true`. When the audio is ready, the session's
event stream carries an `assistant_audio` event with its address.

## Troubleshooting

**No microphone button, or it is greyed out.** `GET /stt/config`
returns `enabled: false`: `stt.enabled` is off, or `stt.provider` is
not an `openai-compatible` provider. Or the browser cannot record, which
is the case on plain HTTP. Use HTTPS.

**Nothing happens after recording.** The speech-to-text server did not
answer or returned an error. Look for `stt.upstream_unreachable` or
`stt.upstream_error` in the server log.

**No 🔊 toggle in the header.** `GET /tts/config` returns
`enabled: false`, or `allowUserOverride` is `false` for this client.

**No Play button on a dictated turn with auto-play on.** The reply was
judged not speakable. The log line `turn.auto_tts_skipped` gives the
reason. If creating the audio failed, the line is `turn.auto_tts_failed`.

**A request fails with 502 and "TTS upstream returned …".** The model
name is wrong, the speech server is down, or it rejects the request. The
log line `tts.upstream_error` contains the server's answer.

**"TTS re-encode failed" or `ffmpeg` messages.** Install `ffmpeg` on the
machine that runs somora, or set `tts.reencode.enabled: false` to use
WAV only.

**A changed setting has no effect.** Restart somora. `stt` and `tts`
are read at start.

## See also

- [Realtime voice](realtime-voice.md): live calls with an agent
- [Setup](setup.md): providers, speech-to-text, HTTPS via Tailscale
- [Mobile app](mobile.md): voice on the phone
- [Web client](web.md): the chat window and its header
- [API](api.md#voice): wire format of all voice routes and the
  `assistant_audio` event
