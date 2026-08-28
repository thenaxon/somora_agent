// Images window — the human entrance to image generation.
//
// Left: the form. Right: everything generated so far, newest first,
// with the prompt and specs that produced it. Agents reach the same
// core through the `image_generate` tool, so what can be set here is
// exactly what they can set.
//
// The form is built from the SELECTED MODEL's capabilities, fetched
// per model. A field the provider pins down becomes a dropdown; a
// field it says nothing about becomes free text, because "we don't
// know" must not present as "nothing allowed" — that would make a
// perfectly valid model look broken.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Download, Film, Image as ImageIcon, Loader2, RefreshCw, Search, Trash2, Wand2,
} from 'lucide-react';
import { useFileViewOpener } from './FileViewContext';
import {
  api,
  type ImageCapabilities,
  type ImageModelOption,
  type ImageRecordDto,
  type MediaRecordDto,
  type VideoStatusResponse,
  type ImagesStatus,
  type ImageSpecField,
} from '../lib/api';

/** Order shown in the form. Matches how people describe an image:
 *  shape first, then how big, then how good. */
const SPEC_FIELDS: Array<{ key: ImageSpecField; label: string; placeholder: string }> = [
  { key: 'aspect_ratio', label: 'Aspect ratio', placeholder: 'e.g. 16:9' },
  // Two vocabularies for the same thing, and which one a model speaks
  // is its own business: some take a tier ("2K"), some explicit pixels,
  // some both. Every field here is hidden unless the selected model
  // actually accepts it, so offering all of them costs nothing.
  { key: 'size', label: 'Size (pixels)', placeholder: 'e.g. 1024x1792' },
  { key: 'resolution', label: 'Resolution', placeholder: 'e.g. 2K' },
  { key: 'quality', label: 'Quality', placeholder: 'e.g. medium' },
  { key: 'output_format', label: 'Format', placeholder: 'e.g. png' },
  { key: 'background', label: 'Background', placeholder: 'e.g. transparent' },
];

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatCost(usd?: number): string | null {
  if (usd === undefined) return null;
  // Sub-cent generations are common; two decimals would show 0.00 and
  // read as free.
  return usd < 0.01 ? `<$0.01` : `$${usd.toFixed(2)}`;
}

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export function specSummary(specs: Record<string, string | number | undefined>): string {
  return SPEC_FIELDS.map((f) => specs[f.key])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(' · ');
}

export function MediaWindow() {
  const [status, setStatus] = useState<ImagesStatus | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [caps, setCaps] = useState<ImageCapabilities | null>(null);

  const [prompt, setPrompt] = useState('');
  const [specs, setSpecs] = useState<Partial<Record<ImageSpecField, string>>>({});
  const [count, setCount] = useState(1);
  const [saveTo, setSaveTo] = useState('');
  const [seed, setSeed] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [images, setImages] = useState<MediaRecordDto[]>([]);
  const [total, setTotal] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [query, setQuery] = useState('');
  const openFileView = useFileViewOpener();
  /** Which medium the gallery shows, and which one the form makes. */
  const [kindFilter, setKindFilter] = useState<'all' | 'image' | 'video'>('all');
  /** Starts on whatever is actually configured. Landing on an empty
   *  image form because images happen to be listed first would be the
   *  same "switch that does nothing" the tool list already avoids. */
  const [mode, setMode] = useState<'image' | 'video'>('image');
  const [video, setVideo] = useState<VideoStatusResponse | null>(null);
  const [videoModel, setVideoModel] = useState('');
  const [seconds, setSeconds] = useState('');
  const [videoSpecs, setVideoSpecs] = useState<{ aspect_ratio?: string; size?: string }>({});
  const [reloadTick, setReloadTick] = useState(0);
  const [selected, setSelected] = useState<MediaRecordDto | null>(null);

  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const models: ImageModelOption[] = useMemo(() => status?.models ?? [], [status]);

  useEffect(() => {
    void api
      .imagesStatus()
      .then((s) => {
        setStatus(s);
        setModel((m) => m ?? s.models?.[0]?.name ?? null);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  const reload = useCallback(async (q: string) => {
    try {
      const res = await api.media({
        ...(q ? { query: q } : {}),
        ...(kindFilter !== 'all' ? { kind: kindFilter } : {}),
        limit: 60,
      });
      setImages(res.items);
      setTotal(res.total);
      setTotalBytes(res.totalBytes);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [kindFilter]);

  useEffect(() => {
    void reload('');
  }, [reload, reloadTick]);

  // Debounced search — the gallery reads every record, and a request
  // per keystroke would be wasteful for no gain in responsiveness.
  useEffect(() => {
    const t = setTimeout(() => void reload(query), 250);
    return () => clearTimeout(t);
  }, [query, reload]);

  // Switching models replaces the spec vocabulary. Values that the new
  // model also accepts are kept, the rest fall back to its defaults —
  // retyping "16:9" after every model switch would be busywork.
  useEffect(() => {
    if (!model) return;
    let cancelled = false;
    void api
      .imageCapabilities(model)
      .then((c) => {
        if (cancelled) return;
        setCaps(c);
        setSpecs((prev) => {
          const next: Partial<Record<ImageSpecField, string>> = {};
          for (const { key } of SPEC_FIELDS) {
            // A model that doesn't take the field gets nothing carried
            // over, or the request would be rejected for a value the
            // form no longer even shows.
            if (c.supported && !c.supported.includes(key)) continue;
            const allowed = c.values[key];
            const current = prev[key];
            if (current && (!allowed || allowed.includes(current))) next[key] = current;
            else if (c.defaults[key]) next[key] = c.defaults[key];
          }
          return next;
        });
      })
      .catch(() => {
        if (!cancelled) setCaps(null);
      });
    return () => {
      cancelled = true;
    };
  }, [model]);

  const maxN = caps?.maxN ?? 10;

  /** Does the selected model take this parameter? A provider that
   *  publishes its parameter list is authoritative — offering a field
   *  the model ignores is worse than not offering it, because the
   *  result silently disregards what was set. No list ⇒ show
   *  everything and let the provider decide. */
  const supports = useCallback(
    (field: string) => (caps?.supported ? caps.supported.includes(field) : true),
    [caps],
  );

  const visibleSpecFields = useMemo(
    () => SPEC_FIELDS.filter((f) => supports(f.key)),
    [supports],
  );

  // Land on the surface that exists. Only runs while the answer is
  // still unknown, so it never fights a deliberate switch.
  useEffect(() => {
    if (!video) return;
    const imagesOn = (status?.models?.length ?? 0) > 0;
    if (!imagesOn && video.enabled) setMode('video');
    if (imagesOn && !video.enabled) setMode('image');
  }, [video, status]);

  // Video jobs run for minutes, so the window watches them: it shows
  // progress while they run and refreshes the gallery the moment one
  // lands. Polling stops as soon as nothing is running — an idle
  // Media window should cost nothing.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const seenDone = new Set<string>();

    const tick = async (): Promise<void> => {
      try {
        const v = await api.videoStatus();
        if (cancelled) return;
        setVideo(v);
        const jobs = v.jobs ?? [];
        for (const j of jobs) {
          const done = j.status === 'completed' || j.status === 'failed';
          if (done && !seenDone.has(j.id)) {
            seenDone.add(j.id);
            if (j.status === 'completed') setReloadTick((t) => t + 1);
          }
        }
        const busy = jobs.some((j) => j.status === 'queued' || j.status === 'in_progress');
        if (!cancelled) timer = setTimeout(() => void tick(), busy ? 4000 : 20000);
      } catch {
        if (!cancelled) timer = setTimeout(() => void tick(), 20000);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Media made elsewhere — by an agent, or in another window — would
  // otherwise only appear after closing and reopening this one.
  useEffect(() => {
    const onFocus = (): void => setReloadTick((t) => t + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const generateVideo = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.generateVideo({
        prompt: prompt.trim(),
        ...(videoModel ? { model: videoModel } : {}),
        ...(seconds.trim() ? { seconds: Number(seconds.trim()) } : {}),
        ...(videoSpecs.aspect_ratio ? { aspect_ratio: videoSpecs.aspect_ratio } : {}),
      });
      // The job list picks it up on its next tick; nothing to show yet.
      setVideo(await api.videoStatus());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [prompt, busy, videoModel, seconds, videoSpecs]);

  const generate = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.generateImage({
        prompt: prompt.trim(),
        ...(model ? { model } : {}),
        ...specs,
        ...(count > 1 && maxN > 1 ? { n: count } : {}),
        ...(seed.trim() && supports('seed') ? { seed: Number(seed.trim()) } : {}),
        ...(saveTo.trim() ? { save_to: saveTo.trim() } : {}),
      });
      // Put the new images at the head rather than refetching, so the
      // result is on screen the moment it exists.
      setImages((prev) => [...res.images, ...prev]);
      setTotal((t) => t + res.images.length);
      setTotalBytes((b) => b + res.images.reduce((sum, i) => sum + i.bytes, 0));
      setSelected(res.images[0] ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [prompt, busy, model, specs, count, maxN, seed, supports, saveTo]);

  const forget = useCallback(async (id: string) => {
    try {
      await api.forgetImage(id);
      setImages((prev) => prev.filter((i) => i.id !== id));
      setTotal((t) => Math.max(0, t - 1));
      setSelected((s) => (s?.id === id ? null : s));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const reuseSpecs = useCallback((record: ImageRecordDto) => {
    setPrompt(record.prompt);
    setModel(record.modelName);
    const next: Partial<Record<ImageSpecField, string>> = {};
    for (const { key } of SPEC_FIELDS) {
      const v = record.specs[key];
      if (typeof v === 'string') next[key] = v;
    }
    setSpecs(next);
    if (typeof record.specs.seed === 'number') setSeed(String(record.specs.seed));
    promptRef.current?.focus();
  }, []);

  // Only bail out when NEITHER surface exists. Checking images alone
  // hid the entire window — gallery and all — from a video-only
  // install, which is the same mistake the desktop tile made.
  if (status && !status.enabled && video && !video.enabled) {
    return (
      <div style={{ padding: 20, fontSize: 13, color: 'var(--text-1)' }}>
        <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> Media generation is not
        configured. Add an <code>imageGen</code> or <code>videoGen</code> block with at least
        one model to config.yaml.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', height: '100%', fontSize: 13, minHeight: 0 }}>
      {/* ── form ────────────────────────────────────────────────── */}
      <div
        style={{
          width: 288,
          flex: 'none',
          borderRight: '1px solid var(--line)',
          padding: 12,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {/* Image and video are separate surfaces with almost no
            overlapping parameters, so the form switches wholesale
            rather than showing a union of fields half of which do
            nothing. The switch only appears when video is configured. */}
        {video?.enabled && (
          <div data-testid="media-mode-switch" style={{ display: 'flex', gap: 6 }}>
            {(['image', 'video'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                style={{
                  ...smallBtnStyle,
                  flex: 1,
                  borderColor: mode === m ? 'var(--accent)' : 'var(--line-2)',
                  color: mode === m ? 'var(--accent)' : 'var(--text-2)',
                }}
              >
                {m === 'image' ? (
                  <><ImageIcon size={11} /> Image</>
                ) : (
                  <><Film size={11} /> Video</>
                )}
              </button>
            ))}
          </div>
        )}

        {mode === 'image' && models.length === 0 && (
          <div style={{ color: 'var(--text-2)', fontSize: 12, lineHeight: 1.45 }}>
            <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> No image models configured —
            set <code>imageGen</code> in config.yaml. The gallery below still shows everything
            that exists.
          </div>
        )}

        <label style={labelStyle}>
          Model
          {mode === 'video' ? (
            <select
              value={videoModel}
              onChange={(e) => setVideoModel(e.target.value)}
              style={inputStyle}
            >
              {(video?.models ?? []).map((m) => (
                <option key={m.name} value={m.name}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : (
            <select
              value={model ?? ''}
              onChange={(e) => setModel(e.target.value)}
              style={inputStyle}
            >
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </label>

        <label style={labelStyle}>
          Prompt
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter')
                void (mode === 'video' ? generateVideo() : generate());
            }}
            rows={4}
            placeholder="What should the image show?"
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }}
          />
        </label>

        {mode === 'video' && (
          <>
            <label style={labelStyle}>
              Seconds
              <input
                value={seconds}
                onChange={(e) => setSeconds(e.target.value)}
                placeholder="model default"
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              Aspect ratio
              <select
                value={videoSpecs.aspect_ratio ?? ''}
                onChange={(e) =>
                  setVideoSpecs((v) => ({ ...v, aspect_ratio: e.target.value || undefined }))
                }
                style={inputStyle}
              >
                <option value="">— model default —</option>
                {['16:9', '9:16', '1:1'].map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>
            <div style={{ color: 'var(--text-3)', fontSize: 11, lineHeight: 1.4 }}>
              A render takes minutes. This starts it and returns — the gallery updates by itself
              when it lands.
            </div>
          </>
        )}
        {mode === 'image' && visibleSpecFields.map(({ key, label, placeholder }) => {
          const allowed = caps?.values[key];
          return (
            <label key={key} style={labelStyle}>
              {label}
              {allowed && allowed.length > 0 ? (
                <select
                  value={specs[key] ?? ''}
                  onChange={(e) => setSpecs((s) => ({ ...s, [key]: e.target.value }))}
                  style={inputStyle}
                >
                  <option value="">— model default —</option>
                  {allowed.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    value={specs[key] ?? ''}
                    onChange={(e) => setSpecs((s) => ({ ...s, [key]: e.target.value }))}
                    placeholder={placeholder}
                    // Suggestions where the model has a sweet spot but
                    // no fixed list — a datalist offers them without
                    // taking away the freedom to type something else.
                    list={caps?.recommended?.[key] ? `img-rec-${key}` : undefined}
                    style={inputStyle}
                  />
                  {caps?.recommended?.[key] && (
                    <datalist id={`img-rec-${key}`}>
                      {caps.recommended[key]!.map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                  )}
                </>
              )}
            </label>
          );
        })}

        {/* Count is pointless at a ceiling of one, and seed only exists
            on models that accept it — grok-imagine takes neither. */}
        {(maxN > 1 || supports('seed')) && (
          <div style={{ display: 'flex', gap: 8 }}>
            {maxN > 1 && (
              <label style={{ ...labelStyle, flex: 1 }}>
                Count
                <input
                  type="number"
                  min={1}
                  max={maxN}
                  value={count}
                  onChange={(e) =>
                    setCount(Math.max(1, Math.min(maxN, Number(e.target.value) || 1)))
                  }
                  style={inputStyle}
                />
              </label>
            )}
            {supports('seed') && (
              <label style={{ ...labelStyle, flex: 1 }}>
                Seed
                <input
                  value={seed}
                  onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="random"
                  style={inputStyle}
                />
                <span style={hintStyle}>
                  Same prompt and seed reproduce the same image.
                </span>
              </label>
            )}
          </div>
        )}

        <label style={labelStyle}>
          Also save to
          <input
            value={saveTo}
            onChange={(e) => setSaveTo(e.target.value)}
            placeholder={status?.outputDir ?? 'optional folder'}
            style={inputStyle}
          />
          <span style={hintStyle}>
            Every image is kept in {status?.outputDir ?? 'the images folder'}. This adds a second
            location.
          </span>
        </label>

        <button
          type="button"
          disabled={
            busy ||
            !prompt.trim() ||
            (mode === 'image' ? models.length === 0 : !(video?.models?.length ?? 0))
          }
          onClick={() => void (mode === 'video' ? generateVideo() : generate())}
          style={{
            marginTop: 2,
            padding: '9px 12px',
            borderRadius: 6,
            border: '1px solid var(--accent-dim)',
            background: busy || !prompt.trim() ? 'var(--bg-3)' : 'var(--accent-glow)',
            color: busy || !prompt.trim() ? 'var(--text-2)' : 'var(--text-0)',
            cursor: busy || !prompt.trim() ? 'default' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            fontSize: 13,
          }}
        >
          {busy ? (
            <>
              <Loader2 size={14} className="somora-spin" /> Generating…
            </>
          ) : (
            <>
              <Wand2 size={14} /> {mode === 'video' ? 'Start render' : 'Generate'}
            </>
          )}
        </button>

        {caps?.source === 'unknown' && (
          <span style={hintStyle}>
            Could not read this model's parameter list — fields accept any value and the provider
            decides.
          </span>
        )}

        {error && (
          <div
            style={{
              color: 'var(--danger)',
              border: '1px solid var(--danger)',
              borderRadius: 6,
              padding: '8px 10px',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.45,
            }}
          >
            {error}
          </div>
        )}
      </div>

      {/* ── running renders ─────────────────────────────────────
          A video takes minutes and nobody waits for it, so the window
          says what is cooking instead of looking idle. */}
      {(video?.jobs ?? []).some((j) => j.status === 'queued' || j.status === 'in_progress') && (
        <div
          style={{
            position: 'absolute',
            left: 12,
            right: 12,
            bottom: 10,
            zIndex: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          {(video?.jobs ?? [])
            .filter((j) => j.status === 'queued' || j.status === 'in_progress')
            .slice(0, 4)
            .map((j) => (
              <div
                key={j.id}
                title={j.prompt}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  fontSize: 11,
                  color: 'var(--text-2)',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line-2)',
                  borderRadius: 5,
                  padding: '4px 8px',
                }}
              >
                <Loader2 size={11} className="somora-spin" />
                <span style={{ flex: 'none' }}>{j.modelName}</span>
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {j.prompt}
                </span>
                <span style={{ flex: 'none' }}>
                  {j.status === 'queued'
                    ? j.queuePosition !== undefined
                      ? `queued · ${j.queuePosition} ahead`
                      : 'queued'
                    : `${j.progress ?? 0}%`}
                </span>
              </div>
            ))}
        </div>
      )}

      {/* ── gallery ─────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 12px',
            borderBottom: '1px solid var(--line)',
            flex: 'none',
          }}
        >
          <Search size={13} style={{ color: 'var(--text-2)', flex: 'none' }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search prompts…"
            style={{ ...inputStyle, flex: 1, marginTop: 0 }}
          />
          {/* One switch for both media, because "show me what I made"
              is one question. Hidden when video isn't configured: with
              only images around, a filter with two dead options is
              worse than none — the same rule the tool list follows. */}
          {video?.enabled &&
            (['all', 'image', 'video'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKindFilter(k)}
              style={{
                ...smallBtnStyle,
                flex: 'none',
                borderColor: kindFilter === k ? 'var(--accent)' : 'var(--line-2)',
                color: kindFilter === k ? 'var(--accent)' : 'var(--text-2)',
              }}
            >
              {k === 'all' ? 'All' : k === 'image' ? 'Images' : 'Video'}
              </button>
            ))}
          {/* Media made by an agent lands while this window is open;
              without this you had to close and reopen it to see it. */}
          <button
            type="button"
            onClick={() => setReloadTick((t) => t + 1)}
            title="Reload the gallery"
            style={{ ...smallBtnStyle, flex: 'none' }}
          >
            <RefreshCw size={11} />
          </button>
          <span style={{ color: 'var(--text-2)', fontSize: 11, flex: 'none' }}>
            {total} item{total === 1 ? '' : 's'} · {formatBytes(totalBytes)}
          </span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 12, minHeight: 0 }}>
          {images.length === 0 ? (
            <div style={{ color: 'var(--text-2)', textAlign: 'center', paddingTop: 40 }}>
              <ImageIcon size={20} style={{ opacity: 0.5 }} />
              <div style={{ marginTop: 8 }}>
                {query ? 'Nothing matches that search.' : 'No images yet.'}
              </div>
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: 10,
              }}
            >
              {images.map((img) => (
                <button
                  key={img.id}
                  type="button"
                  onClick={() => setSelected(img)}
                  title={img.prompt}
                  style={{
                    padding: 0,
                    border:
                      selected?.id === img.id
                        ? '1px solid var(--accent)'
                        : '1px solid var(--line)',
                    borderRadius: 6,
                    overflow: 'hidden',
                    background: 'var(--bg-2)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  <div style={{ position: 'relative' }}>
                    {/* A video tile shows its still. Without one there
                        is nothing to show — an inline <video> per tile
                        would fetch every render just to draw a grid. */}
                    <img
                      src={
                        img.kind === 'video'
                          ? `/media/${img.id}/thumb`
                          : `/media/${img.id}/file`
                      }
                      alt={img.prompt}
                      loading="lazy"
                      style={{
                        width: '100%',
                        aspectRatio: '1 / 1',
                        objectFit: 'cover',
                        display: 'block',
                        background: 'var(--bg-3)',
                      }}
                    />
                    {img.kind === 'video' && (
                      <span
                        style={{
                          position: 'absolute',
                          right: 5,
                          bottom: 5,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3,
                          padding: '1px 5px',
                          borderRadius: 3,
                          background: 'rgba(0,0,0,0.62)',
                          color: '#fff',
                          fontSize: 10,
                        }}
                      >
                        <Film size={10} />
                        {img.durationSec !== undefined ? `${img.durationSec.toFixed(1)}s` : 'video'}
                      </span>
                    )}
                  </div>
                  <span
                    style={{
                      padding: '6px 7px',
                      fontSize: 11,
                      color: 'var(--text-1)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {img.prompt}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {selected && (
          <div
            style={{
              flex: 'none',
              borderTop: '1px solid var(--line)',
              padding: 12,
              display: 'flex',
              gap: 12,
              maxHeight: 220,
              background: 'var(--bg-1)',
            }}
          >
            {/* Clicking opens the same FileView window an agent's link
                would — one viewer for images wherever the path came
                from, rather than a second half-built one in here. */}
            {selected.kind === 'video' ? (
              <video
                controls
                preload="metadata"
                poster={`/media/${selected.id}/thumb`}
                src={`/media/${selected.id}/file`}
                style={{
                  maxHeight: 196,
                  maxWidth: 320,
                  borderRadius: 4,
                  border: '1px solid var(--line)',
                  flex: 'none',
                  background: '#000',
                }}
              />
            ) : (
            <img
              src={`/media/${selected.id}/file`}
              alt={selected.prompt}
              onClick={() => openFileView?.(selected.path)}
              title={openFileView ? 'Open in the file viewer' : selected.path}
              style={{
                maxHeight: 196,
                maxWidth: 260,
                objectFit: 'contain',
                borderRadius: 4,
                border: '1px solid var(--line)',
                flex: 'none',
                cursor: openFileView ? 'zoom-in' : 'default',
              }}
            />
            )}
            <div style={{ minWidth: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <div style={{ color: 'var(--text-0)', lineHeight: 1.45 }}>{selected.prompt}</div>
              <div style={{ color: 'var(--text-2)', fontSize: 11 }}>
                {selected.modelId} · {specSummary(selected.specs)}
              </div>
              <div style={{ color: 'var(--text-2)', fontSize: 11 }}>
                {formatWhen(selected.createdAt)} · {formatBytes(selected.bytes)}
                {formatCost(selected.costUsd) ? ` · ${formatCost(selected.costUsd)}` : ''}
                {selected.agent ? ` · by ${selected.agent}` : ''}
              </div>
              <code
                style={{
                  fontSize: 10.5,
                  color: 'var(--text-2)',
                  wordBreak: 'break-all',
                  lineHeight: 1.4,
                }}
              >
                {selected.path}
              </code>
              {selected.linkedTo.length > 0 && (
                <code style={{ fontSize: 10.5, color: 'var(--text-3)', wordBreak: 'break-all' }}>
                  also at {selected.linkedTo.join(', ')}
                </code>
              )}
              <div style={{ display: 'flex', gap: 7, marginTop: 3, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => reuseSpecs(selected)} style={smallBtnStyle}>
                  Use these settings
                </button>
                <a
                  href={`/media/${selected.id}/file?download=1`}
                  download={selected.filename}
                  // An <a> drags by default, and a pixel of movement
                  // between mousedown and mouseup swallows the click —
                  // easy to hit inside a window you drag around.
                  draggable={false}
                  style={{ ...smallBtnStyle, textDecoration: 'none' }}
                  title="Save this image"
                >
                  <Download size={11} /> Download
                </a>
                <button
                  type="button"
                  onClick={() => void forget(selected.id)}
                  style={smallBtnStyle}
                  title="Removes it from the gallery. The file on disk stays."
                >
                  <Trash2 size={11} /> Remove from gallery
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 11,
  color: 'var(--text-2)',
};

const inputStyle: React.CSSProperties = {
  background: 'var(--bg-2)',
  border: '1px solid var(--line)',
  borderRadius: 5,
  color: 'var(--text-0)',
  padding: '6px 8px',
  fontSize: 12.5,
  outline: 'none',
};

const hintStyle: React.CSSProperties = {
  fontSize: 10.5,
  color: 'var(--text-3)',
  lineHeight: 1.4,
};

const smallBtnStyle: React.CSSProperties = {
  background: 'var(--bg-3)',
  border: '1px solid var(--line-2)',
  borderRadius: 5,
  color: 'var(--text-1)',
  padding: '4px 8px',
  fontSize: 11,
  cursor: 'pointer',
  // A button is inline-block by default, so an icon followed by a label
  // is just two inline items — and in a narrow panel the label wraps
  // under the icon. Laying the button out as a row keeps them side by
  // side and lets the button keep its natural width.
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 4,
  whiteSpace: 'nowrap',
};
