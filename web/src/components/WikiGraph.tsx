// Force-directed view of the wiki's link graph.
//
// d3-force computes positions; rendering is plain SVG. The alternative
// (a graph component library) would have brought its own canvas, its own
// event model and ~200 KB for a view that draws circles and lines.
//
// The simulation runs on a rAF loop and stops itself once it cools
// below alphaMin — an always-on physics loop in a desktop window that
// may sit open for hours is a battery bug, not a feature.
//
// Zoom + pan are a view transform layered on top of the simulation, so
// the physics never re-runs when you scroll in. Labels stay a constant
// screen size (divided by the zoom factor) so a dense graph becomes
// readable by zooming, which is the whole point of a global view.

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
import { Maximize2, Minus, Plus, Scan } from 'lucide-react';
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
  /** Whether the graph pane is expanded to fill the window. */
  expanded?: boolean;
  onToggleExpand?: () => void;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 6;
/** At/above this zoom every label is drawn, not just hover/active. */
const LABEL_ZOOM = 1.4;

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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

interface View {
  k: number;
  tx: number;
  ty: number;
}

function WikiGraphImpl({ graph, activeSlug, onOpen, expanded, onToggleExpand }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const simRef = useRef<Simulation<Node, Link> | null>(null);
  const rafRef = useRef<number | null>(null);
  const [size, setSize] = useState({ w: 320, h: 320 });
  const [, setTick] = useState(0);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState<View>({ k: 1, tx: 0, ty: 0 });

  // Panning is tracked in refs so a drag doesn't re-render per mousemove;
  // only the committed view (in state) triggers a paint.
  const pan = useRef<{ active: boolean; moved: boolean; x: number; y: number } | null>(null);

  // Node/link objects are mutated in place by the simulation, so they
  // must survive re-renders. Rebuilt only when the graph payload itself
  // changes — a hover or a zoom must not restart the physics.
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

  // Reset the view whenever the graph changes (switching page or scope),
  // so a zoomed-in local view doesn't carry over to a fresh graph.
  useEffect(() => {
    setView({ k: 1, tx: 0, ty: 0 });
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

  // Zoom toward the cursor: the world point under the pointer stays put.
  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    setView((v) => {
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const k2 = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM);
      const wx = (mx - v.tx) / v.k;
      const wy = (my - v.ty) / v.k;
      return { k: k2, tx: mx - wx * k2, ty: my - wy * k2 };
    });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setView((v) => {
      const k2 = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM);
      // Zoom around the centre of the viewport.
      const cx = size.w / 2;
      const cy = size.h / 2;
      const wx = (cx - v.tx) / v.k;
      const wy = (cy - v.ty) / v.k;
      return { k: k2, tx: cx - wx * k2, ty: cy - wy * k2 };
    });
  }, [size.w, size.h]);

  const resetView = useCallback(() => setView({ k: 1, tx: 0, ty: 0 }), []);

  const onPointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    // Only start a pan from the background, never from a node.
    if ((e.target as Element).closest('[data-node]')) return;
    pan.current = { active: true, moved: false, x: e.clientX, y: e.clientY };
    (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const p = pan.current;
    if (!p?.active) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) p.moved = true;
    p.x = e.clientX;
    p.y = e.clientY;
    setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (pan.current) pan.current.active = false;
    try {
      (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer was never captured */
    }
  }, []);

  if (graph.nodes.length === 0) {
    return (
      <div className="wiki-graph-empty">
        No connections — this page links nothing and nothing links to it.
      </div>
    );
  }

  const showAllLabels = view.k >= LABEL_ZOOM || nodes.length <= 30;

  return (
    <div className="wiki-graph" ref={wrapRef}>
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        role="img"
        aria-label="Wiki link graph"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ cursor: pan.current?.active ? 'grabbing' : 'grab', touchAction: 'none' }}
      >
        <g transform={`translate(${view.tx},${view.ty}) scale(${view.k})`}>
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
                  strokeWidth={(touchesHover ? 1.6 : 1) / view.k}
                  strokeDasharray={l.type === 'related' ? `${3 / view.k} ${3 / view.k}` : undefined}
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
                  data-node
                  transform={`translate(${n.x},${n.y})`}
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHover(n.id)}
                  onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
                  onClick={() => {
                    // A pan that ended on a node must not open it.
                    if (pan.current?.moved) return;
                    handleOpen(n.id);
                  }}
                >
                  <circle
                    r={r}
                    fill={isActive ? 'var(--accent)' : `hsl(${hue} 45% 55%)`}
                    fillOpacity={isActive ? 1 : isHover ? 0.95 : 0.75}
                    stroke={isActive || isHover ? 'var(--text-1)' : 'transparent'}
                    strokeWidth={(isActive ? 2 : 1) / view.k}
                  />
                  {(isActive || isHover || showAllLabels) && (
                    <text
                      x={r + 4 / view.k}
                      y={4 / view.k}
                      fontSize={11 / view.k}
                      fill={isActive || isHover ? 'var(--text-1)' : 'var(--text-2)'}
                      style={{ pointerEvents: 'none' }}
                    >
                      {n.label.length > 32 ? `${n.label.slice(0, 32)}…` : n.label}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      <div className="wiki-graph-controls">
        <button className="wiki-graph-ctl" title="Zoom in" onClick={() => zoomBy(1.3)}>
          <Plus size={14} />
        </button>
        <button className="wiki-graph-ctl" title="Zoom out" onClick={() => zoomBy(1 / 1.3)}>
          <Minus size={14} />
        </button>
        <button className="wiki-graph-ctl" title="Reset view" onClick={resetView}>
          <Scan size={14} />
        </button>
        {onToggleExpand && (
          <button
            className="wiki-graph-ctl"
            title={expanded ? 'Collapse graph' : 'Expand graph'}
            onClick={onToggleExpand}
          >
            <Maximize2 size={14} />
          </button>
        )}
      </div>

      {graph.truncated && (
        <div className="wiki-graph-note">
          Showing the {graph.nodes.length} most-connected pages.
        </div>
      )}
    </div>
  );
}

export const WikiGraph = memo(WikiGraphImpl);
