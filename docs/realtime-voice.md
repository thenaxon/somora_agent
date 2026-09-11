# Realtime voice — talking to an agent

A standing, interruptible conversation with one of your agents: it
listens while you speak, answers out loud, and you can talk over it.
Nothing like the dictation button — see the boundary below.

**Not the same as [voice.md](voice.md).** That page is press-to-talk:
one recording becomes one message you can edit before sending, and the
answer can be read back to you. This is a call. The two features share
no config, no endpoints and no clients, and both can be on at once.

## How it works

Two models, and the split is the whole point:

```text
you ──audio──► somora ──audio──► realtime model (talks)
                          │
                          └── "look this up" ──► your agent (knows)
                                                  persona, memory, tools
```

The realtime model runs the conversation: rhythm, listening,
interrupting, speaking. It has no memory, no files and exactly two or
three tools. Everything factual, and every request to act, it hands to
the real agent — which answers in its own session with its own model and
its own tools. The spoken answer is that answer, shortened for the ear.

That separation is why the voice can be quick without inventing things:
the part that talks does not know anything, and the part that knows does
not have to be fast at talking.

### What the agent sees

The question arrives in the bound session as a normal turn with
`from_system: 'voice'` — **not** as a message from another agent. The
agent answers into its own chat and addresses nobody back; the call
reads that answer and speaks it. Both clients render the question as its
own block, so a reader can tell it apart from something you typed.

Your own spoken sentences land in the same session, marked as spoken in
a call (`input.source: 'realtime'`), so a conversation can be read back
later and continued from the keyboard. What was actually said out loud is
kept beside the agent's written answer as a quiet aside — the written
text is the record, the spoken version is a rendering.

## The voice self

Each agent speaks as itself, in the first person. Its character is
derived from its own persona files, so nothing is maintained twice, plus
a small `voice:` block for what only speaking needs.

```yaml
# ~/.somora/agents/<name>/agent.yaml
voice:
  enabled: true            # may this agent be called at all
  voice: ash               # provider voice id (see below)
  language: de
  style: "trocken, direkt, kein Smalltalk"
  consultPolicy: always    # auto | substantive | always
  maxSpokenSentences: 4
```

For full control, write `~/.somora/agents/<name>/VOICE.md`: its text
replaces the derived character. The rules that keep the call honest —
ask before answering anything factual, never invent, never refuse work
on your own authority, speak in the first person — always stay.

Read what a call would actually send:

```bash
curl -s "http://127.0.0.1:18737/voice/instructions?agent=hans" | jq .
```

## Configuration

```yaml
realtimeVoice:
  enabled: true
  provider: openai            # openai | google | local (adapters)
  model: gpt-realtime-2.1-mini
  apiKeyFile: ~/.somora/secrets/openai-realtime.key   # a FILE, not the key
  transport: websocket
  defaultVoice: alloy
  consultPolicy: always
  maxCallMinutes: 20          # the meter runs while nobody speaks
  allowAgentSwitch: true      # hand a call to another agent mid-conversation
  turnDetection:              # how easily you can interrupt
    threshold: 0.4            # lower = reacts to quieter speech
    prefixPaddingMs: 200      # how much run-up counts as speech
    silenceDurationMs: 420    # pause that ends YOUR turn
```

The key lives in a file with `600` permissions, never in `config.yaml`:
a realtime key buys billed minutes, and the config is read by more eyes.

**Voices** (measured against the API, 2026-09-12): `alloy`, `ash`,
`ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`.
Anything else is refused with that list. They are not tied to a
language — each speaks German too — but they sound noticeably different,
so give agents different ones.

## In the web client

The **voice** tile appears only when realtime voice is configured and at
least one agent may be called. Pick agent and session, press **talk**,
allow the microphone.

- A figure driven by the real audio levels, both sides at once: the
  agent's from the playback in its colour, yours from the microphone.
- The state line says what is happening: listening, looking it up,
  talking — and counts the lookups, which is the honest measure of
  whether the voice self is really delegating.
- The clock runs, amber past three quarters of `maxCallMinutes`.
- The transcript follows the conversation and shows the sentence being
  spoken right now, dimmed.

The browser stays dumb: microphone in, speaker out, state on screen. It
holds no provider, no key, and never sees a tool call — the server owns
all of it.

## Handing the call to another agent

With `allowAgentSwitch: true`, say who you want: *"put me through to
lisa, in her projektA session"*. The call announces the handover, and
continues as that agent, with that agent's voice and session. Both
conversations keep a line saying where the call went and where it came
from.

Underneath it is a new connection, because a provider voice cannot be
changed once a session has produced audio. That is a deliberate second
of transition rather than two agents that sound alike.

## What it costs, and what it does not do

A call is billed per minute of connection, including silence — hence
`maxCallMinutes`. The agent's own turns are billed as usual, separately.
A ChatGPT or Codex subscription does **not** cover the realtime API; it
needs its own key.

Not in this version: the mobile client, several calls at once, and a
call without a bound session. The provider contract carries a second
transport (WebRTC, audio straight from the browser) for later; today
everything goes through somora so tool execution has exactly one path.
