import type { Catalog } from './index.ts';

export const ENGINES: Catalog = {
  // ── claudeCli ─────────────────────────────────────────────────────
  'claudeCli': {
    label: 'Claude engine',
    help: 'Time limits and the shared login for agents that run on the claude-cli engine.',
    level: 'basic',
    docs: 'setup.md#claude-and-codex-engines',
  },
  'claudeCli.mcpToolTimeoutMs': {
    label: 'Longest tool call',
    help: 'How long one somora tool call may run on claude-cli before the engine gives up on it.',
    more: 'The same time also tells somora how long a running tool may keep the engine silent before it counts as stuck. Keep it at least as high as the longest wait for other work (agentLoop.longTaskMaxTimeoutMs), or a long wait is cut off early. The MCP_TOOL_TIMEOUT environment variable, when set, wins over this value.',
    level: 'advanced',
    unit: 'ms',
    docs: 'setup.md#claude-and-codex-engines',
  },
  'claudeCli.mcpConnectTimeoutMs': {
    label: 'Tool connection wait',
    help: 'How long claude-cli waits for somora\'s tools to connect when a turn starts; running tool calls are not affected.',
    more: 'Raise it only if turns fail at the start because the tools did not connect on a slow machine. The MCP_TIMEOUT environment variable, when set, wins over this value.',
    level: 'advanced',
    unit: 'ms',
    docs: 'setup.md#claude-and-codex-engines',
  },
  'claudeCli.sharedUserCredentials': {
    label: 'Share your Claude login',
    help: 'Keeps somora\'s Claude login and the one in your own ~/.claude folder in step, so logging in or refreshing in one place reaches the other.',
    more: 'Turn it off only when somora runs on a separate Claude account; somora then touches neither login file, and you log it in once with CLAUDE_CONFIG_DIR=~/.somora/claude-home somora claude auth login.',
    level: 'basic',
    docs: 'setup.md#isolated-claude-config-dir',
  },

  // ── codexCli ──────────────────────────────────────────────────────
  'codexCli': {
    label: 'Codex engine',
    help: 'Time limit, shell environment and an old tool list for agents that run on the codex-cli engine.',
    level: 'basic',
    docs: 'setup.md#claude-and-codex-engines',
  },
  'codexCli.toolTimeoutSec': {
    label: 'Longest tool call',
    help: 'How long one somora tool call may run on codex-cli before it is cut off.',
    more: 'The same time also tells somora how long a running tool may keep the engine silent before it counts as stuck. Keep it at least as long as the longest wait for other work (agentLoop.longTaskMaxTimeoutMs). The SOMORA_CODEX_TOOL_TIMEOUT_SEC environment variable, when set, wins over this value.',
    level: 'advanced',
    unit: 's',
    docs: 'setup.md#claude-and-codex-engines',
  },
  'codexCli.shellEnvironmentPolicy': {
    label: 'Shell environment',
    help: 'What the shell commands codex-cli runs on its own can see of the server\'s environment, such as keys from somora.env that skills need.',
    more: '"inherit-all" passes everything; "core-only" passes only basics like PATH and HOME, and skills that need a key from the environment then find it missing. Choose core-only only for a hardening reason, after checking every skill. The SOMORA_CODEX_SHELL_ENV_POLICY environment variable, when set, wins.',
    level: 'advanced',
    docs: 'setup.md#claude-and-codex-engines',
  },
  'codexCli.directTools': {
    label: 'Always-visible tools (old form)',
    help: 'An old list of tools codex-cli always sees; when set it replaces the shared always-visible tool list for codex-cli only.',
    more: 'Use toolCatalog.alwaysVisible, or an add/remove list under toolCatalog.engines, instead. The server log says once at start when this old list is still in use.',
    level: 'advanced',
    docs: 'tools.md#settings',
  },

  // ── tmux ──────────────────────────────────────────────────────────
  'tmux': {
    label: 'Terminal sessions',
    help: 'How somora keeps an eye on coding programs that agents start in tmux terminal sessions.',
    level: 'basic',
    docs: 'tmux.md#settings',
  },
  'tmux.attention': {
    label: 'Attention watcher',
    help: 'Notices when a coding program an agent started in tmux finishes or waits for input, and brings the agent back if it missed that.',
    more: 'Only local sessions of kind claude-code, codex or opencode that somora created are watched; sessions made by hand, plain shells and remote sessions never are.',
    level: 'basic',
    docs: 'tmux.md#the-attention-watcher',
  },
  'tmux.attention.enabled': {
    label: 'Watch coding sessions',
    help: 'Turns the watcher on; off means no checking of sessions and no attention information in tmux tool results.',
    level: 'basic',
    docs: 'tmux.md#the-attention-watcher',
  },
  'tmux.attention.wake': {
    label: 'Wake the agent',
    help: 'Starts a turn for the agent when it missed that its program finished; off only marks the session as needing attention.',
    more: 'A wake waits while the agent is busy in that chat, and an ignored wake is not repeated.',
    level: 'basic',
    docs: 'tmux.md#rules-that-keep-it-calm',
  },
  'tmux.attention.pollMs': {
    label: 'Check every',
    help: 'How often the watcher looks at each watched session; a missed finish turns into a wake at most this much later.',
    level: 'advanced',
    unit: 'ms',
    docs: 'tmux.md#settings',
  },
  'tmux.attention.cooldownS': {
    label: 'Pause between wakes',
    help: 'The shortest time between two wakes for the same session, so a program that flips quickly between working and ready does not wake the agent again and again.',
    level: 'advanced',
    unit: 's',
    docs: 'tmux.md#rules-that-keep-it-calm',
  },
  'tmux.attention.dailyCapPerSession': {
    label: 'Wakes per session and day',
    help: 'The most wake turns one session may start per day (UTC); past it the session is only marked as needing attention.',
    level: 'advanced',
    unit: 'wakes',
    docs: 'tmux.md#rules-that-keep-it-calm',
  },

  // ── lsp ───────────────────────────────────────────────────────────
  'lsp': {
    label: 'Language servers',
    help: 'Checks the code a builder agent writes and hands it the errors right on the result of the write.',
    level: 'basic',
    docs: 'lsp.md#what-you-get',
  },
  'lsp.enabled': {
    label: 'Check written code',
    help: 'Off starts no language server: builder agents get their file writes back without error checks.',
    level: 'basic',
    docs: 'lsp.md#settings',
  },
  'lsp.waitMs': {
    label: 'Wait for the check',
    help: 'How long a file write waits for the language server\'s verdict; without a verdict in time the write returns without errors and the turn goes on.',
    more: 'The first check in a project waits longer on its own, because the server loads the project first.',
    level: 'advanced',
    unit: 'ms',
    docs: 'lsp.md#how-long-a-write-waits',
  },
  'lsp.servers': {
    label: 'Servers',
    help: 'Settings per language server, by its name: typescript or pyright.',
    more: 'A server without an entry here is on and found under ~/.somora/lsp or on the PATH. Install one with somora lsp install <name>.',
    level: 'advanced',
    docs: 'lsp.md#settings',
  },
  'lsp.servers.*.enabled': {
    label: 'On',
    help: 'Off switches this one language server off; the others keep working.',
    level: 'advanced',
    docs: 'lsp.md#settings',
  },
  'lsp.servers.*.command': {
    label: 'Program to run',
    help: 'The language server program to start instead of the one somora finds under ~/.somora/lsp or on the PATH.',
    more: 'It is started with --stdio.',
    level: 'advanced',
    placeholder: '/usr/local/bin/typescript-language-server',
    docs: 'lsp.md#settings',
  },
};
