# Decision models

A decision model does not write text. It answers questions you define
about a state you supply, with probabilities: yes or no, one of several
choices, or a position on a scale. somora gives agents a tool for it,
`decision_evaluate`.

## What you get

- **Typed answers instead of prose.** A probability for yes, the chosen
  label with the full distribution, or a fractional position on your
  scale. An agent can compare them against a threshold.
- **Fast and cheap per question.** A short request takes a fraction of a
  second, so an agent can sort many similar items without a chat model
  reading each one.
- **Images, when the model reads them.** An agent can ask "is there a red
  car in this photo?" about a picture it was sent or took itself.
- **No silent cut-offs.** An input over the limit is refused with the
  token count, never evaluated in part.

## Set it up

Add a `decisions` block to `config.yaml`. `model` names the entry the
tool uses:

```yaml
decisions:
  model: clef
  models:
    - name: clef
      baseUrl: https://<your-host>/clef      # requests go to <baseUrl>/v1/systemone
      apiKey: <key>                          # leave out for a server without authentication
      model: clef
      capabilities: [text, image]
```

Reload the config or restart the server. Every agent then has
`decision_evaluate`, unless you switch it off for an agent in the
Abilities window. Without a `decisions.model`, no agent sees the tool.

## Which models work

somora speaks the System One API: `POST <baseUrl>/v1/systemone`. The
models page lists the decision models somora was run with.

| Model | Where it runs | Images | Checked with somora |
|---|---|---|---|
| Clef | Self-hosted, Cloudflare's open decision model | yes | yes |
| Jev | TypeSafe AI, hosted | no, text only | no |

Jev was not tested with somora. By its public description it speaks the
same API, so the same block with Jev's address, key and model name
should work. Treat it as untested.

## How an agent uses it

The agent sends a `state` and a map of `questions`. The state is text, a
JSON object or array. Each question has a type:

| Type | The agent writes | The answer |
|---|---|---|
| `boolean` | `instructions`, or `criteria.true` and `criteria.false`, or both. One of them is required: the question id is not read. | `probabilityTrue` from 0 to 1 |
| `choice` | `criteria`: 2 to 255 labels with descriptions | `choice`, `confidence` and every label's probability |
| `score` | `criteria`: 2 to 10 ordered levels, lowest first | `score` from 0 to `max`, `confidence` and each level's probability |

```json
{
  "state": "Checkout throws errors, orders do not go through.",
  "questions": {
    "outage": { "type": "boolean", "instructions": "Is a service down?" },
    "team": { "type": "choice", "criteria": { "billing": "Payments and invoices", "technical": "Bugs and outages" } },
    "urgency": { "type": "score", "criteria": ["can wait", "this week", "today"] }
  }
}
```

A call takes 1 to 256 questions. They are independent and answered in
one pass. A question that
depends on another answer needs a second call. Question ids only label
the answers: the meaning goes into `instructions` and `criteria`.

A score is a position, not a percentage. With three levels, `max` is 2,
and a score of 1.87 sits close to the top level.

On the wire the yes/no type is called `noul`. Agents write `boolean`;
somora translates both ways.

## Images

With `image` in the model's `capabilities`, the tool takes up to four
image paths in `images`. The tool reads the files itself and scales each
one like any image shown to a model, to `attachments.maxImageEdge`
pixels on the longest side. PNG, JPEG and WebP are accepted. Without the
capability, agents do not see the `images` field.

For a picture sent in the chat, the agent uses the original path named
in the message. The image handling page explains which file is which.

Paths go in the top-level `images` field. Image paths put inside the
`state` would reach the model as text, so such a call is refused with
`unsupported-input` and nothing is sent. After scaling, each image may
be at most 4 MB and 16 megapixels, all images together at most 8 MB.
The files are read under the same rules as `file_read`.

Each image counts toward the input limit. One scaled image costs about
3 000 tokens.

## Limits and time

The input limit is the lower of two numbers: `maxInputTokens` from your
config, and what the server reports at `GET <baseUrl>/v1/models`. With
neither, the server decides. somora reads the server's value at most
every ten minutes, so a change there takes effect without a restart.

Before sending, somora estimates the size and refuses a clearly too long
input. A server that rejects an input as too long (HTTP 413) passes its
error message on, or the limit when it sends none. A server that cuts
the input off silently is caught too: when it reports exactly its limit
as the tokens read, the answers are discarded. When the server allows
more than your `maxInputTokens`, its exact count is checked against
yours after the call.

Long inputs and images take time. A short request answers in well under
a second; several images or tens of thousands of tokens take tens of
seconds, and long requests queue behind each other. `timeoutMs` defaults
to 90 seconds for that reason.

## What comes back

A successful call returns the answers by question id, with the tokens
read and the limit that applied:

```json
{
  "status": "ok",
  "model": "clef",
  "answers": {
    "outage": { "type": "boolean", "probabilityTrue": 0.93 },
    "team": { "type": "choice", "choice": "technical", "confidence": 0.88, "probabilities": { "billing": 0.12, "technical": 0.88 } },
    "urgency": { "type": "score", "score": 1.87, "max": 2, "confidence": 0.8, "probabilities": [0.02, 0.09, 0.89], "legend": ["can wait", "this week", "today"] }
  },
  "usage": { "inputTokens": 412, "outputTokens": 0 },
  "inputLimit": 16000,
  "ms": 240
}
```

## When it does not answer

A result is either `ok` or `unavailable`. An unavailable result names a
`reason`, adds `guidance` (what to do) and often a `detail`. A failure never counts as a no.

| Reason | Meaning |
|---|---|
| `not-configured` | No `decisions.model` is set. |
| `images-unsupported` | Images were sent to a model without the `image` capability. |
| `authentication` | The server rejected the key. |
| `rate-limited` | The server asks to slow down. |
| `not-ready` | The server is up but the model is not, for example not loaded right now. |
| `transport` | The server could not be reached, or answered with an unexpected HTTP error. |
| `too-long` | The input exceeds the limit. Nothing was sent, or the server's answers were discarded because its exact count was above your `maxInputTokens`. |
| `truncated` | The server cut the input off. The answers were discarded. |
| `unsupported-input` | The request was rejected, or an image could not be used. |
| `invalid-response` | The answers did not match the questions. |
| `deadline` | No answer within `timeoutMs`. |

There is no automatic fallback to another model. The agent carries on
without the answer or tries again later.

## Settings

```yaml
decisions:
  model: ""          # the entry in use; empty turns the tool off
  models: []
```

| Setting | Default | Meaning |
|---|---|---|
| `decisions.model` | empty | Name of the entry `decision_evaluate` uses. Must match one of `models`. |
| `models[].name` | required | Short handle. Letters, digits, `-` and `_`. |
| `models[].baseUrl` | required | Server root. Requests go to `<baseUrl>/v1/systemone`. |
| `models[].apiKey` | unset | Sent as `Authorization: Bearer`. Leave out when the server needs none. |
| `models[].model` | required | Sent as the request's `model` field. |
| `models[].maxInputTokens` | unset | Your input limit. When the server reports a lower one, that applies. |
| `models[].capabilities` | `[text]` | Add `image` for a model that reads images. |
| `models[].timeoutMs` | `90000` | Longest wait for one evaluation, 5 000 to 600 000. |

Each call writes one `decision.evaluate` line to the server log: model,
number of questions and images, time, tokens and the result. The state
and the questions are not logged.

## See also

- [Image handling](image-handling.md): which image file an agent is shown and which it hands on
- [Models](models.md): the models somora was run with, decision models included
- [Tools](tools.md): every tool, and how to switch tools off per agent
- [Agents](agents.md): the Abilities window and per-agent settings
