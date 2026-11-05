// The tools and memory switches in the chat header (docs/mobile.md
// "Tool activity", "Recalled notes"), the phone's counterpart of the
// web client's tools and memory buttons: per session, remembered on
// this device. Until it is touched, the tools switch starts on for a
// builder — its tool calls are all there is to see during a long build
// — and for a chat agent as `mobile.show.tools` in config.yaml says
// (off); the memory switch starts as `mobile.show.memory` says (off).

import { useCallback, useEffect, useState } from 'react';

type Which = 'tools' | 'memory';

export function toolSwitchKey(agent: string, session: string): string {
  return `somora.mobile.showTools.${agent}::${session}`;
}

export function memorySwitchKey(agent: string, session: string): string {
  return `somora.mobile.showMemory.${agent}::${session}`;
}

/** What the tools switch shows before the person touched it. */
export function defaultShowTools(kind: string | undefined, configShowTools: boolean): boolean {
  return kind === 'builder' ? true : configShowTools;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readStored(key: string): boolean | null {
  try {
    const v = storage()?.getItem(key);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}

// GET /mobile-config, read once per app start.
let configPromise: Promise<{ tools: boolean; memory: boolean }> | null = null;
function configShow(): Promise<{ tools: boolean; memory: boolean }> {
  configPromise ??= fetch('/mobile-config')
    .then((r) => (r.ok ? (r.json() as Promise<{ show?: { tools?: unknown; memory?: unknown } }>) : null))
    .then((d) => ({ tools: d?.show?.tools === true, memory: d?.show?.memory === true }))
    .catch(() => ({ tools: false, memory: false }));
  return configPromise;
}

function useShowSwitch(which: Which, agent: string | null, session: string, kind: string | undefined): [boolean, () => void] {
  const key = agent ? (which === 'tools' ? toolSwitchKey : memorySwitchKey)(agent, session) : '';
  const [cfg, setCfg] = useState(false);
  const [stored, setStored] = useState<boolean | null>(() => (key ? readStored(key) : null));

  useEffect(() => {
    let alive = true;
    void configShow().then((v) => {
      if (alive) setCfg(v[which]);
    });
    return () => {
      alive = false;
    };
  }, [which]);

  useEffect(() => {
    setStored(key ? readStored(key) : null);
  }, [key]);

  const on = stored ?? (which === 'tools' ? defaultShowTools(kind, cfg) : cfg);
  const toggle = useCallback(() => {
    if (!key) return;
    const next = !on;
    setStored(next);
    try {
      storage()?.setItem(key, next ? '1' : '0');
    } catch {
      /* private mode: the switch still works for this visit */
    }
  }, [key, on]);
  return [on, toggle];
}

export function useToolSwitch(agent: string | null, session: string, kind: string | undefined): [boolean, () => void] {
  return useShowSwitch('tools', agent, session, kind);
}

export function useMemorySwitch(agent: string | null, session: string): [boolean, () => void] {
  return useShowSwitch('memory', agent, session, undefined);
}
