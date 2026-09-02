# Sampling Parameters

`temperature`, `top_p` and their relatives decide how much the model
dices while it writes. Vendors publish recommendations per model
(DeepSeek V4 for agentic work: `temperature 1.0`, `top_p 0.95`), an
agent that writes prose wants different values than one that edits
code, and a session sometimes needs a quick experiment. somora carries
these settings the same way it carries the thinking level — three
layers, later ones win per key:

| Layer | Where | Scope |
|---|---|---|
| Model default | `config.yaml`, model entry, `sampling:` | every call on that model, including REM / Deep / Lucid workers |
| Agent default | `agent.yaml`, `sampling:` | chat turns of that agent |
| Session override | `/sampling …`, `/temp …` | one session, persisted in its meta |

Only the `openai-compatible` engine sends them. `claude-cli`,
`codex-cli` and `grok-cli` expose no such knobs; on those engines the
setting is dormant and the clients say so (`sampling (dormant)`).

## Keys

| Key | Range | What it does |
|---|---|---|
| `temperature` | 0 – 2 | Boldness of the dice. Low = predictable, high = varied. |
| `top_p` | 0 – 1 | Nucleus sampling: keep the most likely tokens that add up to this probability mass. |
| `top_k` | ≥ 1 | Keep only the k most likely tokens. vLLM / SGLang / most local servers; OpenAI ignores it. |
| `min_p` | 0 – 1 | Drop tokens below this fraction of the top token's probability. Local servers. |
| `frequency_penalty` | -2 – 2 | Penalise tokens by how often they already appeared. |
| `presence_penalty` | -2 – 2 | Penalise tokens that appeared at all. |
| `repetition_penalty` | > 0 | Multiplicative repetition penalty (vLLM style). |
| `seed` | integer | Reproducible sampling where the backend supports it. |
| `stop` | string or up to 4 strings | Stop sequences. |

Every key travels under its own name at the top level of the request.
somora does not translate between vendors; a key the backend does not
know is the backend's business — see *Rejections* below.

## Configuration

```yaml
# config.yaml — vendor recommendation as the model's default
providers:
  local:
    engine: openai-compatible
    models:
      - id: some-deepseek-model
        alias: flash
        contextWindow: 131072
        capabilities: [text, reasoning]
        sampling:
          temperature: 1.0
          top_p: 0.95
```

```yaml
# agent.yaml — this agent writes prose, wants it looser
model: flash
sampling:
  temperature: 1.3
```

```
/sampling                       show effective values + where they come from
/sampling temperature=0.7       set one key for this session (merges into the override)
/sampling top_p=0.9 seed=42     several keys at once
/sampling temperature=null      drop one key from the override
/sampling default               clear the whole override
/temp 0.7                       shorthand for /sampling temperature=0.7
/temp default                   drop temperature from the override
```

The web header shows `🌡 1.0` (the effective temperature) next to the
thinking badge; hovering lists every effective key.

## Rejections

A backend that does not accept a key answers HTTP 400 — OpenAI does on
its reasoning models for `temperature`, vLLM does for an out-of-range
`top_k`. somora does not let a tuning knob fail a turn: on such an
error it sends the request again once **without any sampling
parameters**, logs `engine.sampling_rejected` with the backend's text,
and the turn shows an `engine_meta` line ("sampling dropped") naming
the values it dropped. The drop lasts for that turn only; remove the
offending key from the model, agent or session block to make it
permanent.

Behind a router that normalises parameters (LiteLLM with
`drop_params: true`) a key may be silently removed before the backend
sees it — the same caveat as for the thinking level in
[thinking.md](thinking.md). Verify with a direct probe when a value
seems to have no effect.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/agents/:agent/sessions/:session/sampling` | effective values, override, agent default, model default, `source`, `engineSupportsSampling` |
| PUT | same | body `{ "temperature": 0.7 }` — merges into the override; a `null` value drops that key |
| DELETE | same | clears the override |

```json
{
  "agent": "<your-agent>",
  "session": "main",
  "effective": { "temperature": 0.7, "top_p": 0.95 },
  "override": { "temperature": 0.7 },
  "personaDefault": null,
  "modelDefault": { "temperature": 1.0, "top_p": 0.95 },
  "source": "session-override",
  "engineSupportsSampling": true
}
```

`source` names the topmost layer that contributed anything:
`session-override | persona-default | model-default | engine-default`.

## What is deliberately not here

- **`max_tokens`** is a budget, not a sampling choice; it lives on the
  model as `maxTokens` (see [setup.md](setup.md)).
- **Per-vendor translation** of key names. The OpenAI-compatible
  surface is the contract; a router that fronts other APIs translates
  on its side.
- **Validation against the model's real capabilities.** somora cannot
  know which keys a given backend honours; the retry keeps a wrong
  guess harmless, the log tells you it happened.
