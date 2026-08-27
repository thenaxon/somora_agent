# Image generation

Text-to-image against an OpenAI-shaped image endpoint. Both a human and
an agent drive the **same code path** — the web app's Images window
POSTs to `/images/generate`, agents call the `image_generate` tool —
so the two can't end up able to do different things.

Off by default. Nothing appears in the UI and no tool is exposed until
`imageGen` is configured.

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
Images window surfaces it too. Config stays the source of truth for
what somora will actually call.

**Endpoint paths differ by provider.** The default `/images` is
OpenRouter's; OpenAI direct wants `/images/generations`. Set
`endpoint:` per model when it differs, and `capabilitiesEndpoint: null`
when the provider has no model catalog at all (a local image server).

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

Specs travel as real request fields (`aspect_ratio: "16:9"`), never as
text inside the prompt. The prompt is passed through verbatim.

`image_generate` deliberately does **not** return the image by default:
a 2K PNG as base64 in a tool result is millions of characters of
context. `return_image: true` opts into it (~2k tokens) and requires a
vision-capable model; without one, the error points at `analyze_file`,
which dispatches to the configured `vision.worker`.

`image_list` exists because a path in a tool result doesn't survive
context compaction. "The koala one" has to stay findable.

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

Mechanically it's an append-only `assistant_images` event paired to the
bubble by `turnId`, exactly like `assistant_audio`, persisted to JSONL
so a reloaded conversation still shows them.

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
  `reference_images` argument, but the Images window has no picker for
  them yet.
- **No progress streaming.** The endpoint can stream partial renders;
  somora waits for the finished image and shows a busy state.
- **No automatic cleanup.** Generated images are work product, not a
  cache, so nothing is ever deleted on a timer. The gallery shows the
  total size so the archive's growth stays visible.
- **Any agent that sees the toolset can generate.** Restrict it per
  agent with the normal `tools:` gating in `agent.yaml`
  (`deny: [toolset:image]`).
