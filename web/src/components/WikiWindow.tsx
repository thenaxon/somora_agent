// Wiki Explorer — read-only view of the shared wiki.
//
// Three columns: folder tree, rendered page, link graph + backlinks.
// Everything is read-only by design; the wiki is written by Deep/Lucid,
// and a viewer that can also edit would race those writers.
//
// Wikilink resolution happens server-side (`linkTargets` on the page
// payload) so Obsidian's matching rules — exact slug, case-insensitive,
// unique basename — exist in exactly one place.

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { ChevronDown, ChevronRight, FileText, Folder, Network, RefreshCw } from 'lucide-react';
import {
  api,
  type WikiGraphResponse,
  type WikiPageResponse,
  type WikiTreeNode,
  type WikiTreeResponse,
} from '../lib/api';
import { linkifyWikilinks } from '../lib/wikilinks';
import { WikiGraph } from './WikiGraph';

interface Props {
  /** Slug the window was last on; restored after a browser reload. */
  slug?: string;
  onSlugChange: (slug: string) => void;
}

// Module-level so ReactMarkdown doesn't rebuild its processor on every
// parent render (same reasoning as AssistantMarkdown — inline arrays
// remount every <pre>/<table> and lose their scroll position).
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];


function WikiWindowImpl({ slug, onSlugChange }: Props) {
  const [tree, setTree] = useState<WikiTreeResponse | null>(null);
  const [page, setPage] = useState<WikiPageResponse | null>(null);
  const [graph, setGraph] = useState<WikiGraphResponse | null>(null);
  const [scope, setScope] = useState<'local' | 'global'>('local');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [filter, setFilter] = useState('');
  const [graphExpanded, setGraphExpanded] = useState(false);

  const active = slug ?? null;

  const loadTree = useCallback(async () => {
    try {
      const t = await api.wikiTree();
      setTree(t);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  // Page load. Failures land in `error` rather than throwing away the
  // current page — a broken link should not blank the reader.
  useEffect(() => {
    if (!active) {
      setPage(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const p = await api.wikiPage(active);
        if (!cancelled) {
          setPage(p);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(`Seite '${active}': ${(err as Error).message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  useEffect(() => {
    if (scope === 'local' && !active) {
      setGraph(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const g = await api.wikiGraph(scope, active ?? undefined);
        if (!cancelled) setGraph(g);
      } catch {
        if (!cancelled) setGraph(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [scope, active]);

  // Opening a page auto-expands the folders leading to it, so graph
  // navigation keeps the tree in sync instead of leaving it stale.
  const openSlug = useCallback(
    (next: string) => {
      onSlugChange(next);
      const parts = next.split('/');
      if (parts.length > 1) {
        setOpen((prev) => {
          const s = new Set(prev);
          for (let i = 1; i < parts.length; i++) s.add(parts.slice(0, i).join('/'));
          return s;
        });
      }
    },
    [onSlugChange],
  );

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await api.wikiRefresh();
      await loadTree();
      if (active) setPage(await api.wikiPage(active));
      setGraph(await api.wikiGraph(scope, active ?? undefined));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [active, loadTree, scope]);

  const markdown = useMemo(() => {
    if (!page) return '';
    return linkifyWikilinks(page.markdown, page.linkTargets);
  }, [page]);

  const components = useMemo<Partial<Components>>(
    () => ({
      pre: ({ children }) => (
        <pre style={{ maxWidth: '100%', overflowX: 'auto' }}>{children}</pre>
      ),
      table: ({ children }) => (
        <div style={{ overflowX: 'auto' }}>
          <table>{children}</table>
        </div>
      ),
      a: ({ href, children }) => {
        if (typeof href === 'string' && href.startsWith('wiki:')) {
          const target = decodeURIComponent(href.slice('wiki:'.length));
          return (
            <a
              href="#"
              className="wiki-link"
              draggable={false}
              onClick={(e) => {
                e.preventDefault();
                openSlug(target);
              }}
            >
              {children}
            </a>
          );
        }
        if (typeof href === 'string' && href.startsWith('wiki-broken:')) {
          const target = decodeURIComponent(href.slice('wiki-broken:'.length));
          return (
            <span className="wiki-link-broken" title={`No such page '${target}'`}>
              {children}
            </span>
          );
        }
        return (
          <a href={href} target="_blank" rel="noopener noreferrer" draggable={false}>
            {children}
          </a>
        );
      },
    }),
    [openSlug],
  );

  const filtered = useMemo(() => {
    if (!tree) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return tree.nodes;
    const keep = (n: WikiTreeNode): WikiTreeNode | null => {
      if (n.type === 'page') {
        return n.title.toLowerCase().includes(q) || n.slug.toLowerCase().includes(q) ? n : null;
      }
      const kids = n.children.map(keep).filter((x): x is WikiTreeNode => x !== null);
      return kids.length ? { ...n, children: kids } : null;
    };
    return tree.nodes.map(keep).filter((x): x is WikiTreeNode => x !== null);
  }, [tree, filter]);

  // While filtering, every matching folder is expanded — a hit buried in
  // a collapsed folder looks like no hit at all.
  const effectiveOpen = filter.trim() ? null : open;

  return (
    <div className="wiki-root">
      <div className="wiki-col wiki-col-tree">
        <div className="wiki-tree-head">
          <input
            className="wiki-filter"
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            className="wiki-icon-btn"
            title="Re-scan"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} className={busy ? 'wiki-spin' : undefined} />
          </button>
        </div>
        <div className="wiki-tree">
          {filtered === null && <div className="wiki-muted">Loading…</div>}
          {filtered?.length === 0 && <div className="wiki-muted">no matches</div>}
          {filtered?.map((n) => (
            <TreeNode
              key={n.type === 'dir' ? `d:${n.path}` : `p:${n.slug}`}
              node={n}
              depth={0}
              open={effectiveOpen}
              activeSlug={active}
              onToggle={(path) =>
                setOpen((prev) => {
                  const s = new Set(prev);
                  if (s.has(path)) s.delete(path);
                  else s.add(path);
                  return s;
                })
              }
              onOpen={openSlug}
            />
          ))}
        </div>
        {tree && (
          <div className="wiki-tree-foot">
            {tree.pages} pages
          </div>
        )}
      </div>

      <div className="wiki-col wiki-col-reader">
        {error && <div className="wiki-error">{error}</div>}
        {!page && !error && <div className="wiki-muted wiki-pad">Select a page on the left.</div>}
        {page && (
          <>
            <div className="wiki-page-head">
              <span className="wiki-page-slug">{page.slug}</span>
              <span className="wiki-page-meta-right">
                {typeof page.frontmatter.type === 'string' && (
                  <span className="wiki-chip">{page.frontmatter.type}</span>
                )}
                <span className="wiki-page-date">
                  {new Date(page.mtimeMs).toLocaleDateString()}
                </span>
              </span>
            </div>
            <div className="wiki-page-body">
              <ReactMarkdown
                remarkPlugins={REMARK_PLUGINS}
                rehypePlugins={REHYPE_PLUGINS}
                components={components}
              >
                {markdown}
              </ReactMarkdown>
            </div>
          </>
        )}
      </div>

      <div className={graphExpanded ? 'wiki-col wiki-col-graph expanded' : 'wiki-col wiki-col-graph'}>
        <div className="wiki-graph-head">
          <Network size={14} />
          <button
            className={scope === 'local' ? 'wiki-tab active' : 'wiki-tab'}
            title="Just this page and its direct neighbours"
            onClick={() => setScope('local')}
          >
            This page
          </button>
          <button
            className={scope === 'global' ? 'wiki-tab active' : 'wiki-tab'}
            title="The whole wiki at once"
            onClick={() => setScope('global')}
          >
            Whole wiki
          </button>
        </div>
        <div className="wiki-graph-wrap">
          {graph ? (
            <WikiGraph
              graph={graph}
              activeSlug={active}
              onOpen={openSlug}
              expanded={graphExpanded}
              onToggleExpand={() => setGraphExpanded((v) => !v)}
            />
          ) : (
            <div className="wiki-graph-empty">
              {scope === 'local' ? 'Select a page on the left.' : 'Loading…'}
            </div>
          )}
        </div>
        {page && !graphExpanded && (
          <div className="wiki-links-panel">
            <LinkList title="links to" items={page.links} onOpen={openSlug} />
            <LinkList title="backlinks" items={page.backlinks} onOpen={openSlug} />
            {page.unresolved.length > 0 && (
              <div className="wiki-link-group">
                <div className="wiki-link-title">broken ({page.unresolved.length})</div>
                {page.unresolved.map((u) => (
                  <div key={u} className="wiki-link-broken-row" title="No such page">
                    {u}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function LinkList({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: Array<{ slug: string; title: string }>;
  onOpen: (slug: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="wiki-link-group">
      <div className="wiki-link-title">
        {title} ({items.length})
      </div>
      {items.map((it) => (
        <div
          key={it.slug}
          className="wiki-link-row"
          title={it.slug}
          onClick={() => onOpen(it.slug)}
        >
          {it.title}
        </div>
      ))}
    </div>
  );
}

function TreeNode({
  node,
  depth,
  open,
  activeSlug,
  onToggle,
  onOpen,
}: {
  node: WikiTreeNode;
  depth: number;
  /** null = filtering, everything expanded. */
  open: Set<string> | null;
  activeSlug: string | null;
  onToggle: (path: string) => void;
  onOpen: (slug: string) => void;
}) {
  if (node.type === 'page') {
    return (
      <div
        className={activeSlug === node.slug ? 'wiki-node wiki-page active' : 'wiki-node wiki-page'}
        style={{ paddingLeft: 6 + depth * 12 }}
        title={node.description || node.slug}
        onClick={() => onOpen(node.slug)}
      >
        <FileText size={13} />
        <span className="wiki-node-label">{node.title}</span>
      </div>
    );
  }
  const expanded = open === null || open.has(node.path);
  return (
    <>
      <div
        className="wiki-node wiki-dir"
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => onToggle(node.path)}
      >
        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Folder size={13} />
        <span className="wiki-node-label">{node.name}</span>
      </div>
      {expanded &&
        node.children.map((c) => (
          <TreeNode
            key={c.type === 'dir' ? `d:${c.path}` : `p:${c.slug}`}
            node={c}
            depth={depth + 1}
            open={open}
            activeSlug={activeSlug}
            onToggle={onToggle}
            onOpen={onOpen}
          />
        ))}
    </>
  );
}

export const WikiWindow = memo(WikiWindowImpl);
