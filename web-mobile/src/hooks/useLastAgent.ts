// Persist the last-selected agent name in localStorage so opening the
// PWA from the home screen lands the user back in the conversation
// they were last reading.

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'somora.mobile.lastAgent';

export function useLastAgent(): [string | null, (name: string) => void] {
  const [lastAgent, setState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (lastAgent === null) return;
    try {
      localStorage.setItem(STORAGE_KEY, lastAgent);
    } catch {
      /* localStorage quota / disabled — silently noop */
    }
  }, [lastAgent]);

  return [lastAgent, setState];
}
