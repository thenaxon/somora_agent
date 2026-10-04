# Realtime voice

A call with one of your agents. It listens while you speak, answers out
loud, and you can talk over it. A fast speech model does the talking.
Your agent, with its memory and tools, supplies the answers.

> **Note:** This page is not about dictation. The microphone button
> that turns one recording into one message, and replies that are read
> back, are described in [Voice](voice.md). The two features share no
> settings and can both be on.

## What you get

- **A real conversation.** No button to hold. Interrupt the agent
  mid-sentence and it stops and listens.
- **Answers from the agent, not from the voice.** Everything factual
  and every request to act goes to the real agent, in its own session,
  with its own model and tools.
- **No waiting on long work.** If the agent needs longer than a few
  seconds, the voice says it passed the request on and keeps talking.
  The answer is read out when it arrives.
- **Each agent sounds like itself.** Its own voice, language and tone,
  with a character taken from the persona files it already has.
- **Move the call by saying so.** Ask for another agent or another
  session and the call continues there.
- **A clean record.** The session keeps the question and the answer,
  like any other turn. The small talk around it is not stored.

## Set it up

You need a key for the OpenAI realtime API, or a service of your own
that speaks the same protocol (see "Using your own voice service").

1. Put the key into a file only you can read:

   ```bash
   mkdir -p ~/.somora/secrets
   echo "<your-key>" > ~/.somora/secrets/openai-realtime.key
   chmod 600 ~/.somora/secrets/openai-realtime.key
   ```

2. Add this block to `~/.somora/config.yaml`:

   ```yaml
   realtimeVoice:
     enabled: true
     model: gpt-realtime-2.1-mini
     apiKeyFile: ~/.somora/secrets/openai-realtime.key
   ```

3. Allow at least one agent to be called, in
   `~/.somora/agents/<name>/agent.yaml`:

   ```yaml
   voice:
     enabled: true
   ```

4. Restart somora.
5. Open the web client. A **voice** tile is now on the desktop. Pick
   agent and session, press **talk** and allow the microphone.

The browser only allows the microphone on a secure address. Serve
somora over HTTPS, or open it on `localhost`.

## How a call works

```text
you ──audio──► somora ──audio──► realtime model (talks)
                          │
                          └── "look this up" ──► your agent (knows)
                                                  persona, memory, tools
```

The realtime model runs the conversation: listening, being interrupted,
speaking. It has no memory and no files. It can ask the agent, check on
running work, fetch a late answer and, when allowed, move the call.

The agent answers in its own session. What you hear is that answer,
shortened for the ear. This split is why the voice can be quick without
inventing things: the part that talks knows nothing, and the part that
knows does not have to be fast.

A call is always bound to one agent and one existing session.

## What happens to a question

The question arrives in the bound session as a normal turn, marked as
coming from the voice channel (`from_system: 'voice'`), not as a message
from another agent. The agent answers into its own chat. The web client
and the TUI show the question as its own `voice` row, so you can tell it
apart from something you typed.

The last six lines of the call travel with the question. Without them,
"how long does that take" would mean nothing to the agent.

The question queues on the session like every other turn. The call
waits `realtimeVoice.consult.quickAnswerMs` in total, for the session to
be free and for the answer together.

| The answer comes | What you hear |
|---|---|
| Inside the wait | The voice tells you the substance at once, in at most `maxSpokenSentences` sentences, with the names, facts and numbers as the agent gave them. Lists and paths are not read aloud. |
| Later | The voice says it handed the request over and keeps talking. Nothing is cancelled. The work stays in the queue or keeps running. |

## Late answers

A handed-over answer reaches you in one of two ways.

**The call reads it out.** At the next pause the voice says that this
is the answer to your earlier question, then gives it. If the voice is
mid-sentence at that moment, the reading is kept and spoken as soon as
it falls silent. It is read once, only in the call that asked, and only
while that call still talks to the same agent.

**You ask.** Ask whether it is done and the voice fetches the answer. It
is then not read out a second time. Ask how far along the agent is and
the voice reports the running work and each handed-over request with
its place in the queue.

Good to know:

- A request that was stopped or removed from the queue is announced the
  same way, with the reason.
- Work the agent started for your question and finished after its
  answer was read, such as a sub-agent or a question to another agent,
  is read out once as a follow-up to that question.
- If you hang up first, the answer still lands in the session's chat.
  Hanging up cancels nothing.

## What the session records

One question, one answer, the same trace a request from another agent
leaves. Your sentences as you said them and the spoken version of the
answer live for the length of the call and are not written.

The note that tells the agent "this comes from a voice call", and the
lines of the call that go with it, travel beside the question, not
inside it. The model reads both. The session stores only what was
asked, so memory search and the dream phases are not fed boilerplate.

The voice also passes on remarks, not only requests. A decision, a
date or "that project is history" goes to the agent as a short note, so
it lands in the record and can be remembered.

## The voice self

Each agent speaks as itself, in the first person. Its character comes
from its own persona files, so nothing is maintained twice. A small
`voice:` block in `agent.yaml` holds what only speaking needs.

```yaml
# ~/.somora/agents/<name>/agent.yaml
voice:
  enabled: true
  voice: ash
  language: de
  style: "dry, direct, no small talk"
  consultPolicy: always
  maxSpokenSentences: 4
```

What the talking model is told:

| Part | Where it comes from |
|---|---|
| Language | `voice.language` of the agent, else `stt.language`, else English. Named in full, for example "German". |
| Character | A short sketch from the persona, plus `voice.style` as the tone. |
| Who is on the line | The opening of the agent's `USER.md`: everything before the first `##` section, up to 280 characters. Put the name and how to address the person there. No `USER.md`, no such line. |
| Day and time | When the call started. For the exact time later, it asks the agent. |

The voice does not introduce itself. It answers the first thing you
say. Handed a call, it says one short sentence that it is there.

### Writing the character yourself

Write `~/.somora/agents/<name>/VOICE.md` and its text replaces the
derived character and tone. A frontmatter block and heading lines in
the file are ignored.

The rules that keep a call honest always stay: ask the agent before
answering anything factual, never invent, never refuse work on your own
authority, speak in the first person.

### Reading what the voice is told

In the web client, right-click an agent. The agent window has a
**Voice prompt** tab next to the persona files. It shows the whole
instruction, whether the character came from `VOICE.md` or was derived,
and the voice, language and consult policy. The tab only exists for
agents that can be called.

The same over HTTP:

```bash
curl -s "http://127.0.0.1:18737/voice/instructions?agent=<your-agent>" | jq .
```

## The call window

| Part | What it shows |
|---|---|
| **Pickers** | Agent and session, before the call. During a call they become a fixed line with agent, session and the clock. |
| **Figure** | Moves with the real audio levels of both sides: the agent's playback in its colour, yours from the microphone. |
| **State line** | `listening`, `looking it up…`, `<agent> is talking`, and how often the agent was asked. That count tells you whether the voice really delegates. |
| **Clock** | Runs from the start. Amber past three quarters of `maxCallMinutes`, red shortly before the limit. |
| **Buttons** | **talk** starts. During a call: mute the microphone, and **end**. |
| **Transcript** | Follows the conversation. The sentence being spoken right now is dimmed. |

Closing the window or the tab ends the call. The browser holds no key
and never sees a tool call. The server owns all of it.

## Moving the call

With `allowAgentSwitch: true`, say where you want to go:

- **Another agent:** "put me through to bea"
- **Another session of the same agent:** "go into your projektA
  session"

| Rule | Detail |
|---|---|
| Where you land | In the session you named. Name none and you land in `main`. The session you are in is never carried over to another agent. |
| Who can be reached | Agents with `voice.enabled`. |
| The record | Both conversations get a line saying where the call went and where it came from. |
| The name in the window | Changes when the new agent is actually on the line, not while the previous one still finishes its sentence. |
| When it fails | The call comes back with the agent you had and says why. It does not hang up. |

Session names are matched by how they sound. A session called
`projekt-alpha` is found when the transcript says `Projekt Alpha`,
`projektalpha` or just `alpha`. Case, hyphens, spaces and umlauts are
ignored, a fragment of four or more letters is enough, and a near miss
still counts. Two sessions that sound equally close lead to a question,
not a guess.

> **Note:** Matching by sound applies to calls only. A session name
> typed into a command or an API call still means exactly what it says.

A move opens a new connection, because a provider voice cannot change
once it has spoken. Expect a second of transition.

## Using your own voice service

`provider` names the protocol, not the vendor. `openai` and `local` use
the same adapter. One talks to OpenAI, the other to a service of your
own that speaks the same protocol. Agents, tools, moving the call and
the record work the same.

```yaml
realtimeVoice:
  enabled: true
  provider: local
  url: ws://127.0.0.1:8787/realtime
  model: my-voice-model
```

- `provider: local` requires `url`.
- The model id is appended as `?model=…`. A service with one model can
  ignore it.
- Without `apiKeyFile` no `Authorization` header is sent, so a service
  on your own machine needs no credential. OpenAI's own endpoint
  refuses to connect without a key.
- `ws://` is meant for a service on the same machine. Use `wss://` for
  anything reachable from outside.

What the service has to speak, over one websocket, with audio as PCM16
at 24 kHz:

| Direction | Events |
|---|---|
| somora sends | `session.update` (instructions, voice, tools, turn detection, transcription of your audio), `input_audio_buffer.append`, `conversation.item.create` with a `function_call_output`, `response.create`, `response.cancel` |
| somora reads | `session.created`, `session.updated`, `input_audio_buffer.speech_started`, `input_audio_buffer.speech_stopped`, `conversation.item.input_audio_transcription.completed`, `response.output_audio.delta`, `response.output_audio_transcript.delta`, `response.output_audio_transcript.done`, `response.function_call_arguments.done`, `response.created`, `response.done`, `error` |

## Cost and limits

- **Billed by connection time.** A call costs per minute, silence
  included. `maxCallMinutes` ends it. The limit counts from the start
  of the call and is not reset by a move.
- **The agent's turns are billed separately**, as usual.
- **A ChatGPT or Codex subscription does not cover the realtime API.**
  It needs its own key.
- **One call at a time.** A second window is refused and told who is on
  the line.
- **Web client only.** The mobile app and the TUI cannot make calls.
- **Audio goes browser, somora, provider.** Tools therefore run in
  exactly one place, the server. `realtimeVoice.transport` reflects
  this and has one working value.

## Settings

In `~/.somora/config.yaml`:

```yaml
realtimeVoice:
  enabled: false
  provider: openai
  model: <model-id>             # required, no default
  # apiKeyFile: ~/.somora/secrets/openai-realtime.key
  # url: ws://127.0.0.1:8787/realtime
  transport: websocket
  defaultVoice: alloy
  consultPolicy: always
  maxCallMinutes: 20
  allowAgentSwitch: false
  consult:
    quickAnswerMs: 8000
  turnDetection:
    threshold: 0.4
    prefixPaddingMs: 200
    silenceDurationMs: 420
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turns calls on. Off: no voice tile, no agent can be called. |
| `provider` | `openai` | `openai` or `local`. `google` is accepted but has no adapter, so a call fails. |
| `model` | required | Model id of the realtime model. |
| `apiKeyFile` | not set | Path to a file that holds the key. Required for OpenAI. The key never goes into `config.yaml`: it buys billed minutes, and the config is read by more eyes. |
| `url` | not set | Where to connect. Must start with `wss://` or `ws://`. Not set means OpenAI. Required for `local`. |
| `transport` | `websocket` | The only transport somora uses. `webrtc` is accepted and changes nothing. |
| `defaultVoice` | `alloy` | Voice for agents that name none. |
| `consultPolicy` | `always` | When the voice must ask the agent. See below. |
| `maxCallMinutes` | `20` | Hard stop for one call. Range 1 to 180. |
| `allowAgentSwitch` | `false` | Allow moving a call to another agent or session. |
| `consult.quickAnswerMs` | `8000` | How long a spoken question waits before it is handed over. Range 1000 to 120000. |
| `turnDetection.threshold` | `0.4` | How loud speech must be to count. Lower reacts to quieter speech. Range 0 to 1. |
| `turnDetection.prefixPaddingMs` | `200` | How much run-up counts as speech. Shorter reacts sooner. Range 0 to 2000. |
| `turnDetection.silenceDurationMs` | `420` | The pause that ends your turn. Range 100 to 5000. |

The older keys `consult.lockPatienceMs` and `consult.answerPatienceMs`
are ignored. `quickAnswerMs` replaces both.

Consult policies:

| Value | The voice asks the agent |
|---|---|
| `always` | For everything factual and every request to act. Only greeting, small talk and who it is need no lookup. |
| `substantive` | For anything about work, memory, files or projects, and every request to act. Clarifying questions are also free. |
| `auto` | Whenever it judges that the answer needs files, tools or memory. |

Per agent, under `voice:` in `agent.yaml`:

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | May this agent be called. Without a `voice:` block the agent cannot be called and is not in the picker. |
| `voice` | `defaultVoice` | Voice id of the provider. |
| `language` | `stt.language`, else `en` | Spoken language, as a code such as `de`. |
| `style` | not set | One line on how the agent sounds. At most 400 characters. |
| `consultPolicy` | the global value | Overrides `realtimeVoice.consultPolicy` for this agent. |
| `maxSpokenSentences` | `4` | Longest spoken answer. Range 1 to 10. |

**Voices** on OpenAI: `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`,
`shimmer`, `verse`, `marin`, `cedar`. The provider refuses anything
else. They are not tied to a language, but they sound clearly
different, so give each agent its own.

## Tools of the voice

These exist only inside a call. No agent can use them, and they are not
in the tool list of an agent.

| Tool | What the voice uses it for |
|---|---|
| `somora_agent_consult` | Ask the agent or have it do something. Takes `question` and an optional `context` line. |
| `somora_work_status` | "How far are you?" Returns at once and starts nothing. |
| `somora_consult_result` | Fetch a handed-over answer by its `consult_id`. |
| `somora_switch_agent` | Move the call. Takes `agent` and an optional `session`. Only present with `allowAgentSwitch`. |

## Routes

| Route | What it does |
|---|---|
| `GET /voice/status` | Whether calls are on, which agents can be called, running calls. Answers `enabled: false` with status 200 when off. |
| `GET /voice/instructions?agent=…&session=…` | What the talking model would be told, without starting a call. `session` defaults to `main`. 503 when calls are off, 404 when the agent has no voice. |
| `WS /voice/attach?agent=…&session=…` | The call itself: audio and state as JSON frames. Closing the socket ends the call. |

## Troubleshooting

**No voice tile.** `GET /voice/status` returns `enabled: false` or an
empty `agents` list. Set `realtimeVoice.enabled` and give at least one
agent a `voice:` block.

**"already on a call with …".** One call runs at a time. End the other
one first.

**"no realtime key: set realtimeVoice.apiKeyFile".** OpenAI needs a
key file. An empty file is reported as empty.

**"provider 'local' needs realtimeVoice.url"** or **"has no adapter
yet".** Set `url` for `local`. `google` cannot be used.

**"session '…' not found".** A call never creates a session. Start it
in a session that exists.

**The call ends by itself.** `maxCallMinutes` was reached. The log line
`voice.call_closed` gives the reason.

**Hard to interrupt, or it cuts you off.** Lower
`turnDetection.threshold` to react to quieter speech. Raise
`silenceDurationMs` if it answers before you have finished.

**The voice answers without asking the agent.** Look at the lookup
count in the state line. Set `consultPolicy: always`, and check the
**Voice prompt** tab if you wrote a `VOICE.md`.

**A late answer was not read out.** The call had ended or moved to
another agent. The log line `voice.consult_delivery_skipped` gives the
reason. The answer is in the session's chat.

## See also

- [Voice](voice.md): dictation and spoken replies in the chat
- [Web client](web.md): the desktop, tiles and the agent window
- [Agents](agents.md): persona files and `agent.yaml`
- [Setup](setup.md): HTTPS via Tailscale
- [API](api.md#realtime-voice): the frames of `/voice/attach` and the
  answers of the two `GET` routes
