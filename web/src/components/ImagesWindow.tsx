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
import { AlertTriangle, Image as ImageIcon, Loader2, Search, Trash2, Wand2 } from 'lucide-react';
import {
  api,
  type ImageCapabilities,
  type ImageModelOption,
  type ImageRecordDto,
  type ImagesStatus,
  type ImageSpecField,
} from '../lib/api';

/** Order shown in the form. Matches how people describe an image:
 *  shape first, then how big, then how good. */
const SPEC_FIELDS: Array<{ key: ImageSpecField; label: string; placeholder: string }> = [
  { key: 'aspect_ratio', label: 'Aspect ratio', placeholder: 'e.g. 16:9' },
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

export function ImagesWindow() {
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

  const [images, setImages] = useState<ImageRecordDto[]>([]);
  const [total, setTotal] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ImageRecordDto | null>(null);

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
      const res = await api.images({ ...(q ? { query: q } : {}), limit: 60 });
      setImages(res.images);
      setTotal(res.total);
      setTotalBytes(res.totalBytes);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload('');
  }, [reload]);

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

  const generate = useCallback(async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.generateImage({
        prompt: prompt.trim(),
        ...(model ? { model } : {}),
        ...specs,
        ...(count > 1 ? { n: count } : {}),
        ...(seed.trim() ? { seed: Number(seed.trim()) } : {}),
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
  }, [prompt, busy, model, specs, count, seed, saveTo]);

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

  if (status && !status.enabled) {
    return (
      <div style={{ padding: 20, fontSize: 13, color: 'var(--text-1)' }}>
        <AlertTriangle size={14} style={{ verticalAlign: -2 }} /> Image generation is not
        configured. Add an <code>imageGen</code> block with at least one model to config.yaml.
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
        <label style={labelStyle}>
          Model
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
        </label>

        <label style={labelStyle}>
          Prompt
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void generate();
            }}
            rows={4}
            placeholder="What should the image show?"
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.45 }}
          />
        </label>

        {SPEC_FIELDS.map(({ key, label, placeholder }) => {
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
                <input
                  value={specs[key] ?? ''}
                  onChange={(e) => setSpecs((s) => ({ ...s, [key]: e.target.value }))}
                  placeholder={placeholder}
                  style={inputStyle}
                />
              )}
            </label>
          );
        })}

        <div style={{ display: 'flex', gap: 8 }}>
          <label style={{ ...labelStyle, flex: 1 }}>
            Count
            <input
              type="number"
              min={1}
              max={maxN}
              value={count}
              onChange={(e) => setCount(Math.max(1, Math.min(maxN, Number(e.target.value) || 1)))}
              style={inputStyle}
            />
          </label>
          <label style={{ ...labelStyle, flex: 1 }}>
            Seed
            <input
              value={seed}
              onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="random"
              style={inputStyle}
            />
          </label>
        </div>

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
          onClick={() => void generate()}
          disabled={busy || !prompt.trim()}
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
              <Wand2 size={14} /> Generate
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
          <span style={{ color: 'var(--text-2)', fontSize: 11, flex: 'none' }}>
            {total} image{total === 1 ? '' : 's'} · {formatBytes(totalBytes)}
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
                  <img
                    src={`/images/${img.id}/file`}
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
            <img
              src={`/images/${selected.id}/file`}
              alt={selected.prompt}
              style={{
                maxHeight: 196,
                maxWidth: 260,
                objectFit: 'contain',
                borderRadius: 4,
                border: '1px solid var(--line)',
                flex: 'none',
              }}
            />
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
                <button
                  type="button"
                  onClick={() => void forget(selected.id)}
                  style={smallBtnStyle}
                  title="Removes it from the gallery. The file on disk stays."
                >
                  <Trash2 size={11} style={{ verticalAlign: -1 }} /> Remove from gallery
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
};
