// Abilities window — per-agent visibility matrix for tools AND skills,
// plus external MCP server status (design: private/mcp-hub-design.md
// §4.6; skills half added 2026-08-31 on Rene's request — the same
// matrix for "which agent may use which skill").
//
// Left: agent picker. Main: every tool on this instance (built-in
// grouped by toolset, external grouped by MCP server) and, below, every
// skill, each with a visibility toggle for the selected agent. Toggles
// manage EXACT-name deny entries only; hand-written pattern rules
// (globs, toolset:, allow-lists) flip that matrix read-only rather
// than guessing how to rewrite operator policy. All writes go through
// the server (PUT /agents/:name/tools, PUT /agents/:name/skills) — the
// UI never touches agent.yaml itself. The window's internal kind stays
// `tools` so saved window layouts keep working.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Eye, EyeOff, Plug, RefreshCw, Sparkles } from 'lucide-react';
import {
  api,
  type AgentInfo,
  type AgentSkillsResponse,
  type AgentToolsResponse,
  type McpStatusResponse,
} from '../lib/api';

export function ToolsWindow() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  const [data, setData] = useState<AgentToolsResponse | null>(null);
  const [skills, setSkills] = useState<AgentSkillsResponse | null>(null);
  const [mcp, setMcp] = useState<McpStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api
      .agents()
      .then((list) => {
        setAgents(list);
        setAgent((a) => a ?? list[0]?.name ?? null);
      })
      .catch((err) => setError((err as Error).message));
    void api.mcpStatus().then(setMcp).catch(() => setMcp(null));
  }, []);

  const refresh = useCallback(async (name: string) => {
    try {
      const [t, s] = await Promise.all([api.agentTools(name), api.agentSkills(name)]);
      setData(t);
      setSkills(s);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const toggleSkill = useCallback(
    async (skillName: string, currentlyVisible: boolean) => {
      if (!agent || !skills || skills.hasPatternRules || saving) return;
      const deny = new Set(skills.gating?.deny ?? []);
      if (currentlyVisible) deny.add(skillName);
      else deny.delete(skillName);
      setSaving(true);
      try {
        await api.setAgentSkills(agent, { deny: [...deny], allow: skills.gating?.allow ?? [] });
        await refresh(agent);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [agent, skills, saving, refresh],
  );

  useEffect(() => {
    if (agent) void refresh(agent);
  }, [agent, refresh]);

  const groups = useMemo(() => {
    if (!data) return [];
    const byKey = new Map<string, typeof data.tools>();
    for (const t of data.tools) {
      const key = t.mcpServer ? `mcp: ${t.mcpServer}` : t.toolset;
      const list = byKey.get(key);
      if (list) list.push(t);
      else byKey.set(key, [t]);
    }
    // Built-in toolsets alphabetical first, MCP servers after.
    return [...byKey.entries()].sort(([a], [b]) => {
      const am = a.startsWith('mcp: ') ? 1 : 0;
      const bm = b.startsWith('mcp: ') ? 1 : 0;
      return am - bm || a.localeCompare(b);
    });
  }, [data]);

  const toggle = useCallback(
    async (toolName: string, currentlyVisible: boolean) => {
      if (!agent || !data || data.hasPatternRules || saving) return;
      const deny = new Set(data.gating?.deny ?? []);
      if (currentlyVisible) deny.add(toolName);
      else deny.delete(toolName);
      setSaving(true);
      try {
        await api.setAgentTools(agent, { deny: [...deny], allow: data.gating?.allow ?? [] });
        await refresh(agent);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [agent, data, saving, refresh],
  );

  return (
    <div style={{ display: 'flex', height: '100%', fontSize: 13 }}>
      {/* Agent picker */}
      <div
        style={{
          width: 150,
          borderRight: '1px solid var(--bg-3)',
          padding: 8,
          overflowY: 'auto',
          flexShrink: 0,
        }}
      >
        {agents.map((a) => (
          <div
            key={a.name}
            data-testid={`tools-agent-${a.name}`}
            onClick={() => setAgent(a.name)}
            style={{
              padding: '6px 8px',
              borderRadius: 6,
              cursor: 'pointer',
              background: agent === a.name ? 'var(--bg-3)' : 'transparent',
              color: agent === a.name ? 'var(--text-1)' : 'var(--text-2)',
            }}
          >
            {a.icon ? `${a.icon} ` : ''}
            {a.name}
          </div>
        ))}
      </div>

      {/* Matrix */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {error && (
          <div style={{ color: 'var(--danger, #e5534b)', marginBottom: 8 }}>
            <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> {error}
          </div>
        )}
        {data?.hasPatternRules && (
          <div
            style={{
              background: 'var(--bg-2)',
              border: '1px solid var(--bg-3)',
              borderRadius: 6,
              padding: '8px 10px',
              marginBottom: 10,
              color: 'var(--text-2)',
            }}
          >
            <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> This agent's{' '}
            <code>agent.yaml</code> carries hand-written pattern rules (
            {[
              ...(data.gating?.deny.filter((p) => p.includes('*') || p.startsWith('toolset:')) ??
                []),
              ...(data.gating?.allow ?? []).map((p) => `allow:${p}`),
            ].join(', ')}
            ) — the matrix is read-only. Edit the file to change them.
          </div>
        )}
        {!data && !error && <div style={{ color: 'var(--text-2)' }}>Loading…</div>}
        {groups.map(([group, list]) => (
          <div key={group} style={{ marginBottom: 14 }}>
            <div
              style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: 1,
                color: 'var(--text-2)',
                marginBottom: 4,
              }}
            >
              {group}
            </div>
            {list.map((t) => (
              <div
                key={t.name}
                data-testid={`tools-row-${t.name}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 6px',
                  borderRadius: 4,
                  opacity: t.visible ? 1 : 0.45,
                }}
                title={t.description}
              >
                <span
                  data-testid={`tools-toggle-${t.name}`}
                  onClick={() => void toggle(t.name, t.visible)}
                  style={{
                    cursor: data?.hasPatternRules || saving ? 'not-allowed' : 'pointer',
                    color: t.visible ? 'var(--accent)' : 'var(--text-2)',
                    display: 'inline-flex',
                  }}
                >
                  {t.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                </span>
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    color: t.visible ? 'var(--text-1)' : 'var(--text-2)',
                  }}
                >
                  {t.name}
                </span>

              </div>
            ))}
          </div>
        ))}

        {/* Skills — same matrix, same rules, one section. */}
        {skills && (
          <div style={{ marginTop: 18, borderTop: '1px solid var(--bg-3)', paddingTop: 12 }}>
            <div
              style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: 1,
                color: 'var(--text-2)',
                marginBottom: 4,
              }}
            >
              <Sparkles size={12} style={{ verticalAlign: -1 }} /> skills
            </div>
            {skills.hasPatternRules && (
              <div
                style={{
                  background: 'var(--bg-2)',
                  border: '1px solid var(--bg-3)',
                  borderRadius: 6,
                  padding: '8px 10px',
                  marginBottom: 8,
                  color: 'var(--text-2)',
                }}
              >
                <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> This agent's{' '}
                <code>agent.yaml</code> carries a hand-written skill allow-list (
                {(skills.gating?.allow ?? []).join(', ')}) — the skill matrix is read-only. Edit the
                file to change it.
              </div>
            )}
            {skills.skills.length === 0 && (
              <div style={{ color: 'var(--text-2)' }}>
                No skills installed — see <code>docs/skills.md</code>.
              </div>
            )}
            {skills.skills.map((s) => (
              <div
                key={s.name}
                data-testid={`skills-row-${s.name}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 6px',
                  borderRadius: 4,
                  opacity: s.visible ? 1 : 0.45,
                }}
                title={s.available ? s.description : `${s.description}\n\nunavailable on this host: ${s.unavailableReason ?? 'requirements not met'}`}
              >
                <span
                  data-testid={`skills-toggle-${s.name}`}
                  onClick={() => void toggleSkill(s.name, s.visible)}
                  style={{
                    cursor: skills.hasPatternRules || saving ? 'not-allowed' : 'pointer',
                    color: s.visible ? 'var(--accent)' : 'var(--text-2)',
                    display: 'inline-flex',
                  }}
                >
                  {s.visible ? <Eye size={15} /> : <EyeOff size={15} />}
                </span>
                <span
                  style={{
                    fontFamily: '"JetBrains Mono", monospace',
                    color: s.visible ? 'var(--text-1)' : 'var(--text-2)',
                  }}
                >
                  {s.name}
                </span>
                {!s.available && (
                  <span style={{ fontSize: 11, color: 'var(--warn, #d29922)' }}>unavailable</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MCP server status */}
      <div
        style={{
          width: 230,
          borderLeft: '1px solid var(--bg-3)',
          padding: 12,
          overflowY: 'auto',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: 1,
            color: 'var(--text-2)',
            marginBottom: 6,
          }}
        >
          <Plug size={12} style={{ verticalAlign: -1 }} /> MCP servers
        </div>
        {!mcp?.enabled && (
          <div style={{ color: 'var(--text-2)' }}>
            None configured — add <code>mcp.servers</code> to config.yaml.
          </div>
        )}
        {mcp?.enabled &&
          Object.entries(mcp.servers).map(([name, s]) => (
            <div
              key={name}
              data-testid={`mcp-server-${name}`}
              style={{
                border: '1px solid var(--bg-3)',
                borderRadius: 6,
                padding: 8,
                marginBottom: 8,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    background:
                      s.state === 'connected'
                        ? 'var(--ok, #3fb950)'
                        : s.state === 'pending'
                          ? 'var(--warn, #d29922)'
                          : 'var(--danger, #e5534b)',
                  }}
                />
                <span style={{ fontFamily: '"JetBrains Mono", monospace' }}>{name}</span>
                <span
                  data-testid={`mcp-reconnect-${name}`}
                  title="Reconnect"
                  onClick={() =>
                    void api
                      .mcpReconnect(name)
                      .then(() => api.mcpStatus().then(setMcp))
                      .catch((err) => setError((err as Error).message))
                  }
                  style={{ marginLeft: 'auto', cursor: 'pointer', color: 'var(--text-2)' }}
                >
                  <RefreshCw size={13} />
                </span>
              </div>
              <div style={{ color: 'var(--text-2)', fontSize: 12, marginTop: 4 }}>
                {s.state} · {s.toolCount} tool{s.toolCount === 1 ? '' : 's'}
                {s.transport ? ` · ${s.transport}` : ''}
              </div>
              {s.lastError && (
                <div style={{ color: 'var(--danger, #e5534b)', fontSize: 11, marginTop: 4 }}>
                  {s.lastError.slice(0, 120)}
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
