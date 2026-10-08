# Image handling

somora keeps every image in full resolution and shows models a scaled
copy. Looking at a picture uses the copy. Working on a picture, such as
editing it with an image model, uses the original.

## What you get

- **Small requests.** Every model is shown images at most
  `attachments.maxImageEdge` pixels on the longest side, 2048 by default.
- **Full quality where it counts.** Tools that change an image get the
  original file, not the copy a model looked at.
- **Pictures an agent can hand on.** A model is told where the original
  of every image in the chat is, so it can pass it to a tool.
- **One behaviour everywhere.** The same rule holds on every engine and
  in every client.

## How images arrive

| Way in | What is stored |
|---|---|
| Dragged or picked in the web client | The original, in `~/.somora/attachments/` |
| Picked or photographed in the mobile app | The original, in `~/.somora/attachments/` |
| The screenshot button in the web client | The full-resolution capture, stored like an upload |
| A file in the workspace | The file itself |
| A browser screenshot (`browser` with `op: "screenshot"`) | A PNG in the workspace; the result names its path |
| An image an agent generated | A file in the images folder; the result names its path |

Uploads are not scaled before they leave the browser. They are stored
under a name made from their content, such as `d8f1….jpg`, so the same
picture sent twice is kept once.

## Looking at an image

Whatever path an image takes to a model, the model gets the scaled copy:

| Path | What the model gets |
|---|---|
| An image in the chat, for a model that can see | The scaled copy, in the message |
| `file_read` on an image | The scaled copy |
| `analyze_file` | The scaled copy, described by a vision worker |
| `decision_evaluate` with `images` | The scaled copy, sent to the decision model |
| An image in the chat, for a model that cannot see | A vision worker's description of the scaled copy |

The scaled copy is made once and kept next to the original as
`<original>.model-<edge>-<key>.<ext>`. An image that already fits is
sent as it is.

## Working on an image

Tools that change or reuse a picture get the original file:

| Tool | What it gets |
|---|---|
| `image_generate` with `reference_images` | The original |
| `video_generate` with `reference_images` | The original |

An agent names the file by its path. For a file in the workspace or a
generated image that path is known. For an image sent in the chat, the
model is told it.

## The original path in the message

For every image in the chat, the model gets one line with the original:

```text
[Image attachment "car.png" (6000×4000) — original, full resolution: /home/you/.somora/attachments/d8f1….png — what you are shown may be a scaled-down copy. Pass this path to tools that need the image file (for example image_generate reference_images); never pass a ".model-" copy.]
```

The line names the original's size as it is shown, so an upright phone
photo reads as portrait, and its path. The size is left out when it
cannot be read.

The line is part of the message on every engine, and later turns still
see it, so the picture can be handed on. An attachment whose file is
gone loses the line. An agent passes this path to tools. It
never passes the path of a `.model-` copy: that is the small version.

## Models without vision

A model without the `image` capability is not sent images. A vision
worker describes each one, and its description goes into the message
with the original path line. The description stays in the history.
Without a vision worker, sending an image to such a model is refused.

## Limits

| Setting | Default | Meaning |
|---|---|---|
| `attachments.maxImageEdge` | `2048` | Longest side, in pixels, of the copy a model is shown. `0` sends images as they are. |
| `attachments.maxImageBytes` | 5 MB | Largest image a model is sent, after scaling. |
| `attachments.maxPerTurn` | `10` | Attachments per message. |

An upload may be larger than `maxImageBytes`: with scaling on, a source
image of up to 50 MB is accepted and scaled before it reaches a model.
Decision models have their own limits for images, listed on their page.

## See also

- [File tools](files.md): `file_read` and `analyze_file`, on this machine and on SSH resources
- [Decision models](decisions.md): asking typed questions about images and text
- [Image generation](imagegen.md): creating and editing images
- [Web client](web.md): uploads and the screenshot button
- [Mobile app](mobile.md): attachments from the phone
