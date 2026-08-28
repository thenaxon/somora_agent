# Image generation

Text-to-image against an OpenAI-shaped image endpoint. Both a human and
an agent drive the **same code path** — the web app's Media window
POSTs to `/images/generate`, agents call the `image_generate` tool —
so the two can't end up able to do different things.

Off by default. Nothing appears in the UI and no tool is exposed until
`imageGen` is configured.

## Nothing appears until it is configured

There is no image surface at all until an `imageGen` block with at least
one model exists. That holds in three independent places, and all three
are checked:

- **the model's tool list** — `image_generate` and friends are not
  offered, so they cost no context and cannot be called;
- **HTTP** — `/images/*` answers `503`;
- **the desktop** — the Media tile stays hidden, and the window says so
  rather than opening an empty form.

The same applies per agent: `tools: deny: [toolset:image]` in an
agent.yaml removes the tools for that agent on every engine.

## What is verified, and what is not

Everything in this document runs daily against a **self-hosted,
OpenAI-shaped endpoint** — a LiteLLM router in front of local models.
Verified there end to end: both wire dialects, reference images as
multipart, catalog-driven capabilities, the `503`-means-busy path, and
the fallback chain.

**Not yet tested against a live hosted account.** The `openai` dialect
is written to OpenAI's published API and its shape has been exercised
against a faithful local stand-in, but nobody has run it against
`api.openai.com` yet. It is expected to work; it is not proven to. If
you try it, the interesting bits are the response shapes — that is where
providers differ most.


## Configure

Image models are **not** listed in `providers.<x>.models`. Same posture
as STT and TTS: a model listed there becomes selectable as a
conversation model, shows up in pickers and `/v1/models`, and fails on
the first turn. It's a separate service surface, and it reuses an
existing provider only for its `baseUrl` and `apiKey`:

```yaml
providers:
  openrouter:
    engine: openai-compatible
    baseUrl: https://openrouter.ai/api/v1
    apiKey: <YOUR_OPENROUTER_KEY>
    models: [...]           # chat models, unrelated to the below

imageGen:
  enabled: true
  outputDir: ~/somoraworkspace/images
  maxImagesPerTurn: 5
  models:
    - name: grok-imagine                    # handle used by tool + UI
      provider: openrouter                  # ← baseUrl + apiKey from here
      model: x-ai/grok-imagine-image-2.0
      label: "Grok Imagine 2.0"
      defaults:
        resolution: 1K
        aspect_ratio: "16:9"
        output_format: png
```

**Which API key gets used**: the one on the provider the model points
at. No second key, no duplicated connection details. If you want image
generation billed separately, define a second provider entry with the
same `baseUrl` and a different key, and point `provider:` at that.

**Adding a model** needs three things: a handle, the provider it goes
through, and the wire id. `GET /images/catalog` lists what the provider
currently offers, so you don't have to hunt for the exact id — the
Media window surfaces it too. Config stays the source of truth for
what somora will actually call.

**Endpoint paths differ by provider.** The default `/images` is
OpenRouter's; OpenAI direct wants `/images/generations`. Set
`endpoint:` per model when it differs, and `capabilitiesEndpoint: null`
when the provider has no model catalog at all (a local image server).

**Reference images are where providers really diverge.** Plain
generation is the same JSON POST everywhere, but working *from* an
existing image is a different request depending on the endpoint, so
each model declares which dialect it speaks:

| `wire:` | Reference images travel as | Sent to |
|---|---|---|
| `openrouter` (default) | base64 in an `input_references` array | `endpoint` |
| `openai` | multipart, one `image[]` part per file | `editEndpoint` |

`openai` is the setting for OpenAI itself and for an OpenAI-compatible
router such as LiteLLM in front of a local image backend. There is no
autodetection: a wrong guess would only surface after the user already
waited for a render, and whoever configures the model knows the answer.

**Responses come in three shapes, and all three end as a local file.**
An endpoint that does not want to serve files itself returns the image
inline as `data[].b64_json`; OpenAI direct returns an absolute URL on a
different host; an image server addressed directly tends to return a
*relative* path into its own output tree, because from its side the
client already knows the host. Relative paths are resolved against the
provider's `baseUrl`.

The provider's API key is sent when fetching such a URL **only if the
URL is on the same origin as `baseUrl`**. A pre-signed link on someone
else's host does not need it, and sending it there would hand the
credential to a third party.

**When a model is unavailable.** An image model can be configured and
still not be loaded right now — image backends commonly share a GPU box
that runs one profile at a time, and answer `503` when theirs isn't
active. `fallback:` on a model names another handle to try; that one may
name a fallback of its own.

Only *availability* walks the chain: unreachable, timing out, or a
server error. A rejected spec value or an empty prompt fails on the
first model instead, because the next one would reject it too and the
real message would be buried. When a fallback did happen, the tool
result and the HTTP response say so — a chain that has quietly settled
on its last resort is a cost and quality change worth noticing.

**Sampling knobs.** `steps`, `cfg` and `guidance` are passed through
when set and omitted when not, so a model's own defaults stand unless
someone deliberately overrides them. They are not part of OpenAI's image
API but are the common vocabulary of diffusion backends; which of them a
given model actually reads is answered by its capability list, not by
anything hardcoded. Useful in a loop: generate, judge the result with
`analyze_file`, adjust, regenerate.

**A substituted size is noticed here, not upstream.** Endpoints cap
dimensions, round to sizes they support, or only render squares — and
they answer `200` with a perfectly good image of the wrong shape. somora
reads the returned image's real pixel dimensions and compares them to
what was asked for; a mismatch becomes a note on the result naming both
numbers. This deliberately does not depend on the endpoint reporting it,
because a strict OpenAI-shaped proxy in front of a backend drops any
non-standard response field — measured against exactly such a router on
2026-08-27. Dimensions are kept on the image record.

Where a provider *does* report what it did differently, `ignored_params`
(names it accepted but did not use) and `warnings` (free text) are read
and relayed to the caller verbatim. Both are optional and absent almost
everywhere.

## How specs are validated

Allowed values differ per model — grok-imagine renders 1K and 2K,
others do 512 or 4K — so somora doesn't hardcode them. It reads the
provider's image-model catalog at runtime and validates against that.
Precedence:

1. `imageGen.models[].allow` — operator override, always wins
2. the provider catalog, cached per process
3. nothing known → **everything is allowed**

That third step is deliberate. A tool that refuses valid input because
a catalog was briefly unreachable would be worse than no validation at
all, so only a positively-known allow-list can reject something. The
same rule drives the UI: a spec the catalog pins down renders as a
dropdown of exactly its values, one it says nothing about renders as a
free-text field.

Rejections name the valid values:

```
resolution '4K' is not supported by Grok Imagine 2.0 — allowed: 1K, 2K
```

The caller is usually a language model, and one told only "invalid"
retries the same thing.

## Where images go

Every image lands in `imageGen.outputDir`, regardless of which agent
made it. That single directory is what the gallery and the file-serving
route index; resolving it per agent workspace would scatter images
across several and leave the gallery blind to most of them.

`save_to` (tool) or "Also save to" (UI) adds a **second name** for the
same bytes via `link(2)` — one file, two paths, no extra disk. Across
filesystems, or on one that rejects hardlinks, somora falls back to a
real copy. Deleting either name leaves the other intact.

Filenames are `2026-08-26_143012_koala-im-weltraum.png`: chronologically
sortable and recognizable without opening them.

Metadata lives separately, one JSON file per image under
`~/.somora/images/` — prompt, model, every spec, cost, timestamp, agent,
paths. The images directory itself is something you browse and clean
out, and provenance shouldn't vanish with a file you dragged elsewhere.

## Tools

| Tool | Purpose |
|---|---|
| `image_generate` | Generate and save. Returns path + metadata, not the bytes. |
| `image_list` | Find earlier images by prompt substring, model, agent, or date. |
| `image_models` | List configured handles, and what one model accepts. |

Specs travel as real request fields (`aspect_ratio: "16:9"`), never as
text inside the prompt. The prompt is passed through verbatim.

`image_generate` deliberately does **not** return the image by default:
a 2K PNG as base64 in a tool result is millions of characters of
context. `return_image: true` opts into it (~2k tokens) and requires a
vision-capable model; without one, the error points at `analyze_file`,
which dispatches to the configured `vision.worker`.

`image_list` exists because a path in a tool result doesn't survive
context compaction. "The koala one" has to stay findable.

`image_models` exists because the `model` argument is a free string:
with more than one model configured, nothing else tells the caller
which handles are available, and a wrong guess costs a round trip.
Listing handles is free; passing `model:` for one of them also reports
the values that model accepts per spec field, which is the other thing
that is otherwise learned only by being rejected.

**`reference_images` takes file paths**, not base64 — the tool reads
them itself, through the same read policy as `file_read`. Passing
several is how sources get combined into one picture. Whether a model
accepts more than one is its own business; `image_models` reports the
limit when the provider publishes it.

`save_to` runs through the same write gate as `file_write`
(`checkWriteAllowed`), so generating an image is not a way around it.

### Per-agent review stance

```yaml
# ~/.somora/agents/<name>/agent.yaml
imageReview: never    # never (default) | always
```

`always` feeds each generated image back into that agent's context so
it can judge the result and re-prompt on its own. Meant for agents
whose job is images.

`never` is **not a lock**. The agent can still pass `return_image` per
call when the task demands it, and afterwards the file is on disk like
any other — "have a look at it" works via `file_read`. Nothing is lost,
it's only deferred until someone decides it's worth the tokens.

`maxImagesPerTurn` caps how many images one turn may produce. It's a
cost brake, not a rate limit: an agent set to `always` can otherwise
re-prompt in a loop at real money per round. Under claude-cli and
codex-cli the tool runs in an MCP child process with no turn id; there
the per-call cap still applies but nothing accumulates.

## In the chat

Images generated during a turn appear on the assistant's bubble
automatically. The server publishes them after the turn finalizes —
the agent doesn't have to remember to send anything, because the
failure mode of relying on that is "Done!" with nothing to look at.

Mechanically it's an append-only `assistant_media` event paired to the
bubble by `turnId`, exactly like `assistant_audio`, persisted to JSONL
so a reloaded conversation still shows them. Each entry carries its own
`type` (`image` today) rather than the event naming one medium: the
kind string lives in session files forever, and a second, nearly
identical event kind for the next medium would have to be understood by
every reader from then on.

`/mobile` deliberately renders no media — it marks the bubble with a
one-liner naming what exists and points at the web app, so a turn that
produced a picture doesn't read as an empty-handed answer on a phone.

## HTTP

| Route | Purpose |
|---|---|
| `GET /images/status` | Enabled? Configured models, output dir. Drives the desktop tile. |
| `GET /images` | Gallery listing. `query`, `model`, `agent`, `since`, `until`, `limit`, `offset`. |
| `GET /images/:id` | One record. |
| `GET /images/:id/file` | The image bytes. |
| `GET /images/models/:name/capabilities` | Spec vocabulary for one model. |
| `GET /images/catalog` | What the provider offers (`?provider=`). |
| `POST /images/generate` | Generate. Body: `prompt` plus any specs. |
| `DELETE /images/:id` | Forget the record. **The file stays.** |

Files are served **by record id, never by path**. The client can't name
a file; the id is looked up in the metadata store and the path comes
from there. That's what lets the images directory be user-chosen
without the route becoming a way to read arbitrary files.

`DELETE` removes the gallery entry only. Deleting user files from a
one-click gallery button is the wrong default, and with hardlinks
somora couldn't reliably reach every name for the file anyway.

## Known gaps

- **Reference images** (image-to-image) work through the tool's
  `reference_images` argument, but the Media window has no picker for
  them yet — the browser path accepts base64 only.
- **No progress streaming.** The endpoint can stream partial renders;
  somora waits for the finished image and shows a busy state.
- **No automatic cleanup.** Generated images are work product, not a
  cache, so nothing is ever deleted on a timer. The gallery shows the
  total size so the archive's growth stays visible.
- **Any agent that sees the toolset can generate.** Restrict it per
  agent with the normal `tools:` gating in `agent.yaml`
  (`deny: [toolset:image]`).
