export function minimumNodeVersion(range: string | null | undefined): [number, number, number] | null;
export function satisfiesNode(range: string | null | undefined, current: string | null | undefined): boolean;
export function nodeUpgradeHint(range: string, current: string, execPath: string): string;
export function glibcVersion(): string | null;
export function satisfiesGlibc(min: string | null | undefined, current: string | null | undefined): boolean;
export function glibcUpgradeHint(min: string, current: string, fallbackVersion?: string | null): string;
