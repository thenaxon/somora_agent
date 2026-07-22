// Force-directed view of the wiki's link graph.
//
// d3-force computes positions; rendering is plain SVG. The alternative
// (a graph component library) would have brought its own canvas, its own
// event model and ~200 KB for a view that draws circles and lines.
//
// The simulation runs on a rAF loop and stops itself once it cools
// below alphaMin — an always-on physics loop in a desktop window that
// may sit open for hours is a battery bug, not a feature.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { WikiGraphResponse } from '../lib/api';

interface Node extends SimulationNodeDatum {
  id: string;
  label: string;
  folder: string;
  degree: number;
}

type Link = SimulationLinkDatum<Node> & { type: 'wikilink' | 'related' };

interface Props {
  graph: WikiGraphResponse;
  /** Page the reader is on — drawn highlighted and pinned to centre. */
  activeSlug: string | null;
  onOpen: (slug: string) => void;
}

/** Deterministic colour per top-level folder. Same input always yields
 *  the same hue, so a page keeps its colour across local/global views
 *  and across reloads. */
function folderHue(folder: string): number {
  let h = 0;
  for (let i = 0; i < folder.length; i++) h = (h * 31 + folder.charCodeAt(i)) % 360;
  return h;
}

function radiusFor(degree: number, active: boolean): number {
  if (active) return 9;
  return Math.min(8, 3 + Math.sqrt(degree));
}

function WikiGraphImpl({ graph, activeSlug, onOpen }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const simRef = useRef<Simulation<Node, Link> | null>(null);
  const rafRef = useRef<number | null>(null);
  const [size, setSize] = useState({ w: 320, h: 320 });
  const [, setTick] = useState(0);
  const [hover, setHover] = useState<string | null>(null);

  // Node/link objects are mutated in place by the simulation, so they
  // must survive re-renders. Rebuilt only when the graph payload itself
  // changes — a hover must not restart the physics.
  const { nodes, links } = useMemo(() => {
    const ns: Node[] = graph.nodes.map((n) => ({ ...n }));
    const byId = new Map(ns.map((n) => [n.id, n]));
    const ls: Link[] = [];
    for (const e of graph.edges) {
      const source = byId.get(e.from);
      const target = byId.get(e.to);
      if (source && target) ls.push({ source, target, type: e.type });
    }
    return { nodes: ns, links: ls };
  }, [graph]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        setSize({ w: Math.floor(r.width), h: Math.floor(r.height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (nodes.length === 0) return;
    const cx = size.w / 2;
    const cy = size.h / 2;
    // Denser graphs need stronger repulsion or they collapse into a blob.
    const charge = nodes.length > 120 ? -140 : -260;
    const sim = forceSimulation<Node, Link>(nodes)
      .force('charge', forceManyBody<Node>().strength(charge))
      .force('center', forceCenter(cx, cy))
      .force('collide', forceCollide<Node>((d) => radiusFor(d.degree, d.id === activeSlug) + 4))
      .force(
        'link',
        forceLink<Node, Link>(links)
          .id((d) => d.id)
          .distance(nodes.length > 120 ? 45 : 70)
          .strength(0.35),
      )
      .alphaMin(0.02)
      .stop();
    simRef.current = sim;

    // Pin the active page to the middle: the local graph exists to show
    // *its* neighbourhood, and a wandering focus makes that hard to read.
    const active = nodes.find((n) => n.id === activeSlug);
    if (active) {
      active.fx = cx;
      active.fy = cy;
    }

    const step = () => {
      sim.tick();
      setTick((t) => t + 1);
      if (sim.alpha() > sim.alphaMin()) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
      }
    };
    sim.alpha(1);
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      sim.stop();
      simRef.current = null;
    };
  }, [nodes, links, size.w, size.h, activeSlug]);

  const handleOpen = useCallback((slug: string) => onOpen(slug), [onOpen]);

  if (graph.nodes.length === 0) {
    return (
      <div className="wiki-graph-empty">
        Keine Verbindungen — diese Seite verlinkt nichts und wird nirgends verlinkt.
      </div>
    );
  }

  return (
    <div className="wiki-graph" ref={wrapRef}>
      <svg width={size.w} height={size.h} role="img" aria-label="Wiki-Linkgraph">
        <g>
          {links.map((l, i) => {
            const s = l.source as Node;
            const t = l.target as Node;
            if (s.x == null || t.x == null) return null;
            const touchesHover =
              hover !== null && (s.id === hover || t.id === hover);
            const touchesActive =
              activeSlug !== null && (s.id === activeSlug || t.id === activeSlug);
            return (
              <line
                key={`${s.id}->${t.id}-${l.type}-${i}`}
                x1={s.x}
                y1={s.y ?? 0}
                x2={t.x}
                y2={t.y ?? 0}
                stroke={touchesHover || touchesActive ? 'var(--accent)' : 'var(--line-2)'}
                strokeOpacity={touchesHover ? 0.9 : touchesActive ? 0.55 : 0.28}
                strokeWidth={touchesHover ? 1.6 : 1}
                strokeDasharray={l.type === 'related' ? '3 3' : undefined}
              />
            );
          })}
        </g>
        <g>
          {nodes.map((n) => {
            if (n.x == null || n.y == null) return null;
            const isActive = n.id === activeSlug;
            const isHover = n.id === hover;
            const r = radiusFor(n.degree, isActive);
            const hue = folderHue(n.folder);
            return (
              <g
                key={n.id}
                transform={`translate(${n.x},${n.y})`}
                style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                onClick={() => handleOpen(n.id)}
              >
                <circle
                  r={r}
                  fill={isActive ? 'var(--accent)' : `hsl(${hue} 45% 55%)`}
                  fillOpacity={isActive ? 1 : isHover ? 0.95 : 0.75}
                  stroke={isActive || isHover ? 'var(--text-1)' : 'transparent'}
                  strokeWidth={isActive ? 2 : 1}
                />
                {(isActive || isHover || nodes.length <= 30) && (
                  <text
                    x={r + 4}
                    y={4}
                    fontSize={11}
                    fill={isActive || isHover ? 'var(--text-1)' : 'var(--text-2)'}
                    style={{ pointerEvents: 'none' }}
                  >
                    {n.label.length > 28 ? `${n.label.slice(0, 28)}…` : n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      {graph.truncated && (
        <div className="wiki-graph-note">
          Gekürzt auf die {graph.nodes.length} am stärksten verknüpften Seiten.
        </div>
      )}
    </div>
  );
}

export const WikiGraph = memo(WikiGraphImpl);
