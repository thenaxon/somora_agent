# Sampling

Sampling parameters such as `temperature` and `top_p` decide how freely
a model picks its next word. Low values give predictable text, high
values give varied text. somora lets you set them per model, per agent
and per session.

## What you get

- **The vendor's recommendation in one place.** Put the values a model
  was tuned for on the model entry and every agent on it uses them.
- **A different style per agent.** An agent that writes prose can run
  looser than one that edits code, on the same model.
- **Quick experiments.** `/temp 0.7` changes one session only.
- **A wrong value never fails a turn.** When the backend rejects a
  parameter, somora sends the request again without sampling and tells
  you.

> **Note:** Only the `openai-compatible` engine sends sampling
> parameters. `claude-cli`, `codex-cli` and `grok-cli` have no such
> knobs. On those engines the setting is stored but dormant, and
> `/sampling` answers with a `dormant` warning.

## Try it

In a session on an `openai-compatible` model, in the TUI or the web
client:

```
/temp 0.7
/sampling
```

The first line sets the temperature for this session. The second shows
the values in effect and where they come from.

## The three layers

| Layer | Where | Applies to |
|---|---|---|
| Model default | `config.yaml`, model entry, `sampling:` | every call on that model |
| Agent default | `agent.yaml`, `sampling:` | chat turns of that agent |
| Session override | `/sampling`, `/temp` or the HTTP API | one session, stored with the session |

Later layers win, key by key. When no layer sets anything, somora
sends no sampling parameters and the backend uses its own defaults.

Background workers use the model default only: REM, Deep, Lucid and the
vision worker behind `analyze_file`.

## Set a default

On the model, in `config.yaml`:

```yaml
providers:
  local:
    engine: openai-compatible
    models:
      - id: some-model
        alias: flash
        contextWindow: 131072
        capabilities: [text, reasoning]
        sampling:
          temperature: 1.0
          top_p: 0.95
```

On the agent, in `agent.yaml`:

```yaml
model: flash
sampling:
  temperature: 1.3
```

An unknown key or a value out of range is a configuration error.

## When the backend rejects a value

Every key goes into the request under its own name. somora does not
translate between vendors and cannot know which keys a backend accepts.
Some reasoning models refuse `temperature`, and a local server may
refuse an out-of-range `top_k`. The backend then answers HTTP 400.

In a chat turn somora sends the request again once, without any
sampling parameters. The chat shows an `engine_meta` line, "sampling
dropped", that names the values it left out. The drop holds for the
rest of that turn. The next turn tries your values again, so remove the
offending key to end the retries.

Background workers do not retry this way. A rejected model default
fails their call.

> **Tip:** A router that normalises parameters, such as LiteLLM with
> `drop_params: true`, may remove a key silently. When a value seems to
> have no effect, send a request to the backend directly and compare.

## Settings

The same keys are valid on a model entry in `config.yaml` and at the
top level of `agent.yaml`. Every key is optional and has no default.

| Key | Allowed values | What it does |
|---|---|---|
| `temperature` | 0 to 2 | Randomness. Low is predictable, high is varied. |
| `top_p` | 0 to 1 | Keeps the most likely tokens that add up to this share of probability. |
| `top_k` | integer, 1 or more | Keeps only the k most likely tokens. Known to vLLM, SGLang and most local servers. OpenAI does not know it. |
| `min_p` | 0 to 1 | Drops tokens below this fraction of the top token's probability. Local servers. |
| `frequency_penalty` | -2 to 2 | Penalises tokens by how often they already appeared. |
| `presence_penalty` | -2 to 2 | Penalises tokens that appeared at all. |
| `repetition_penalty` | greater than 0 | Multiplicative repetition penalty, vLLM style. |
| `seed` | integer | Reproducible output where the backend supports it. |
| `stop` | one string, or a list of up to 4 | Stop sequences. |

The output limit is not a sampling key. It is `maxTokens` on the model
entry, sent as `max_tokens`.

## Commands

These work in the TUI and in the web client. Neither shows the
temperature permanently. The mobile app has no sampling commands.

| Command | What it does |
|---|---|
| `/sampling` | Shows the values in effect and the layer they come from. |
| `/sampling temperature=0.7` | Sets one key for this session. Other keys of the override stay. |
| `/sampling top_p=0.9 seed=42` | Sets several keys at once. |
| `/sampling temperature=null` | Removes one key from the override. `-` works like `null`. |
| `/sampling default` | Clears the whole override. |
| `/temp 0.7` | Short for `/sampling temperature=0.7`. |
| `/temp default` | Removes only the temperature from the override. |

Several stop sequences are separated by commas, without spaces:
`/sampling stop=END,STOP`. One bad token rejects the whole command.

## Routes

| Method | Path | What it does |
|---|---|---|
| GET | `/agents/:agent/sessions/:session/sampling` | Returns the effective values and each layer. |
| PUT | `/agents/:agent/sessions/:session/sampling` | Merges the body into the session override. A `null` value removes that key. |
| DELETE | `/agents/:agent/sessions/:session/sampling` | Clears the session override. |

`GET` answers:

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

`personaDefault` is the agent layer. Each layer is `null` when it sets
nothing. `source` names the topmost layer that sets anything:
`session-override`, `persona-default`, `model-default` or
`engine-default`. `engineSupportsSampling` is `true` when the session's
current model runs on `openai-compatible`.

`PUT` takes a body such as `{ "temperature": 0.7, "top_p": null }` and
answers `{ agent, session, override }`. `DELETE` answers
`{ agent, session, cleared: true }`.

An unknown agent or session gives 404. A `PUT` with an empty body, an
unknown key or a value outside the allowed range gives 400.

## Troubleshooting

**A value has no effect.** Run `/sampling`. A `dormant` warning means
the session's model is not on the `openai-compatible` engine. A session
override also hides the agent default for its keys.

**"sampling dropped" appears in the chat.** The backend rejected a key.
The server log has the backend's own message under
`engine.sampling_rejected`.

## See also

- [Models](models.md): model entries and recommended sampling values
  per model family
- [Thinking](thinking.md): the thinking level, set in the same three
  layers
- [Agents](agents.md): everything else in `agent.yaml`
- [Setup](setup.md): `maxTokens` and the rest of the model entry
- [API](api.md): all session routes
