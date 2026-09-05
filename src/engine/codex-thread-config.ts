// Thread config overlay for the Codex app-server (design §3.3). This is
// the successor of the `--disable <feature>` / `-c key=value` argv of the
// old `codex exec` adapter: the same lock-down, expressed as dotted config
// keys on `thread/start` / `thread/resume`. Audit on every Codex bump
// (`codex features list`): a new stable+default-true feature that exposes
// a tool surface or a host-config leak goes here.

export interface CodexThreadConfigOptions {
  /** config.codexCli.shellEnvironmentPolicy — 'inherit-all' | 'core-only'. */
  shellEnvironmentPolicy?: string;
  /** Namespaces Codex must keep directly model-visible (images). */
  directOnlyNamespaces?: readonly string[];
}

export function buildCodexThreadConfig(opts: CodexThreadConfigOptions = {}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    // Code Mode host on; whether the model runs code-mode-only comes from
    // Codex's model catalog (gpt-5.6 family, gpt-6), not from us.
    'features.code_mode': true,
    // Direct system access — somora's exec/file/tmux tools are the only
    // host surface, on every engine alike.
    'features.shell_tool': false,
    'features.unified_exec': false,
    'features.shell_snapshot': false,
    // External integrations
    'features.browser_use': false,
    'features.browser_use_external': false,
    'features.browser_use_full_cdp_access': false,
    'features.in_app_browser': false,
    'features.computer_use': false,
    'features.image_generation': false,
    'features.apps': false,
    // Sub-agents: somora has spawn_subagent. 0.153 grew multi_agent_v2 +
    // an `agents` table; OpenClaw disables all three.
    'features.multi_agent': false,
    'features.multi_agent_v2': false,
    'agents.enabled': false,
    // Context-leak vectors
    'features.personality': false,
    'features.mentions_v2': false,
    // Codex-side hooks / plugins
    'features.hooks': false,
    'features.plugins': false,
    'features.plugin_sharing': false,
    'features.remote_plugin': false,
    // Behaviour toggles we do not want flipping under us
    'features.goals': false,
    'features.fast_mode': false,
    'features.view_image': false,
    'features.skill_search': false,
    'tools.update_plan.enabled': false,
    'tools.experimental_request_user_input.enabled': false,
    web_search: 'disabled',
    'skills.bundled.enabled': false,
    'skills.include_instructions': false,
    project_doc_max_bytes: 0,
    project_root_markers: [],
    notify: [],
    // The user's ~/.codex/config.toml never reaches somora agents (own
    // CODEX_HOME); belt and braces for MCP servers.
    mcp_servers: {},
    suppress_unstable_features_warning: true,
  };
  if ((opts.shellEnvironmentPolicy ?? 'inherit-all') !== 'core-only') {
    config['shell_environment_policy.inherit'] = 'all';
  }
  if (opts.directOnlyNamespaces && opts.directOnlyNamespaces.length > 0) {
    config['features.code_mode'] = {
      enabled: true,
      direct_only_tool_namespaces: [...opts.directOnlyNamespaces],
    };
  }
  return config;
}
