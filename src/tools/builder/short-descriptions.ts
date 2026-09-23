// Short tool descriptions for builders (agent.yaml `kind: builder`).
//
// A chat agent needs the long descriptions: they carry the policy
// ("use this INSTEAD of exec", when a tool applies, what the caps
// mean) because nothing else in its prompt does. A builder's harness
// prompt carries that policy itself, the way opencode's system prompt
// does, so its tool descriptions can be what opencode's are: a few
// lines of what the tool takes and returns. Measured 2026-09-23: the 24
// builder tools cost ~15k chars of schema per request with the long
// texts; these bring it to about half.
//
// One place, not 24 files, so the second text is easy to find when the
// long one changes ([[feedback_tool_dual_schema_drift]] applies here
// too: keep the parameter facts identical to the Zod/JSON schema).
// A tool without an entry keeps its long description.

export const BUILDER_SHORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  file_read:
    'Read a text file. Lines come back numbered `N: text`, 2000 lines per call (offset/limit to page); ' +
    'the result says "End of file" or the offset to continue with. Copy lines into file_patch WITHOUT the ' +
    '`N: ` prefix. Images and PDFs come back as images when the model can see them.',
  file_write:
    'Write a whole text file (create, overwrite, or append). Parent folders are created. Prefer file_patch ' +
    'for changing an existing file.',
  file_patch:
    'Replace `old_string` with `new_string` in a file. Copy old_string exactly from file_read (without the ' +
    'line-number prefix); it must be unique unless replace_all. Small whitespace/indentation differences are ' +
    'tolerated; the result shows a diff of the changed lines.',
  file_search:
    'Regex search over file contents (ripgrep). `include` narrows to a glob like "*.ts" or "src/**"; ' +
    '`context` adds lines around each hit; `files_only` returns just the paths. Hits carry path, line, text.',
  file_list:
    'List a directory (type, size, mtime per entry). `recursive` with a `glob` like "**/*.test.ts" finds ' +
    'files by name; ignored paths (node_modules, build output) are skipped.',
  analyze_file:
    'Describe an image or PDF through the vision worker (offered only when your own model cannot see). Returns text.',
  exec:
    'Run a shell command in the working directory (or `cwd`). Returns exit_code, stdout, stderr. Long output ' +
    'is shortened and the full text saved to a file the result names. `background:true` for servers and ' +
    'long jobs (then use process). Use it for git, package managers, builds and tests — not for reading, ' +
    'writing or searching files.',
  process: 'Manage background exec jobs: list, poll, log (tail), write (stdin), kill.',
  todo_write:
    'Replace the task list of this session (the person sees it). Items: content, status (pending | ' +
    'in_progress | completed | cancelled), priority. Exactly one in_progress at a time; mark completed only ' +
    'when verified.',
  ask_user:
    'Ask the person watching a question with 2-6 options (free text is always possible). Waits for the ' +
    'answer or a timeout; returns {answered, answers, text}. Only for a real fork you cannot decide yourself.',
  plan_write: 'Write the plan file of this session (Markdown; replaces the file). The only write allowed in the plan phase.',
  spawn_subagent:
    'Start a helper of your own kind on a sealed sub-task, in the same working directory. Give it the complete ' +
    'brief — it sees nothing of this conversation. Returns a task_id; fetch the outcome with subagent_result ' +
    '(or wait:true to block).',
  subagent_result: 'Fetch or wait for a helper\'s result by task_id.',
  agent_ask:
    'Ask a colleague from the team a question in their specialty and get the answer back (wait:true) or a ' +
    'call_id (wait:false). A consultation, not a hand-off.',
  agent_ask_result: 'Fetch or wait for the answer to an agent_ask call by call_id.',
  skill: 'Load a skill named in your prompt: returns its instructions and files.',
  skill_list: 'List the skills available to you.',
  web_fetch: 'Fetch a URL and return its readable text (Markdown), capped by max_chars.',
  web_search: 'Search the web (Brave) for a query: titles, URLs, snippets. For library docs, error messages, release notes — then web_fetch the page you need.',
  project_get: 'Read a project by slug: name, description, pointer paths, working directory.',
  project_list: 'List projects (slug, name, entity, tags).',
  project_create:
    'Create a project pointer (slug, name, entity from entity_list, paths, `workdir` = its repository folder). ' +
    'Pin it with project_focus to make workdir the working directory.',
  project_focus: 'Pin a project to this session (its workdir becomes the working directory) or clear the pin.',
  memory_search: 'Search your memory notes, the shared wiki and the vault for a query; returns matching notes.',
  memory_get: 'Read one memory or wiki note by slug.',
  time_now: 'Current date and time (optionally for a timezone).',
};

/** The description a builder's model sees for `name`. */
export function builderToolDescription(name: string, long: string): string {
  return BUILDER_SHORT_DESCRIPTIONS[name] ?? long;
}
