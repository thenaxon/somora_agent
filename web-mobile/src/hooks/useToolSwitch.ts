// The tool switch in the chat header (docs/mobile.md "Tool activity"),
// the phone's counterpart of the web client's tools button: per session,
// remembered on this device. Until it is touched, a builder starts with
// it on — its tool calls are all there is to see during a long build —
// and a chat agent with `mobile.show.tools` from config.yaml (off).

import { useCallback, useEffect, useState } from 'react';

export function toolSwitchKey(agent: string, session: string): string {
  return `somora.mobile.showTools.${agent}::${session}`;
}

/** What the switch shows before the person touched it. */
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
let configPromise: Promise<boolean> | null = null;
function configShowTools(): Promise<boolean> {
  configPromise ??= fetch('/mobile-config')
    .then((r) => (r.ok ? (r.json() as Promise<{ show?: { tools?: unknown } }>) : null))
    .then((d) => d?.show?.tools === true)
    .catch(() => false);
  return configPromise;
}

export function useToolSwitch(agent: string | null, session: string, kind: string | undefined): [boolean, () => void] {
  const key = agent ? toolSwitchKey(agent, session) : '';
  const [cfg, setCfg] = useState(false);
  const [stored, setStored] = useState<boolean | null>(() => (key ? readStored(key) : null));

  useEffect(() => {
    let alive = true;
    void configShowTools().then((v) => {
      if (alive) setCfg(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setStored(key ? readStored(key) : null);
  }, [key]);

  const on = stored ?? defaultShowTools(kind, cfg);
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
