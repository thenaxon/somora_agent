// Abilities window — per-agent visibility matrix for tools AND skills,
// plus external MCP server status (design: private/mcp-hub-design.md
// §4.6; skills half added 2026-08-31 on the operator's request — the same
// matrix for "which agent may use which skill").
//
// Left: agent picker. Main: every tool on this instance (built-in
// grouped by toolset, external grouped by MCP server) and, below, every
// skill, each with a visibility toggle for the selected agent. The
// matrix is always editable (2026-10-08): a click is sent as "these
// names on/off" (POST /agents/:name/tools/toggle, …/skills/toggle) and
// the server works out the rules — a family's eye writes ONE rule for
// the family (`toolset:<tag>`, `mcp__<server>__*`, skills `*`) so tools
// it gains later stay off too; one tool back on inside it becomes an
// exception under allow. The UI never touches agent.yaml itself. The
// window's internal kind stays `tools` so saved window layouts keep
// working.
//
// Groups are collapsible and carry their own eye (2026-09-10, Leo's
// report). One MCP server can contribute dozens of tools, and turning
// that server off for an agent meant clicking every single row; the
// group eye writes them all in ONE request instead. Collapsed by
// default for the same reason — with a big MCP connected the flat list
// was hundreds of rows deep before you reached the skills.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  /** Show/hide every row at once. Undefined while a write is in flight. */
  onToggleAll: (() => void) | undefined;
  /** The family is off by a rule, so tools it gains later are off too. */
  ruleOff?: boolean;
  children: ReactNode;
}

/** One collapsible group: header with expander, group eye and counts.
 *  Exported for tools-render.test.mts. */
export function Group({ groupKey, label, total, hidden, expanded, onToggleExpanded, onToggleAll, ruleOff, children }: GroupProps) {
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
        {ruleOff && (
          <span
            data-testid={`tools-group-rule-${groupKey}`}
            title="Switched off as a whole: tools this group gains later stay off too. Single tools switched on inside it are exceptions."
            style={{ textTransform: 'none', letterSpacing: 0, opacity: 0.75, fontStyle: 'italic' }}
          >
            · off incl. future
          </span>
        )}
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

  // The agent whose data may land in state: a reply for an agent that is
  // no longer selected is dropped, so a click never works on another
  // agent's switches (a quick click after switching agents did that).
  const current = useRef<string | null>(null);
  const refresh = useCallback(async (name: string) => {
    try {
      const [t, s] = await Promise.all([api.agentTools(name), api.agentSkills(name)]);
      if (current.current !== name) return;
      setData(t);
      setSkills(s);
      setError(null);
    } catch (err) {
      if (current.current === name) setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    current.current = agent;
    setData(null);
    setSkills(null);
    if (agent) void refresh(agent);
  }, [agent, refresh]);

  const isBuilder = data?.kind === 'builder';
  const kindDefaults = useMemo(() => new Set(data?.kindDefaults ?? []), [data]);
  const groups = useMemo(() => {
    if (!data) return [];
    // Two views by kind. A builder: its own set (the kind's defaults) as
    // one group, everything else under "more" — off until switched on,
    // and switching on writes the name into agent.yaml `tools.allow`. A
    // chat agent: the full programme grouped by toolset, minus the three
    // builder-only tools (task list, question, plan file).
    if (isBuilder) {
      const own = data.tools.filter((t) => kindDefaults.has(t.name));
      const more = data.tools.filter((t) => !kindDefaults.has(t.name));
      return [
        ['builder tools', own] as [string, typeof data.tools],
        ['more (off unless switched on)', more] as [string, typeof data.tools],
      ];
    }
    const byKey = new Map<string, typeof data.tools>();
    for (const t of data.tools) {
      if (t.toolset === 'builder') continue;
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
  }, [data, isBuilder, kindDefaults]);

  /** Send one click and reload. One request however many names — a
   *  family of 60 MCP tools is a single call, and its eye (`group`)
   *  lets the server write one rule for the whole family. */
  const send = useCallback(
    async (which: 'tools' | 'skills', names: string[], visible: boolean, group: boolean) => {
      // Only on the switches of the agent that is selected.
      const shown = which === 'tools' ? data?.agent : skills?.agent;
      if (!agent || saving || names.length === 0 || shown !== agent) return;
      setSaving(true);
      try {
        if (which === 'tools') await api.toggleAgentTools(agent, names, visible, group);
        else await api.toggleAgentSkills(agent, names, visible, group);
        await refresh(agent);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setSaving(false);
      }
    },
    [agent, saving, refresh, data, skills],
  );

  // A row's eye flips that row. A group's eye hides the group while
  // anything in it is still visible, otherwise brings all of it back —
  // so a half-hidden group goes dark in one click, back in a second.
  const toggle = useCallback(
    (toolName: string, currentlyVisible: boolean) => void send('tools', [toolName], !currentlyVisible, false),
    [send],
  );
  const toggleGroup = useCallback(
    (list: { name: string; visible: boolean }[]) =>
      void send('tools', list.map((t) => t.name), list.every((t) => !t.visible), true),
    [send],
  );
  const toggleSkill = useCallback(
    (skillName: string, currentlyVisible: boolean) => void send('skills', [skillName], !currentlyVisible, false),
    [send],
  );
  const toggleAllSkills = useCallback(() => {
    const list = skills?.skills ?? [];
    void send('skills', list.map((s) => s.name), list.every((s) => !s.visible), true);
  }, [send, skills]);

  /** The family rule a chat agent's group is switched off by, if any. */
  const ruleOff = useCallback(
    (list: { toolset: string; mcpServer?: string }[]) => {
      if (isBuilder || list.length === 0) return false;
      const t = list[0]!;
      const rule = t.mcpServer ? `mcp__${t.mcpServer}__*` : `toolset:${t.toolset}`;
      return !!data?.gating?.deny.includes(rule);
    },
    [data, isBuilder],
  );

  const toolsLocked = saving;
  const skillsLocked = saving;
  const handWritten = data?.handWrittenRules ?? [];

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
        {handWritten.length > 0 && (
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
            <code>agent.yaml</code> also carries hand-written rules ({handWritten.join(', ')}). They
            still apply; the switches below show their effect and stay usable.
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
            ruleOff={ruleOff(list)}
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
              ruleOff={skills.kind !== 'builder' && !!skills.gating?.deny.includes('*')}
            >
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
