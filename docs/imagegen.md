# Image generation

somora can turn a text prompt into a picture. You do it in the Media
window of the web client, and your agents do it with the
`image_generate` tool. Both use the same code, so an agent can do
exactly what you can do by hand. It is off until you configure it.

## What you get

- **One feature, two entrances.** The Media window and the agent tool
  share models, settings and gallery.
- **No second API key.** An image model borrows the address and key of
  a provider you already have.
- **Mistakes caught before you pay.** A value the model does not accept
  is rejected with the list of values it does accept.
- **Pictures in the chat.** What an agent generates during a turn shows
  up on its answer automatically.
- **A gallery that remembers.** Every image keeps its prompt, model,
  settings and cost, and agents can find old ones again.
- **Honest results.** If the provider returns a different size or shape
  than requested, the result says so.

## Set it up

Add an `imageGen` block to `config.yaml` and restart somora. The model
points at a provider that is already defined under `providers`:

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
      provider: openrouter                  # baseUrl + apiKey from here
      model: x-ai/grok-imagine-image-2.0
      label: "Grok Imagine 2.0"
      defaults:
        resolution: 1K
        aspect_ratio: "16:9"
        output_format: png
```

Then open the **media** tile on the desktop, type a prompt and press
**Generate**. Or ask an agent: "Draw a koala in space, 16:9."

> **Warning:** Do not list image models under `providers.<x>.models`.
> A model listed there becomes a chat model, appears in the model
> pickers and in `/v1/models`, and fails on the first turn.

Good to know:

- The provider must use `engine: openai-compatible`.
- The first model in the list is the default.
- The API key is the one of the provider the model points at. To bill
  images separately, define a second provider with the same `baseUrl`
  and another key, and point `provider:` at it.
- `GET /images/catalog` lists the image models your provider offers, so
  you can copy the exact model id.

## Nothing appears until it is configured

Without an `imageGen` block that has `enabled: true` and at least one
model, image generation does not exist anywhere:

| Place | What happens |
|---|---|
| Agent tools | `image_generate` and `image_models` are not offered. They cost no context and cannot be called. |
| HTTP | `GET /images/status` answers `enabled: false`. Generate, gallery listing, catalog and capabilities answer `503`. |
| Desktop | The media tile is hidden, unless video generation is configured. |

To take it away from one agent, add `tools: deny: [toolset:image]` to
its `agent.yaml`. That removes `image_generate` and `image_models` on
every engine. `media_list` belongs to the separate `media` toolset,
because an install with only video needs it too.

## The Media window

The form is on the left, the gallery on the right, newest first.

- **The form follows the model.** A setting with a fixed set of values
  is a dropdown. A setting without one is a text field. A setting the
  model does not take is hidden.
- **Click a tile** to see the picture with its prompt, settings, size,
  cost and path. Click the picture to open it large in the file viewer.
- **Buttons under the picture:** copy the path, reuse the settings,
  download, remove from the gallery.
- **The gallery header** has a prompt search and shows the number of
  items and their total size.

The same window holds videos. A video plays in place and has its own
button to open it in the file viewer.

## How settings are checked

Allowed values differ per model, so somora does not hardcode them. It
looks in three places, in this order:

1. `imageGen.models[].allow` in your config. It always wins.
2. The provider's model catalog, read from `capabilitiesEndpoint`.
3. Nothing known: everything is passed through.

The third step is deliberate. Only a list somora positively knows can
reject something, so a catalog that is briefly unreachable never blocks
a valid request.

When the model publishes its full list of settings, a setting outside
that list is rejected too. Rejections name what is valid, because the
caller is usually a language model that needs the answer to correct
itself:

```
resolution '4K' is not supported by Grok Imagine 2.0 — allowed: 1K, 2K
```

Values under `defaults` fill in what the caller left out. A default the
model does not take is skipped without an error.

> **Note:** The catalog is read once and kept until somora restarts.
> Restart after your provider adds a model or changes its settings.

## Reference images

A model can work from existing pictures. How they are sent depends on
the endpoint, so each model declares its dialect with `wire:`.

| `wire:` | Reference images travel as | Sent to |
|---|---|---|
| `openrouter` (default) | `input_references`: one `{ "type": "image_url", "image_url": { "url": "data:<mime>;base64,…" } }` object per file | `endpoint` |
| `openai` | multipart, one `image[]` part per file | `editEndpoint` |

Use `openai` for OpenAI itself and for an OpenAI-compatible router such
as LiteLLM in front of a local image backend. There is no
autodetection: a wrong guess would only show after you waited for a
render.

Without reference images both dialects send the same JSON request to
`endpoint`.

References must be PNG, JPEG, WebP or GIF. The type is read from the
file content, not from the file name. The model's own limit on how many
it takes is enforced before the request goes out, when it is known.

> **Note:** The `openai` wire follows OpenAI's published API and is
> meant for routers in front of local models as well. It has not been
> run against `api.openai.com` itself.

## Aspect ratio on the openai wire

The `openai` wire has no ratio field, and routers drop `aspect_ratio`
on the edit endpoint. somora therefore sends the ratio as `size`:

| Situation | What is sent as `size` |
|---|---|
| The catalog says `size` also accepts named ratios (`supported_parameters.size.also_accepts`) | The ratio itself, for example `16:9` |
| The catalog lists concrete sizes | The listed size closest to the ratio |
| Neither | OpenAI's own sizes: 1792×1024 or 1024×1792 for 16:9 and 9:16. That is 7:4, not 16:9, and the result carries a warning. |

Two rules sit on top:

- An explicit `size` always wins over `aspect_ratio`.
- A model whose catalog declares `aspect_ratio` and offers no named
  ratios in `size` still receives `aspect_ratio` on plain generation.
  Requests with reference images are always translated.

The `openrouter` wire keeps `aspect_ratio`, which is native there.

## When the result differs from the request

An endpoint may cap dimensions, round to a size it supports or only
render squares, and still answer with a perfectly good image. somora
measures the returned picture itself:

- **Size.** Explicit pixels were requested and others came back: the
  result names both.
- **Shape.** A ratio was requested and the picture is more than 1 %
  off: the result names the ratio and the real dimensions.

If the provider reports `ignored_params` or `warnings`, they are passed
on word for word. All of this appears as `notes` in the tool result and
as `warnings` in the HTTP response. The real pixel dimensions are
stored with the image, next to the `specs` as they were sent.

## Sampling settings

`steps`, `cfg` and `guidance` are sent when set and left out otherwise,
so the model's own defaults stand. They are not part of OpenAI's image
API but common among diffusion backends. `image_models` tells which of
them a model reads.

They are useful in a loop: generate, look at the result with
`file_read` or `analyze_file`, adjust, generate again.

## When a model is unavailable

An image model can be configured and still not be loaded. Image
backends often share a GPU machine that runs one profile at a time and
answer `503` when theirs is not active. `fallback:` on a model names
another handle to try. That one may name a fallback of its own.

| Problem | What happens |
|---|---|
| Endpoint unreachable, timeout, an error status from the provider, or a response without a usable image | The next model in the chain is tried. |
| Empty prompt, unknown model, a value somora rejects, a config mistake | Fails on the first model. The next one would not help. |

When a fallback was used, the tool result and the HTTP response say so
and name the models that were skipped.

## Where images go

Every image lands in `imageGen.outputDir`, whichever agent made it.
There is no second destination. An agent that needs the file uses the
path from the tool result.

| What | Where |
|---|---|
| Image files | `imageGen.outputDir`, default `~/somoraworkspace/images` |
| With `monthlyFolders: true` | `<outputDir>/YYYY-MM/` |
| File name | `2026-08-26_143012_koala-im-weltraum.png`: date, time, then the start of the prompt |
| Metadata | `~/.somora/media/<id>.json`, one file per item, shared with videos |

The metadata holds prompt, model, settings, cost, time, agent and path.
It is kept apart from the pictures so that the image folder stays clean
and the history survives when you move a file.

Whatever shape the provider answers in, the picture ends up as a local
file: inline `data[].b64_json`, an absolute URL, or a path relative to the
provider's `baseUrl`. When somora fetches a URL, it sends the API key
only if the URL is on the same origin as `baseUrl`. A link on another
host never receives your key.

Nothing is deleted automatically. Generated images are your work, not
a cache.

## In the chat

Images generated during a turn appear on the agent's answer in the web
client. The server adds them after the turn ends, so the agent does not
have to send anything.

Technically this is an `assistant_media` event, tied to the answer by
`turnId` and stored in the session file, so a reloaded conversation
still shows the pictures. Each entry carries its `type`, `image` or
`video`.

The mobile app at `/mobile` shows no media. It adds one line naming what was made
and points to the web client.

## Review by the agent

`image_generate` returns the path and metadata, not the picture: an
image in a tool result costs context. An agent can still look at its
work.

| Way | Effect |
|---|---|
| `return_image: true` on a call | The image comes back with the result (about 2k tokens). Needs a model that can see images. Otherwise the call fails before generating and points to `analyze_file`, which uses the configured `vision.worker`. |
| `imageReview: always` in `agent.yaml` | Every generated image comes back. Meant for agents whose job is images. On a text-only model the image is generated and a note explains why it is not attached. |
| Later | The file is on disk. `file_read` or `analyze_file` shows it at any time. |

```yaml
# ~/.somora/agents/<name>/agent.yaml
imageReview: never    # never (default) | always
```

`never` is not a lock: `return_image` on a single call still works. An
explicit `return_image: false` also overrides `always`.

`maxImagesPerTurn` limits how many images one turn may produce. It is a
cost brake: an agent that reviews its own work could otherwise generate
in a loop. With the claude-cli engine the limit applies per call only
and does not add up over the turn. With codex-cli and openai-compatible
it adds up.

## Settings

```yaml
imageGen:
  enabled: false
  outputDir: ~/somoraworkspace/images
  monthlyFolders: false
  maxImagesPerTurn: 5
  timeoutMs: 300000
  models:
    - name: local-flux
      provider: local-images
      model: flux-dev
      label: "Flux (local)"
      wire: openai                    # default: openrouter
      endpoint: /images/generations   # default: /images
      editEndpoint: /images/edits
      capabilitiesEndpoint: null      # default: /images/models
      fallback: grok-imagine
      defaults: {}
      allow:
        supported: [size, aspect_ratio, seed, steps, guidance, n]
        aspect_ratio: ["1:1", "16:9", "9:16"]
        maxReferences: 4
```

| Setting | Default | Meaning |
|---|---|---|
| `imageGen.enabled` | `false` | Master switch. |
| `imageGen.outputDir` | `~/somoraworkspace/images` | The one folder for every image. |
| `imageGen.monthlyFolders` | `false` | Sort files into `<outputDir>/YYYY-MM/`. |
| `imageGen.maxImagesPerTurn` | `5` | Images one turn may produce, 1 to 100. Also the upper limit for `n` in one call. |
| `imageGen.timeoutMs` | `300000` | Time limit for one request to the provider, 5 seconds to 30 minutes. |
| `imageGen.models` | none | At least one model. The first is the default. |

Per model:

| Setting | Default | Meaning |
|---|---|---|
| `name` | required | Handle for the tool and the window. Letters, digits, `_` and `-`. |
| `provider` | required | Name of an entry under `providers`. |
| `model` | required | Model id sent to the provider. |
| `label` | `name` | Name shown in the window and in messages. |
| `endpoint` | `/images` | Path after `baseUrl`. `/images` is OpenRouter's. OpenAI itself uses `/images/generations`. |
| `wire` | `openrouter` | Dialect for reference images: `openrouter` or `openai`. |
| `editEndpoint` | `/images/edits` | Path for requests with reference images. `wire: openai` only. |
| `capabilitiesEndpoint` | `/images/models` | Path of the provider's model catalog. `null` when there is none, for example a local image server. |
| `fallback` | none | Handle of the model to try when this one is unavailable. |
| `defaults` | `{}` | Values used when the caller sets none: `resolution`, `aspect_ratio`, `size`, `quality`, `output_format`, `background`, `steps`, `cfg`, `guidance`. |
| `allow` | none | Your own list of what the model accepts. Replaces the catalog. |

Inside `allow`:

| Key | Meaning |
|---|---|
| `resolution`, `aspect_ratio`, `size`, `quality`, `output_format`, `background` | Allowed values for that setting. |
| `supported` | The complete list of settings the model takes. Anything else is rejected. Without it, a setting the endpoint does not read is forwarded and silently ignored there. |
| `maxN` | Most images per call, 1 to 10. |
| `maxReferences` | Most reference images, 0 to 16. `0` means none at all. |

A misspelled key inside `allow` or `defaults` is a config error.

Per agent, in `agent.yaml`: `imageReview` (`never` or `always`) and
`tools: deny: [toolset:image]`.

## Tools

| Tool | Toolset | Purpose |
|---|---|---|
| `image_generate` | `image` | Generate and save. Returns path and metadata. |
| `image_models` | `image` | List the configured handles. With `model:`, show what that model accepts. |
| `media_list` | `media` | Find earlier images and videos, newest first. |

Parameters of `image_generate`:

| Parameter | Meaning |
|---|---|
| `prompt` | Required. Passed to the model unchanged, up to 4000 characters. |
| `model` | Handle of a configured model. Omit for the default. |
| `aspect_ratio` | For example `1:1`, `16:9`, `9:16`, `4:3`. |
| `resolution` | A tier, for example `512`, `1K`, `2K`, `4K`. |
| `size` | Explicit pixels, for example `1024x1024`. |
| `quality` | For example `auto`, `low`, `medium`, `high`. |
| `output_format` | `png`, `jpeg`, `webp`, `svg`. |
| `background` | `auto`, `transparent`, `opaque`. |
| `output_compression` | 0 to 100, for webp and jpeg. |
| `seed` | Repeats an earlier result. |
| `n` | Number of images, 1 to 10. |
| `steps`, `cfg`, `guidance` | Sampling settings. |
| `reference_images` | Up to 16 file paths of pictures to work from. Pass several to combine them. |
| `return_image` | Also return the picture to the agent. Default `false`. |
| `extra` | Provider-specific fields, passed through untouched. |
| `save_to` | Accepted and ignored. The result says where the image is. |

Settings travel as real request fields, never as text inside the
prompt.

`reference_images` takes file paths, not base64. The tool reads the
files itself under the same read rules as `file_read`. Relative paths
start at the agent's workspace.

`image_models` exists because `model` is a free string. For one model
it lists the values per setting under `accepts`. A setting that takes
free text shows as `any value`. Values the catalog suggests
(`supported_parameters.<field>.recommended`) appear under
`recommended`: not a restriction, but a value outside that list is the
usual reason for a provider error.

`media_list` exists because a path in a tool result does not survive
context compaction. Its filters: `type` (`image` or `video`), `query`
(part of the prompt), `model`, `agent`, `mine_only`, `since` and
`until` (`YYYY-MM-DD`), `limit` (default 20, at most 200) and `offset`.

Image generation writes only into `imageGen.outputDir`. It is not a way
around the `file_write` rules.

## Routes

| Route | Purpose |
|---|---|
| `GET /images/status` | Enabled or not, the configured models, `outputDir`, `maxImagesPerTurn`. Decides whether the tile shows. |
| `GET /images` | Gallery listing. `query`, `model`, `agent`, `since`, `until`, `limit` (default 60, at most 200), `offset`. |
| `GET /images/:id` | One record. |
| `GET /images/:id/file` | The image itself. `?download=1` makes the browser save it. |
| `GET /images/models/:name/capabilities` | What one model accepts. |
| `GET /images/catalog` | What the provider offers. `?provider=` picks the provider. |
| `POST /images/generate` | Generate. Body: `prompt`, optional `model`, any setting, `reference_images` as base64. |
| `DELETE /images/:id` | Forget the record. The file stays. |

`POST /images/generate` answers `400` for something the caller can fix,
`502` when the provider failed and `503` when the model is not
available right now.

Files are served by record id, never by path. A client cannot name a
file, so a folder of your choice does not turn the route into a way to
read other files. `410` means the record exists but the file was moved
or deleted.

`DELETE` removes the gallery entry only. A gallery button should not
delete your files with one click.

## Troubleshooting

**The media tile is missing.** `imageGen.enabled` is not `true`, the
model list is empty, or somora was not restarted after the change.

**"needs an openai-compatible provider".** The model's `provider:`
points at a provider with another engine. Define an
`openai-compatible` provider for images.

**A setting is rejected.** The message names the allowed values. Ask
`image_models` with `model:` for the full picture, or correct the
`allow` block if it is yours.

**A setting has no effect and no error.** The model has no catalog and
no `allow.supported` list, so somora cannot know the setting is not
read. Add `allow.supported`.

**The picture has the wrong shape.** Read the note on the result. The
log lines `imagegen.request` (what was sent, never the image bytes),
`imagegen.aspect_ratio_translated` and
`imagegen.aspect_ratio_substituted` show what happened.

**"not available right now".** The provider answered `503` or `504`.
Try later, or set `fallback:` on the model.

**The request times out.** Large renders take minutes. Raise
`imageGen.timeoutMs`.

**The image URL could not be fetched, with 401 or 403.** The provider
returned a link on another host than its `baseUrl`, and the key is not
sent there. Set `baseUrl` to the host that serves the images, or have
the endpoint return `b64_json`.

**An agent hits the image limit.** `maxImagesPerTurn` is reached. The
agent is told to ask you before generating more.

## Known gaps

- **No picker for reference images in the Media window.** Agents pass
  them through `reference_images`. The route takes them as base64.
- **No progress display.** somora waits for the finished image and
  shows a busy state.
- **No automatic cleanup.** Nothing is deleted on a timer. The gallery
  shows the total size so growth stays visible.
- **Every agent with the toolset can generate.** Restrict it per agent
  with `deny: [toolset:image]`.

## See also

- [Video generation](videogen.md): the same idea for video, with jobs
- [Tools](tools.md): every tool and how to allow or deny them per agent
- [Files](files.md): `file_read`, `analyze_file` and the read rules
- [Web client](web.md): the desktop and its windows
- [API](api.md): the image and media routes in full
