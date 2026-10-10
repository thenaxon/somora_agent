# Video generation

Your agents can make short videos from a text prompt, and from images,
videos and sound you give them. A render takes
minutes, so nobody waits for it: the agent starts the job, carries on,
and is woken when the video is ready. The feature is off until you
configure a `videoGen` block.

## What you get

- **No waiting.** `video_generate` returns a job id at once. The turn
  ends, and the agent can start more renders or do other work.
- **A wake when it is done.** The agent that asked is brought back in
  the session it asked from, with the path to the file.
- **The video in the chat.** It appears in the agent's reply bubble and
  in the Media window of the web client.
- **A still to look at.** Where the provider serves a thumbnail, the
  gallery shows a frame and the agent can judge its own result.
- **Renders survive a restart.** Jobs are kept on disk and picked up
  again.
- **One shared limit.** A cap across all agents keeps a single GPU from
  being overbooked.

## Set it up

Video models hang off a provider you already have under `providers`.
The provider must be `openai-compatible`. Add this to `config.yaml`:

```yaml
videoGen:
  enabled: true
  models:
    - name: h3
      provider: local-video # reuses that provider's baseUrl + apiKey
      model: h3
      wire: passthrough
      capabilitiesEndpoint: /video/models
```

Then ask an agent:

```
Make a five second video of a paper boat drifting down a stream.
```

The agent answers that the render has started. A few minutes later it
comes back with the video in the chat.

You can also start a render yourself. Open the Media window in the web
client, switch to **Video**, type a prompt and press **Start render**.
The form offers the model, the length in seconds and the aspect ratio,
and a file picker for each input the chosen model takes, such as the
video to change and the character image, marked "needed" where the
model requires it. Keyframes are left to agents, since each one needs a
time.

## Nothing appears until it is configured

Video exists only when `videoGen.enabled` is `true` and at least one
model is listed. Otherwise:

| Place | What happens |
|---|---|
| The agent's tool list | `video_generate`, `video_status` and `video_models` are not offered. |
| HTTP | `POST /video/generate` answers `503`. `GET /video/status` reports `enabled: false`. |
| Web client | The Media tile appears when images or video are configured. The window shows only the forms that exist, so a video-only install gets the video form. |

To take video away from one agent, add `tools: deny: [toolset:video]`
to its `agent.yaml`. That is worth doing for agents with no business
spending GPU minutes.

## From request to video

1. The agent calls `video_generate`. somora checks the parameters
   against what the model accepts, sends the request to the provider,
   stores the job and returns the job id. The turn ends.
2. A background loop asks the provider every `pollIntervalMs` how each
   job is doing.
3. When a job is `completed`, somora downloads the video, and the
   thumbnail where there is one, into `outputDir`. The media record
   gets the real width, height and duration, read from the file itself.
   ffmpeg is not needed.
4. The agent is woken, and the video shows up in the chat and in the
   Media window.

A job is `queued`, `in_progress`, `completed` or `failed`. While it
runs, the session's work badge and the Media window list it.

## The wake

When an agent started the render, that agent gets one wake per finished
video, in the session it asked from. The wake starts a normal turn with
this text:

```
[video] Your render is ready: <path>
Model <model>, prompt "<prompt>".
```

or, when it failed:

```
[video] The render you started (<model>, "<prompt>") failed: <reason>.
```

The turn also carries a short instruction. On success: the user already
sees the video, so say what it is and carry on. On failure: decide
between different settings and telling the user, and never send the
identical request again.

Good to know:

- The wake waits `agentLoop.wakeGraceMs` (default 3 seconds). An agent
  that looks at the finished job with `video_status` inside that time
  is not woken.
- Wakes are not batched. Waiting for the slowest of four renders would
  defeat the point of releasing the turn.
- If the session is busy, the wake queues behind what is running.
- A render started from the web client has no agent to wake. It lands
  in the Media window.

> **Note:** With the CLI engines (claude-cli, codex-cli, grok-cli) a
> look with `video_status` does not cancel the wake. The agent is woken
> in any case.

## The limit on parallel renders

`maxConcurrent` counts renders across all agents, not per agent. A GPU
is shared, and a per-agent budget would let four agents take twelve
slots. When the limit is reached, the next caller is refused with a
message that names the numbers. It is not queued, because the wait
would be an unknown number of minutes.

## Input files

An agent passes files by what they are for, in `media`. Each entry is a
`type` and a local `path`:

```json
{
  "prompt": "The woman from the photo walks through the scene instead.",
  "model": "animate",
  "media": [
    { "type": "input_video", "path": "~/clips/street.mp4" },
    { "type": "character_image", "path": "~/photos/person.png" }
  ]
}
```

| `type` | File | What it is |
|---|---|---|
| `first_frame` | image | The opening frame. |
| `last_frame` | image | The closing frame. The video is interpolated between the two. |
| `reference_image` | image | Something that should appear, or a look to follow. |
| `reference_video` | video | A clip to follow. |
| `input_video` | video | The video to change, for example to swap a person. |
| `character_image` | image | Who appears instead. |
| `keyframe_image`, `keyframe_video` | image, video | A frame or clip at a moment, with `seconds`. |
| `reference_audio` | audio | Sound to follow. |

Files are read under the same rules as `file_read`: a path `file_read`
may not open is refused here too. The bytes go to the provider; a local
path never does. One file may be up to 200 MB.

`reference_images` is the short form for frames: one image is the
opening frame, two are opening and closing frame, more are reference
images. A call uses one of the two fields, not both.

### Which field a file becomes

Providers name the same input differently, often per model. somora
decides the field name per model, in this order:

1. **The model's `media` block** in `config.yaml`. Without a catalog it
   is the model's complete list. Over a catalog it renames or adds a
   single type.
2. **The provider catalog's `accepted_media`**, when the catalog
   publishes it. Types it does not list are refused.
3. **The dialect's published format**, see the table below.

| `wire` | Takes without configuration |
|---|---|
| `openai` | `first_frame` as `input_reference`. OpenAI's video API takes one opening image and nothing else. |
| `veo` | `first_frame` as `image`, `last_frame` as `lastFrame`, up to three `reference_image` as `referenceImages`, inside Google's `instances`. |
| `passthrough` | `first_frame` and `last_frame` under those names, and up to four `reference_image` as `image[]`, exactly as before. |

A type the model does not take is refused before the request goes out,
with the way to add it.

### Naming a field yourself

A provider that names a field differently, or takes inputs no dialect
knows, gets a `media` block on the model:

```yaml
    - name: animate
      provider: local-video
      model: wan-animate-replace
      wire: passthrough
      transport: json               # files as data: URIs in a JSON body
      media:
        input_video: { field: video_url, min: 1, max: 1, maxSeconds: 30 }
        character_image: { field: image_url, min: 1, max: 1 }
```

With `transport: json` a dotted field nests (`input.video_url`), and
several files of one type become a list. With the default `multipart`
each file is a file part under its field name.

### Keyframes

A keyframe carries `seconds`: where in the video it belongs. Providers
that take keyframes want them as a list of objects, so a keyframe type
needs an `item` format and `transport: json`:

```yaml
      fps: 24
      media:
        keyframe_image:
          field: images
          item: { url: image_url, frame: start_frame_num, strength: strength }
```

With `seconds` in `item` the time goes as given. With `frame` it is
converted with the model's `fps`, or the catalog's. When neither is
known the call is refused rather than guessed.

### What is checked before sending

- the type is one the model takes, and not too many of it
- every type the model needs (`min`) is there
- the file is the right kind: an image for an image type, and so on
- a video is no longer than `maxSeconds`, where its length can be read
- `seconds` only on keyframes

## Thumbnails

A provider that offers `thumbnail` among its content variants
(`variant=thumbnail`) gets its still downloaded with the video and
stored beside it as `<video name>-thumb`.

- The gallery shows a frame instead of a black rectangle.
- The still is an ordinary image, so an agent can look at it: with
  `file_read` when its model has vision, with `analyze_file` when it
  does not.

`analyze_file` does not take video. Asking the provider for the still
it already has avoids a dependency on ffmpeg.

## The three dialects

Every provider does three things: start a render, say whether it is
done, hand over the result. Each spells them differently. `wire` picks
the spelling.

| `wire` | Create | Poll | Content |
|---|---|---|---|
| `openai` (default) | `POST /videos` | `GET /videos/{id}` | `GET /videos/{id}/content?variant=…` |
| `passthrough` | `POST /vid/create` | `GET /vid/status?id=` | `GET /vid/content?id=&variant=…` |
| `veo` | `…:predictLongRunning` | `…:fetchPredictOperation` | in the poll response |

Each dialect sends the request in its provider's published format.
`openai` sends `seconds` as a string, as OpenAI's API defines it. `veo`
sends the prompt and images inside `instances` and the settings as
camelCase `parameters` (`durationSeconds`, `aspectRatio`,
`generateAudio`).

`openai` keeps the job id in the path. `passthrough` keeps it in a
query parameter. That shape survives a proxy that forwards exact paths
but no wildcards, which is where a router in front of a local backend
ends up.

`veo` differs most: an operation name instead of a job id, a POST to
poll under `/models/<model>`, and the result inside the poll response
as a storage URI or inline bytes.

How far each one is tested:

| `wire` | Status |
|---|---|
| `passthrough` | Verified end to end with real renders against a self-hosted endpoint: create, poll, download, thumbnail, store, wake. |
| `openai` | Written to the published video API and run against a local stand-in. Never run against a live account. |
| `veo` | Written from the published shape. Never run. Treat it as prepared, not as working. |

## Restarts

Job state lives in `~/.somora/video-jobs/`, one JSON file per job. A
render that was running when somora stopped is polled again after the
start: the provider keeps the file, so it is collected then. A job that
finished in the meantime still wakes its agent, and never twice.

## Settings

```yaml
videoGen:
  enabled: true
  outputDir: ~/somoraworkspace/videos
  monthlyFolders: false
  maxConcurrent: 4          # across ALL agents, not per agent
  pollIntervalMs: 8000
  jobTimeoutMs: 2700000     # 45 minutes
  requestTimeoutMs: 120000
  models:
    - name: h3
      provider: local-video # reuses that provider's baseUrl + apiKey
      model: h3
      wire: passthrough
      capabilitiesEndpoint: /video/models

    - name: sora
      provider: openai
      model: sora-2
      wire: openai
      capabilitiesEndpoint: null   # no catalog, so declare it here
      allow:
        supported: [seconds, size, input_reference]
        variants: [video, thumbnail]
        maxReferences: 1

    - name: veo             # unverified, see "The three dialects"
      provider: vertex
      model: veo-3
      wire: veo
      capabilitiesEndpoint: null
```

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turns video on. Needs at least one model. |
| `outputDir` | `~/somoraworkspace/videos` | Where videos and thumbnails are stored. |
| `monthlyFolders` | `false` | Store into a `YYYY-MM` subfolder. |
| `maxConcurrent` | `4` | Renders in flight across all agents. 1 to 32. |
| `pollIntervalMs` | `8000` | How often running jobs are checked. Minimum 1000. Read once when the server starts. |
| `jobTimeoutMs` | `2700000` | A job older than this is given up and marked failed, so a stuck job does not hold a slot forever. |
| `requestTimeoutMs` | `120000` | Time limit for a single create, poll or download request. Not for the render. |
| `models` | none | The video models. The first one is the default. |

Each entry under `models`:

| Setting | Default | Meaning |
|---|---|---|
| `name` | required | Handle for the `model` argument and the picker. Letters, digits, `_` and `-`. |
| `provider` | required | Name of an entry under `providers`. Must be `openai-compatible`. Its `baseUrl` and `apiKey` are used. |
| `model` | required | Model id sent to the provider. |
| `label` | the name | Display name. |
| `wire` | `openai` | Dialect: `openai`, `passthrough` or `veo`. |
| `createEndpoint`, `statusEndpoint`, `contentEndpoint` | per dialect | Override a path of the dialect. Appended to `baseUrl`. |
| `capabilitiesEndpoint` | `null` | Path of the provider's model catalog, which says what each model accepts. |
| `defaults` | `{}` | Parameters applied when the caller leaves them out. |
| `media` | none | Field name per input type. See "Naming a field yourself". |
| `transport` | `multipart` | `multipart` or `json`: how input files travel. `veo` always uses its own JSON. |
| `fps` | from the catalog | Frames per second, for keyframes given as frame numbers. |
| `allow` | none | Declares what the model accepts when the provider has no catalog. Takes precedence over a catalog. |
| `fallback` | none | Handle of another video model. Accepted by the config. The video path does not act on it yet. |

Keys under `allow`:

| Key | Meaning |
|---|---|
| `supported` | The complete list of parameters the model takes. Anything else is rejected. |
| `variants` | Content variants the provider serves. Include `thumbnail` to get stills. Without it only `video` is fetched. |
| `aspect_ratio`, `size` | The allowed values for that parameter. |
| `maxReferences` | Most images `reference_images` may carry for this model, 0 to 4. |
| `maxSeconds` | Accepted by the config. Not checked yet. |

Keys of an entry under `media`:

| Key | Meaning |
|---|---|
| `field` | Required. The field name. With `transport: json` a dotted path nests it. |
| `max`, `min` | How many files of this type the model takes, and needs. |
| `maxSeconds` | Longest video or audio of this type. |
| `array` | JSON only: send a list even for one file. |
| `item` | Keyframes: `url` and either `seconds` or `frame`, optionally `strength`. Names of the keys in each list entry. |

The wake delay is `agentLoop.wakeGraceMs` (default `3000`). It is
shared with every other kind of background work.

## Tools

All three belong to the toolset `video`.

| Tool | Purpose |
|---|---|
| `video_generate` | Start a render. Returns `job_id`, `status`, `model`, the slot numbers and any `warnings` at once. |
| `video_status` | Look in on renders without waiting. Shows status, progress, queue position and, once finished, the path. `job_id` picks one job. `mine_only: false` shows the jobs of all agents. |
| `video_models` | Which models exist and what each one accepts. |

To find an older render, use `media_list` with `type: video`. It is the
same tool that finds an older image.

### Parameters of video_generate

| Parameter | Meaning |
|---|---|
| `prompt` | Required. What should happen in the video. Up to 4000 characters. |
| `model` | Handle of a configured model. Omit for the default. |
| `seconds` | Length in seconds. |
| `size` | Explicit pixels, for example `1344x768`. |
| `aspect_ratio` | For example `16:9`, `9:16`, `1:1`. |
| `audio` | Generate sound, where the model can. |
| `quality` | Slower and better. |
| `seed` | Repeat a previous result. |
| `media` | Input files by meaning: `{type, path, seconds?, strength?}`, up to 32. See "Input files". |
| `reference_images` | Up to four image paths, the short form for frames. Not together with `media`. |
| `extra` | Provider-specific fields, passed through untouched. |
| `save_to` | Accepted. It has no effect at present: the video is stored in `outputDir` only. |

Which parameters a model takes differs per model. One it does not take
is rejected before the request goes out. If the provider reports that
it ignored a parameter, the tool result says so under `warnings`.

### Reading video_models

Call it without arguments for the list of handles, and with
`model: "<handle>"` for the detail of one model. Video models differ
sharply: one takes length, aspect ratio and an audio toggle, the next
takes a seed and little else.

Read `accepts` as the rule and `recommended` as the hint. A parameter
listed as `any value` takes free text. When the catalog names
known-good values for it, such as a fixed set of canvas sizes, they
show under `recommended`. A size off that list is what a backend with a
fixed canvas rejects. `max_references` and `variants` are listed too.

`media` lists the input files the model takes: for each type the kind
of file, `max`, `min` and `max_seconds`. A type with `min` has to be
passed.

## Routes

| Route | Purpose |
|---|---|
| `GET /video/status` | `enabled`, `active`, `limit`, the configured `models` and the `jobs`. `?agent=<name>` narrows the jobs to one agent. |
| `POST /video/generate` | Start a render. Answers `{ job }`. |
| `GET /media?kind=video` | Finished videos. |
| `GET /media/:id/file` | The video file. `?download=1` forces a save dialog. |
| `GET /media/:id/thumb` | The still. `404` when the provider served none. |

`POST /video/generate` takes JSON with `prompt` and, optionally,
`model`, `seconds`, `size`, `aspect_ratio`, `audio`, `quality`, `seed`,
`reference_images`, `media`, `agent` and `session`. Here
`reference_images` are base64 strings, not paths. `media` entries are
`{type, data, filename?, seconds?, strength?}` with `data` in base64 or
as a `data:` URI. With `agent` set, that agent is woken when the render
finishes, in `session` or in `main`.

Errors: `400` for a bad request, `429` when all slots are busy, `502`
when the provider failed, `503` when video is not configured or the
model is not available right now.

## When something goes wrong

| What you see | Reason |
|---|---|
| `all N video slots are busy` | `maxConcurrent` is reached. Try again in a few minutes, or look at `video_status`. |
| `<model> does not accept '<field>'` | The model does not take that parameter. `video_models` lists what it takes. |
| `gave up after N minutes without a result` | The job passed `jobTimeoutMs`. Raise it for long renders on a slow backend. |
| `<model> takes no <type>` | The model, or its dialect, has no field for that input. Add it under the model's `media` if the provider does take it. |
| `<model> needs 1 × <type>` | The model requires that input, for example a video to change. |
| `frame rate is unknown` | Keyframes go as frame numbers and neither `fps` nor the catalog gives the rate. |
| A video without a still in the gallery | The provider serves no `thumbnail` variant, or it is not declared under `allow.variants`. |
| No wake after a finished render | The render was started from the web client, or the agent no longer exists. somora tries five times, then leaves it. The video is in the Media window either way. |

A provider error with a `5xx` during polling is tried again. Only a
`4xx` fails the job. Log lines of this feature start with `videogen.`,
for example `videogen.job_failed` and `videogen.job_timeout`.

## Known gaps

- **No cancel.** A started render runs to its end or to the timeout.
  OpenAI publishes `DELETE /videos/{id}` for removing a video, and does
  not say whether it stops a running render, so somora does not guess.
- **No cost metering** on pass-through routes. A proxy that only
  forwards requests does not count cost.
- **`veo` and live `openai` are unverified.** See "The three dialects".
- **No upload step.** Files go inline, as multipart parts or `data:`
  URIs. A provider that wants large files uploaded first is not
  supported yet.

## See also

- [Image generation](imagegen.md): the sister feature, same model
  catalog and Media window.
- [Web client](web.md): the Media window and the work badge.
- [Tools](tools.md): all tools and toolsets, and how to deny one per
  agent.
- [Models](models.md): how providers are configured.
- [HTTP API](api.md): every route in full.
