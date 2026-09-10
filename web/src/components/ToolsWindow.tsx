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
//
// Groups are collapsible and carry their own eye (2026-09-10, Luca's
// report). One MCP server can contribute dozens of tools, and turning
// that server off for an agent meant clicking every single row; the
// group eye writes them all in ONE request instead. Collapsed by
// default for the same reason — with a big MCP connected the flat list
// was hundreds of rows deep before you reached the skills.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Plug,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { toggleGroupVisibility, type AbilityRow } from '../lib/ability-gating';
import {
  api,
  type AgentInfo,
  type AgentSkillsResponse,
  type AgentToolsResponse,
  type McpStatusResponse,
} from '../lib/api';

/** Which groups the user has opened, by group key. Persisted so the
 *  window does not forget the toolsets you actually work with every
 *  time it is closed. Stores the OPEN ones: the default is collapsed,
 *  so an empty/missing entry has to mean "all shut". */
const STORAGE_KEY_EXPANDED = 'somora-abilities-expanded';
/** Group key of the skills section — namespaced so it can never collide
 *  with a toolset or an MCP server called "skills". There IS one: the
 *  toolset that holds `skill_list`/`skill`, which is why the section's
 *  test id says `skills-section` as well. */
const SKILLS_KEY = '\0skills';

function readExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_EXPANDED);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((k): k is string => typeof k === 'string')) : new Set();
  } catch {
    // Blocked or corrupt storage — everything collapsed, same as a
    // first visit.
    return new Set();
  }
}

const groupHeadStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: 'var(--text-2)',
  marginBottom: 4,
  cursor: 'pointer',
  userSelect: 'none',
};

interface GroupProps {
  /** Stable key for storage and test ids — `label` may be JSX. */
  groupKey: string;
  label: ReactNode;
  /** How many rows the group holds, and how many of them are hidden —
   *  the counts are the whole point of a collapsed group. */
  total: number;
  hidden: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Show/hide every row at once. Undefined while the matrix is
   *  read-only or a write is in flight. */
  onToggleAll: (() => void) | undefined;
  children: ReactNode;
}

/** One collapsible group: header with expander, group eye and counts.
 *  Exported for tools-render.test.mts. */
export function Group({ groupKey, label, total, hidden, expanded, onToggleExpanded, onToggleAll, children }: GroupProps) {
  const allHidden = total > 0 && hidden === total;
  const someHidden = hidden > 0 && hidden < total;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={groupHeadStyle} onClick={onToggleExpanded}>
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span
          data-testid={`tools-group-toggle-${groupKey}`}
          title={
            !onToggleAll
              ? undefined
              : allHidden
                ? 'Show all in this group'
                : 'Hide all in this group'
          }
          onClick={(e) => {
            // The header itself expands/collapses — the eye must not
            // also do that on its way through.
            e.stopPropagation();
            onToggleAll?.();
          }}
          style={{
            display: 'inline-flex',
            cursor: onToggleAll ? 'pointer' : 'not-allowed',
            // Mixed groups sit between the two states: the eye is open
            // (one more click hides everything) but dimmed, so "some
            // hidden" is not mistaken for "all visible".
            color: allHidden ? 'var(--text-2)' : 'var(--accent)',
            opacity: someHidden ? 0.55 : 1,
          }}
        >
          {allHidden ? <EyeOff size={14} /> : <Eye size={14} />}
        </span>
        <span style={{ color: hidden === total && total > 0 ? 'var(--text-2)' : 'var(--text-1)' }}>
          {label}
        </span>
        <span style={{ textTransform: 'none', letterSpacing: 0, opacity: 0.75 }}>
          {total}
          {hidden > 0 ? ` · ${hidden} hidden` : ''}
        </span>
      </div>
      {expanded && children}
    </div>
  );
}

export function ToolsWindow() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  const [data, setData] = useState<AgentToolsResponse | null>(null);
  const [skills, setSkills] = useState<AgentSkillsResponse | null>(null);
  const [mcp, setMcp] = useState<McpStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY_EXPANDED, JSON.stringify([...expanded]));
    } catch {
      // Quota or blocked — the open/closed state just won't survive
      // this session, which is not worth surfacing.
    }
  }, [expanded]);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

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

  /** Write a tool deny-list and reload. One request however many names
   *  changed — a group of 60 MCP tools is a single PUT, not 60. */
  const writeTools = useCallback(
    async (rows: AbilityRow[]) => {
      if (!agent || !data || data.hasPatternRules || saving) return;
      const deny = toggleGroupVisibility(data.gating?.deny ?? [], rows);
      setSaving(true);
      try {
        await api.setAgentTools(agent, { deny, allow: data.gating?.allow ?? [] });
        await refresh(agent);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [agent, data, saving, refresh],
  );

  const toggle = useCallback(
    (toolName: string, currentlyVisible: boolean) =>
      void writeTools([{ name: toolName, visible: currentlyVisible }]),
    [writeTools],
  );

  const toggleGroup = useCallback(
    (list: AbilityRow[]) => void writeTools(list),
    [writeTools],
  );

  const writeSkills = useCallback(
    async (rows: AbilityRow[]) => {
      if (!agent || !skills || skills.hasPatternRules || saving) return;
      const deny = toggleGroupVisibility(skills.gating?.deny ?? [], rows);
      setSaving(true);
      try {
        await api.setAgentSkills(agent, { deny, allow: skills.gating?.allow ?? [] });
        await refresh(agent);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [agent, skills, saving, refresh],
  );

  const toggleSkill = useCallback(
    (skillName: string, currentlyVisible: boolean) =>
      void writeSkills([{ name: skillName, visible: currentlyVisible }]),
    [writeSkills],
  );

  const toggleAllSkills = useCallback(
    () => void writeSkills(skills?.skills ?? []),
    [writeSkills, skills],
  );

  const toolsLocked = !!data?.hasPatternRules || saving;
  const skillsLocked = !!skills?.hasPatternRules || saving;

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
            <AlertTriangle size={14} className="icon-inline" /> {error}
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
            <AlertTriangle size={14} className="icon-inline" /> This agent's{' '}
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
          <Group
            key={group}
            groupKey={group}
            label={group}
            total={list.length}
            hidden={list.filter((t) => !t.visible).length}
            expanded={expanded.has(group)}
            onToggleExpanded={() => toggleExpanded(group)}
            onToggleAll={toolsLocked ? undefined : () => toggleGroup(list)}
          >
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
                  onClick={() => toggle(t.name, t.visible)}
                  style={{
                    cursor: toolsLocked ? 'not-allowed' : 'pointer',
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
          </Group>
        ))}

        {/* Skills — same matrix, same rules, one more group. */}
        {skills && (
          <div style={{ marginTop: 18, borderTop: '1px solid var(--bg-3)', paddingTop: 12 }}>
            <Group
              groupKey="skills-section"
              label={
                <>
                  <Sparkles size={12} className="icon-inline" /> skills
                </>
              }
              total={skills.skills.length}
              hidden={skills.skills.filter((s) => !s.visible).length}
              expanded={expanded.has(SKILLS_KEY)}
              onToggleExpanded={() => toggleExpanded(SKILLS_KEY)}
              onToggleAll={skillsLocked || skills.skills.length === 0 ? undefined : toggleAllSkills}
            >
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
                  <AlertTriangle size={14} className="icon-inline" /> This agent's{' '}
                  <code>agent.yaml</code> carries a hand-written skill allow-list (
                  {(skills.gating?.allow ?? []).join(', ')}) — the skill matrix is read-only. Edit
                  the file to change it.
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
                    onClick={() => toggleSkill(s.name, s.visible)}
                    style={{
                      cursor: skillsLocked ? 'not-allowed' : 'pointer',
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
            </Group>
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
          <Plug size={12} className="icon-inline" /> MCP servers
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
