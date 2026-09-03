export function minimumNodeVersion(range: string | null | undefined): [number, number, number] | null;
export function satisfiesNode(range: string | null | undefined, current: string | null | undefined): boolean;
export function nodeUpgradeHint(range: string, current: string, execPath: string): string;
