# File tools

The file tools let an agent read, write, change, search and list files.
They work on the machine somora runs on and, with one extra parameter,
on any machine you have set up as an SSH resource. Images and PDFs can
be read too, and you can attach files to a chat message.

## What you get

- **One set of tools everywhere.** `file_read`, `file_write`,
  `file_patch`, `file_search` and `file_list` behave the same locally
  and over SSH.
- **Safe paging.** Long files come back in numbered pages, long search
  results are cut cleanly, and the agent is told how to continue.
- **Edits that land.** `file_patch` finds the text to replace even when
  the model got the indentation or line endings slightly wrong.
- **Guard rails.** Keys, credentials and system folders are closed.
  Persona files are backed up before every change.
- **Images and PDFs.** A model that can see gets the picture itself. A
  model that cannot gets a description from a vision worker.

## Try it

Ask your agent:

```
Write a file hello.md in your workspace with one line of text,
then read it back and change the word "hello" to "goodbye".
```

The agent makes three tool calls:

```jsonc
{ "name": "file_write", "input": { "path": "hello.md", "content": "hello world\n" } }
{ "name": "file_read",  "input": { "path": "hello.md" } }
{ "name": "file_patch", "input": { "path": "hello.md", "old_string": "hello", "new_string": "goodbye" } }
```

The file lands in the agent's workspace, by default
`~/somoraworkspace/hello.md`.

## Local and remote targets

Every file tool except `analyze_file` takes a `target`:

```
target: "local" | "<resource-name>"
```

| Value | Where it works |
|---|---|
| `local` (default) | The filesystem of the somora server. |
| a name from `resource_list` | That SSH resource. Reading, writing and patching go over SFTP. Searching runs `rg` on the remote machine. |

The model only picks the target. Connection, login and host key checks
are handled by the server.

```jsonc
{ "name": "file_read",   "input": { "path": "/tmp/log.txt", "target": "<resource-name>" } }
{ "name": "file_search", "input": { "pattern": "TODO", "path": "src/", "target": "<resource-name>" } }
```

Images and PDFs work the same on a resource: the file is downloaded
and shown like a local one. Two things are local only: the persona
backup and the builder write scope.

## How paths resolve

| Path | Local | On an SSH resource |
|---|---|---|
| Relative | Joined onto the agent's workspace. | Joined onto the resource's `workspace`, or onto the SSH user's home when none is set. |
| Absolute | Used as it is. | Used as it is. |
| `~` or `~/...` | `$HOME` of the user somora runs as. | The SSH user's home, even when the resource has a `workspace`. |

The workspace is `workspace.path` in the agent's `agent.yaml`. Without
it, `workspace.default` from `config.yaml` applies. Both folders are
created when the server starts.

A session pinned to a project that has a working folder uses that
folder as the root for relative paths.

The workspace is a starting point, not a fence. An agent can reach any
path that the rules below leave open.

> **Tip:** Do not start a relative path with the workspace folder's own
> name. `somoraworkspace/notes.md` creates a nested copy of the folder.
> The result then carries a `warning` that says so.

## Paths that are closed

| Rule | Paths |
|---|---|
| Never read or written | `~/.ssh`, `~/.gnupg`, `~/.aws/credentials`, `~/.kube/config`, `/etc/shadow`, `/etc/sudoers`, `/etc/ssh`, `/boot`, `/sys`, `/proc` |
| Readable, never written | `/etc`, `/usr`, `/dev` |
| Never written | `~/.somora/known_hosts.json`, every agent's `sessions/` folder under `~/.somora/agents/` |

The read rules apply to `file_read`, `file_list`, `file_search` and
`analyze_file`. A search that starts in an open folder leaves out hits
from a closed one. The write rules apply to `file_write` and
`file_patch`.

Symbolic links are resolved before the check. For a file that does not
exist yet, the closest existing parent folder is resolved.

On an SSH resource only the first row applies, relative to the remote
user's home. Editing `/etc` on a machine you manage is ordinary work
for an agent with that resource.

Everything else is open on purpose:

- `~/.somora/config.yaml`, the server configuration.
- `AGENTS.md`, `SOUL.md`, `USER.md`, `VOICE.md` and `agent.yaml` under
  `~/.somora/agents/<name>/`, for the agent itself and for other agents.
- Memory notes under `~/.somora/agents/<name>/memory/`.

> **Warning:** These rules stop accidents and keep secrets out of the
> model by mistake. They are not a sandbox. An agent with the `exec`
> tool can still reach those paths through the shell.

## Persona files never without a backup

Agents may edit their own persona files and those of other agents. To
make sure a persona is never lost, `file_write` and `file_patch` first
copy the current file to `<file>.bak-<timestamp>`. The result names the
copy in `backup`. The last five backups per file are kept.

This covers `AGENTS.md`, `SOUL.md`, `USER.md`, `VOICE.md` and
`agent.yaml` directly under `~/.somora/agents/<name>/`.

## The server config is checked after each write

When `file_write` or `file_patch` writes `~/.somora/config.yaml`, the
file is checked the way the server checks it. The write stays. If the
file does not validate, the result carries `config_invalid` with the
list of problems, and somora keeps running on the last valid version
until the file is fixed. `somora config check` runs the same check from
a shell.

## Builders write inside their project

A builder agent pinned to a project folder may write only there and in
its temp folder, `~/.somora/agents/<name>/tmp`. Outside of it the write
is refused. When you are attending, you are asked in the task panel
and have five minutes to answer. See
[Where a builder may write](builder.md#where-a-builder-may-write).

Chat agents are not affected.

## Reading text

`file_read` returns text with a line number in front of every line:

```
1: first line
2: second line
```

The agent can cite `path:line` and copy lines into `file_patch`,
leaving out the `N: ` prefix.

One call returns up to 2000 lines. The result says whether there is
more:

| Field | Meaning |
|---|---|
| `content` | The numbered lines. |
| `lines` | Total number of lines in the file. |
| `range` | First and last line shown, as `from` and `to`. |
| `summary` | `End of file (N lines).` or `Showing lines a-b of N. Continue with offset=b.` |
| `truncated`, `next_offset` | Set while there is more. Pass `next_offset` as `offset` to continue. |

A line longer than 2000 characters is cut and marked with
`… [line cut at 2000 chars]`. A whole result holds at most 200 000
characters.

## Images and PDFs

`file_read` looks at the first bytes of a file, not at its name, and
answers by kind. This works the same for a file on an SSH resource.
The file is downloaded first, up to 64 MB.

| File | Active model has `image` | Result |
|---|---|---|
| Text | any | Numbered text. |
| PNG, JPEG, WebP, GIF | yes | The image itself. The model sees it. |
| PDF | yes | The first 20 pages as images, rendered at 1.5 times page size. |
| Image or PDF | no | An error that points to `analyze_file`. |
| Video or audio | any | An error with the hint to extract a frame with `ffmpeg`. |
| Unknown binary | any | An error with the hint to inspect the file with `exec`. |

### Images are scaled before they reach the model

An image whose longer side is above `attachments.maxImageEdge` (2048
pixels by default) is scaled down to it before it goes to the model.
The file itself is not changed. This holds for every image a model
gets:

- `file_read`, local and on a resource
- chat attachments, also the screenshot button in the web client
- the review image after `image_generate`
- images from external MCP tools
- attachments replayed from earlier turns
- images sent to a decision model with `decision_evaluate`

Tools that work on an image, such as `image_generate` with
`reference_images`, get the original instead. The image handling page
describes the whole rule.

Text in screenshots stays readable. A 4K or Retina screenshot is
scaled by about half, which brings its text to the size it has on an
ordinary screen. The large providers scale big images down themselves,
so a bigger image costs more without showing more. Set
`maxImageEdge: 0` to send images as they are, or raise it when a model
of yours needs finer detail.

With scaling on, a source image may be up to 50 MB.
`attachments.maxImageBytes` then applies to the scaled image. PDF pages
cost tokens: roughly 1300 per page on Anthropic models. A PDF with more
than 20 pages comes with a note that only the first 20 were rendered.

A model declares what it can see with `capabilities` in its provider
entry in `config.yaml`, for example `[text, image, pdf, reasoning]`.

## When the model cannot see

`analyze_file` is the substitute for models without the `image`
capability. It sends an image or PDF to a vision worker model and
returns the worker's text answer.

```jsonc
{ "name": "analyze_file", "input": { "path": "chart.png", "prompt": "Which row of the table has the highest value?" } }
```

Without a `prompt` the worker describes the file in detail. The result
holds `analysis`, the `worker` that answered, `mimeType`, `size` and
`ms`. The agent is told to quote the description and not to claim it
saw the file.

The tool is offered only when both are true:

- `vision.worker` is set.
- The active model lacks the `image` capability. A model that can see
  should look itself with `file_read`.

### The worker chain

`vision.worker` takes one model or an ordered list. The list is tried
front to back until one worker answers. This keeps `analyze_file` alive
when a local vision model is not loaded at the moment.

```yaml
vision:
  worker:
    - local/qwen-vision               # preferred: free, stays in-house
    - openrouter/claude-haiku-4-5     # always available, costs money
  pdfWorker: openrouter/claude-sonnet-4-6   # optional, for PDFs only
```

Rules for the chain:

- A worker must be on an `openai-compatible` provider. Use a proxy such
  as OpenRouter to reach a Claude or GPT model.
- A worker needs the `image` capability for images. For a PDF, a worker
  with `pdf` gets the document itself. A worker with only `image` gets
  the pages as images, at most the first 20, and the prompt says when
  more exist. A worker with neither is skipped for that file.
- A worker that failed is skipped for `vision.healthCacheMs`. After a
  mere timeout it is skipped for the shorter `vision.timeoutCooldownMs`,
  because slow is not the same as gone.
- One attempt may take `vision.timeoutMs`. The whole chain may take
  `vision.totalBudgetMs`. A worker is not started when less than two
  seconds of that budget are left.
- When a later worker answered, the result lists the ones passed over
  in `fellBackFrom`, each with its reason.

`vision.maxOutputTokens` replaces the worker model's own output limit.
A description is short, and a reasoning model with a large limit can
think past the timeout. Raise it when you ask for long transcriptions.

**When `vision.pdfWorker` helps.** Without it, PDFs take the same
chain as images, so a local vision model reads them as page pictures.
Set `pdfWorker` when PDFs should go to a model that reads the document
itself. It gets the text, not only pictures of the pages, which is more
exact for long or text-heavy files and not limited to 20 pages.

> **Note:** A worker name that is not a model in `config.yaml` stops the
> server at start with a clear message. A missing capability or the
> wrong engine only writes a warning to the log.

## Editing with file patch

`file_patch` replaces `old_string` with `new_string`. `old_string` must
match exactly one place, unless `replace_all` is true. The result
carries:

| Field | Meaning |
|---|---|
| `replacements` | How many places were changed. |
| `strategy` | How the text was found, see below. |
| `lines` | Line range of the first replaced block, as `from` and `to`. |
| `diff` | The changed lines with their original line numbers. |
| `note` | Present when the match was not exact. |

### Tolerant matching

Models often reproduce text with small errors: a tab for four spaces,
one level of indentation missing, `\n` sent as two characters. So
`file_patch` tries eight ways to find `old_string`, in this order, and
uses the first that gives exactly one match (or any number with
`replace_all`):

| Strategy | What it tolerates |
|---|---|
| `exact` | Nothing. Always tried first. |
| `line_trimmed` | Leading and trailing whitespace of each line. |
| `block_anchor` | Blocks of three or more lines: first and last line equal, middle lines at least 0.65 similar, the block up to a quarter longer or shorter. |
| `whitespace_normalized` | Runs of whitespace count as one. A single line may also match inside a longer line. |
| `indentation_flexible` | A different common indentation. |
| `escape_normalized` | Escaped characters such as `\n`, `\t`, `\"`, `\\` in `old_string`. |
| `trimmed_boundary` | Whitespace around the whole `old_string`. |
| `context_aware` | First and last line equal, same length, at least half of the middle lines equal. |

Further rules:

- When nothing matches and every line of `old_string` starts like
  `12: `, the line numbers are removed and the search runs again.
- A tolerant match far larger than `old_string` is refused: twice the
  lines or more, three lines more, or four times the characters. The
  agent is asked to read the file again.
- Local files under `~/.somora` are matched with `exact` only. A wrong
  edit in the configuration or a persona file costs the most.
- Files with Windows line endings keep them.

## Searching and listing

`file_search` searches file contents with ripgrep and follows
`.gitignore`. A hit holds `path`, `line`, `col` and `text`. Lines up to
about 500 characters come back whole. A longer line is cut to a window
of 500 characters on each side of the match and marked
`truncated: true`.

`file_list` lists a folder. Each entry has `path`, `type` (`file`, `dir`
or `other`), `size` in bytes, and `mtime` and `ctime` in milliseconds.
Files starting with a dot are left out unless a `glob` such as `.*` asks
for them.

A recursive listing skips what `.gitignore` and `.ignore` exclude, such
as `node_modules`. Folders on the way to a listed file still appear.
Pass `respect_gitignore: false` to see everything.

Every file tool tells the model in its description to use it in place
of `cat`, `grep`, `sed` or `ls` through `exec`. The file tools page
safely, have no quoting problems and work the same over SSH.

## Shortened output is kept

When a tool result is too long, the full text is saved under
`~/.somora/agents/<agent>/tool-output/` and the result names the file:

| Field | When |
|---|---|
| `stdout_file`, `stderr_file` | `exec` output beyond about 60 000 characters, or beyond the capture limit of 256 KB per stream. |
| `full_output_file` | Any tool result over its size limit. |

The agent can then `file_read` a part of that file or `file_search` in
it, and need not run the command again. Files older than seven days are
removed, at server start and once an hour.

## Attaching files to a message

The web client offers a paperclip, drag and drop, and paste. The phone
app has an attachment button. Images (PNG, JPEG, GIF, WebP), PDFs and
text files can be attached, up to `attachments.maxPerTurn` per message.

Video and audio cannot be attached, because no engine can put them in a
prompt.

How an attachment travels:

1. The client uploads the raw bytes with `POST /attachments`. The server
   detects the type from the content, checks the size limit for that
   type and stores the file as `~/.somora/attachments/<sha256>.<ext>`.
2. The client sends the message with
   `attachments: [{hash, name, mime, size}]`.
3. The session file stores only these references, on the
   `user_message` event, never the bytes. When history is replayed, the
   bytes are loaded from disk.
4. The engine receives the file in its own format.

The same content uploaded twice is stored once. Stored attachments are
never removed automatically.

Agents use the same path. `agent_ask`, `spawn_subagent` and
`spawn_subagents` take `images: ["/absolute/path"]`, upload those files
and attach them to the turn they start. Naming a path in the message
text alone gives the other model only a string.

### Attachments and models that cannot see

When you attach an image or PDF and the active model cannot see it,
the turn does not fail. somora asks the vision worker for a description
and adds it to the message, marked as a description. The clients still
show your original attachment.

Only when no `vision.worker` is set is the turn refused. The error names
both ways out: switch the model, or configure a worker.

When you switch a session to a model that cannot see, older attachments
in the history are replaced by a text marker, so the session keeps
working:

```
[Image attachment "shot.png" (image/png, 1.2 MB) — not shown: the active model has no 'image' capability. It can be described with analyze_file({path:"..."}).]
```

### How each engine receives a PDF

| Engine | Images | PDFs |
|---|---|---|
| `claude-cli` | Native image block. | Native document block. |
| `codex-cli` | Native image input. | Rendered to one PNG per page. |
| `openai-compatible` | Works with models that can see. Local servers vary. | Depends on `pdfMode`. |

`pdfMode` is a setting of an `openai-compatible` provider:

| Value | Effect |
|---|---|
| `rasterize` (default) | Pages are rendered to PNG. Works with every backend that accepts images. |
| `native` | The PDF is passed as a file. Anthropic through OpenRouter and OpenAI accept this. Most local servers do not. |

`native` usually costs far fewer tokens, since `rasterize` sends one
image per page. Choose it when your backend supports it.

## Settings

All in `config.yaml`. The values shown are the defaults.

```yaml
workspace:
  default: ~/somoraworkspace

vision:
  # worker: <provider>/<model>      # unset by default; one model or a list
  # pdfWorker: <provider>/<model>   # unset by default
  timeoutMs: 60000
  totalBudgetMs: 90000
  maxOutputTokens: 1500
  healthCacheMs: 60000
  timeoutCooldownMs: 10000

attachments:
  maxImageEdge: 2048        # longer side in pixels, 0 = no scaling
  maxImageBytes: 5242880    # 5 MB
  maxPdfBytes: 33554432     # 32 MB
  maxTextBytes: 1048576     # 1 MB
  maxPerTurn: 10

providers:
  <name>:
    engine: openai-compatible
    pdfMode: rasterize
```

| Setting | Default | Meaning |
|---|---|---|
| `workspace.default` | `~/somoraworkspace` | Root for relative paths. Per agent: `workspace.path` in `agent.yaml`. |
| `vision.worker` | unset | Vision worker, or an ordered list of them. Without it `analyze_file` is hidden. |
| `vision.pdfWorker` | unset | Worker or list for PDFs only. Falls back to `vision.worker`, whose image-only workers read PDFs as page images. |
| `vision.timeoutMs` | `60000` | Time limit for one worker attempt. |
| `vision.totalBudgetMs` | `90000` | Time limit for the whole chain. |
| `vision.maxOutputTokens` | `1500` | Output limit for a worker answer. |
| `vision.healthCacheMs` | `60000` | How long a failed worker is skipped. `0` turns this off. |
| `vision.timeoutCooldownMs` | `10000` | How long a worker is skipped after a timeout. `0` turns this off. |
| `attachments.maxImageEdge` | `2048` | Longest side in pixels of an image sent to a model. Larger images are scaled down first. `0` sends images as they are. |
| `attachments.maxImageBytes` | `5242880` | Largest image sent to a model. With scaling on it applies after scaling, and a source image may be up to 50 MB. Without scaling it is the limit for uploads, `file_read` and `analyze_file`. |
| `attachments.maxPdfBytes` | `33554432` | Largest PDF for uploads and `analyze_file`. |
| `attachments.maxTextBytes` | `1048576` | Largest text attachment. |
| `attachments.maxPerTurn` | `10` | Attachments per message. |
| `providers.<name>.pdfMode` | `rasterize` | How an `openai-compatible` provider gets PDFs. |

The size defaults match the strictest supported provider, so they are
safe with every engine. Providers may also limit PDFs to 100 pages.

## Tools

| Tool | What it does | Limits |
|---|---|---|
| `file_read` | Reads text, an image or a PDF. | 2000 lines per call by default, 2000 characters per line, 200 000 characters per result. |
| `file_write` | Writes a text file. Creates parent folders. | None on the content. |
| `file_patch` | Replaces `old_string` with `new_string`. | `old_string` must be unique unless `replace_all`. |
| `file_search` | Searches file contents with a regular expression. | 50 hits by default, 500 at most, 100 000 characters of hit text. |
| `file_list` | Lists a folder. | 200 entries by default, 5000 at most. |
| `analyze_file` | Has a vision worker describe an image or PDF. Local files only. | `attachments.maxImageBytes`, `attachments.maxPdfBytes`. |

### Parameters

All tools except `analyze_file` also take `target`.

| Tool | Parameter | Meaning |
|---|---|---|
| `file_read` | `path` | The file. Required. |
| | `offset` | Number of lines to skip. `offset: 2000` starts at line 2001. |
| | `limit` | Number of lines to return. Default 2000. |
| `file_write` | `path`, `content` | Required. |
| | `mode` | `overwrite` (default), `create` (fails if the file exists) or `append` (creates the file if missing). |
| `file_patch` | `path`, `old_string`, `new_string` | Required. An empty `new_string` deletes the match. |
| | `replace_all` | Replace every match. Default false. |
| `file_search` | `pattern` | Regular expression in ripgrep syntax. Required. |
| | `path` | Folder or single file. Default: the workspace. |
| | `limit` | Most hits to return, 1 to 500. Default 50. |
| | `include` | Only files matching a glob: `*.ts`, `*.{ts,tsx}`, `src/**`, `!*.test.*`. |
| | `case_insensitive` | Ignore case. Default false. |
| | `context` | 0 to 5 lines around each hit, returned as `before` and `after`. |
| | `files_only` | Return only the matching paths, in `files`. |
| `file_list` | `path` | The folder. Required. |
| | `recursive` | Include subfolders. Default false. |
| | `sortBy` | `name` (default), `mtime` (newest first) or `size` (largest first). |
| | `limit` | 1 to 5000. Default 200. |
| | `glob` | Filter with `*`, `**` and `?`. Without `/` it matches the file name, with `/` the path below the listed folder. |
| | `respect_gitignore` | Default true. Applies to recursive listings. |
| `analyze_file` | `path` | The image or PDF. Required. |
| | `prompt` | What to ask the worker, up to 4000 characters. |

`create` and `overwrite` write to a temporary file and rename it, so a
file is never half written. The same holds for `file_patch`. Over SSH
the rename uses `posix-rename@openssh.com`. Servers without that
extension get a delete followed by a rename.

## Routes

| Route | Purpose |
|---|---|
| `POST /attachments` | Upload one file. The body is the raw bytes, the name goes in the `X-Somora-Filename` header. Returns `{hash, mime, kind, size, name}`. Multipart uploads are rejected with status 415. |
| `GET /attachments/:hash` | Fetch a stored attachment. |
| `POST /chat/send`, `POST /chat/send-sync`, `POST /spawn-async` | Accept `attachments: [{hash, name, mime, size}]` in the body. |

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| `file_search: ripgrep (rg) not found on PATH. Install via your package manager (brew/apt/dnf/pacman) or set $RG_BIN to a custom location.` | Install ripgrep on the somora host, or point `$RG_BIN` at it. There is no built-in fallback. |
| `file_search on '<resource>': ripgrep (rg) not installed.` | Install ripgrep on the remote machine. |
| `read blocked: ...` or `write blocked: ...` | The path is under a closed folder. See the table above. |
| `write refused: ... is outside the project folder` | A builder tried to write outside its project. |
| `file_read: file_not_found at '<path>'. Did you mean: a.ts, b.ts?` | The file does not exist. Up to three similar names from the same folder are suggested. |
| `file_list: file_not_found at '<path>'` | The folder does not exist. |
| `old_string was not found in the file` | The text differs too much. Read the file again and copy the lines exactly. |
| `old_string matches more than one place in the file` | Add surrounding lines, or pass `replace_all: true`. |
| `lacks 'image' capability` on `file_read` | The model cannot see. Use `analyze_file` or switch the model. |
| `analyze_file` is missing from the tool list | `vision.worker` is unset, or the active model can see images itself. |
| `no vision worker could handle this ...` | Every worker in the chain failed. The message lists each one with its reason. |
| `worker produced no text within ... output tokens` | The worker spent its output on thinking. Raise `vision.maxOutputTokens` or use another worker. |
| `vision.worker.no_image_capability` in the log at start | A worker cannot see images. Add `image` to the model if it has vision, or remove it from the chain. |
| `vision.worker.no_pdf_capability` in the log at start | A worker that may get PDFs has neither `pdf` nor `image`, so it can do nothing with a PDF. |
| `multipart uploads are not supported` | Send the raw file bytes as the body of `POST /attachments`. |
| A file ended up in `<workspace>/<workspace-name>/...` | The relative path started with the workspace folder's name. Drop that prefix. |

## See also

- [Security](security.md): the same path rules next to the shell, web and memory rules.
- [Resources](resources.md): setting up the SSH machines that `target` names.
- [Builder](builder.md): the write scope of a builder agent and the task panel.
- [Language servers](lsp.md): errors a builder gets after each write.
- [Agents](agents.md): persona files and `agent.yaml`.
- [Models](models.md): model capabilities and providers.
- [Projects](projects.md): pinning a session to a project folder.
- [API](api.md): every route in detail, including the chat routes.
- [Tools](tools.md): the list of all tools.
- [Image handling](image-handling.md): which image file a model sees and which a tool gets.
