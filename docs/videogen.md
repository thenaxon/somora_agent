# Video generation

Text-to-video against a job-based endpoint. Same shape as
[imagegen](imagegen.md) where it can be, and deliberately different
where video is different — which is mostly about time.

A render takes minutes. Five seconds of video is a couple of minutes of
GPU; fourteen seconds can be eight. Backends generally do one at a time.
So `video_generate` **does not wait**: it starts the job, the turn ends,
and the agent is woken when its video is ready. That is the same
arrangement the tmux watcher uses for a long-running terminal, and it is
why an agent can ask for four videos and carry on working.

Off by default: no tool is exposed and no video controls appear until a
`videoGen` block is configured.

## Configuration

```yaml
videoGen:
  enabled: true
  outputDir: ~/somoraworkspace/videos
  maxConcurrent: 4          # across ALL agents, not per agent
  models:
    - name: h3
      provider: local-video # reuses that provider's baseUrl + apiKey
      model: h3
      wire: passthrough
      capabilitiesEndpoint: /video/models
```

`maxConcurrent` is global on purpose. A GPU is shared, and a per-agent
budget would let four agents occupy twelve slots. When the cap is
reached the next caller is refused with a message naming the numbers,
rather than queued behind an unknown number of minutes.

## The three dialects

Every provider does the same three things — start a render, ask whether
it is done, fetch the result — and spells them differently. `wire`
picks the spelling; nothing else in somora knows about it.

| `wire:` | create | poll | content |
|---|---|---|---|
| `openai` | `POST /videos` | `GET /videos/{id}` | `GET /videos/{id}/content?variant=…` |
| `passthrough` | `POST /vid/create` | `GET /vid/status?id=` | `GET /vid/content?id=&variant=…` |
| `veo` | `…:predictLongRunning` | `…:fetchPredictOperation` | *in the poll response* |

`openai` keeps the job id in the path. `passthrough` keeps it in a query
parameter — the shape that survives a proxy which forwards exact paths
but not wildcards, which is how a router in front of a local backend
ends up there.

**`veo` is a prepared seam, not a finished road.** It is written from
Google's published shape — an operation name instead of a job id, a POST
to poll, and the result arriving *in* the poll response as a storage URI
or inline bytes rather than from a content endpoint — but it has never
been run against a live Vertex endpoint. The structure is there so that
adding Veo is a config entry rather than a refactor. Do not describe it
as working until someone has watched it work.

## Thumbnails

A provider that publishes `thumbnail` among its content variants gets
its still downloaded alongside the video. That is not a nicety:

- the gallery can show a frame instead of a black rectangle, without
  anyone shipping a video decoder or requiring ffmpeg;
- the still is an ordinary image, so `analyze_file` reads it — which is
  how an agent judges a video it just made.

`analyze_file` does **not** take video. Extracting a frame ourselves
would mean depending on ffmpeg being installed everywhere; asking the
provider for the still it already has is the agnostic answer, and
OpenAI's API offers exactly that (`variant=thumbnail`).

## Tools

| Tool | Purpose |
|---|---|
| `video_generate` | Start a render. Returns a job id immediately. |
| `video_status` | Look in on renders without waiting for one. |
| `video_models` | Which models exist, and what each one accepts. |

`video_models` matters more here than its image counterpart does.
Video models differ sharply — one takes length, aspect ratio and an
audio toggle, the next takes a seed and little else — and a parameter a
model ignores costs minutes of GPU before anyone notices it did
nothing.

`reference_images` takes file paths and **the order carries meaning**:
none is text-to-video, one makes that image the opening frame, two mean
opening and closing frame with the video interpolated between them. With
two, somora sends them as `first_frame` and `last_frame` rather than as
an array — leaving it to array order would make the result depend on how
a caller happened to sort a directory listing.

Which parameters a model actually takes differs per model, and the
provider's catalog answers it; one it does not take is rejected before
the request goes out.

## What happens when a render finishes

1. The loop notices `completed` and downloads the file — and the
   thumbnail, where there is one.
2. Both are stored in the media directory and a record is written, with
   the real dimensions and duration read from the file's own header
   atoms (no ffmpeg).
3. The agent that asked is woken, one wake per finished video. Waiting
   to batch four renders would defeat the point of releasing the turn.
4. The video appears in that wake turn's bubble, and in the Media
   window.

The video is attached to the wake turn explicitly, because it was stored
minutes before that turn began — the time window a turn normally uses to
find its own media does not reach back that far.

## Restarts

Job state lives in `~/.somora/video-jobs/`, one JSON per job. somora
gets redeployed several times on a busy day, and a render that finished
during a restart must not be lost: the provider keeps the file, so the
loop simply resumes polling and collects it. Jobs that finished while
nobody was listening still get their wake-up afterwards.

## Known gaps

- **No cancel.** OpenAI publishes `DELETE /videos/{id}` for removing a
  video from storage, but does not document whether it stops a running
  render — and a delete that doesn't free the worker is not worth much
  when the worker is serial. Deliberately not guessed at.
- **No spend metering** on pass-through routes: a proxy that forwards
  rather than proxies does not count cost.
- **`veo` unverified**, see above.
