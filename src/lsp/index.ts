// The one LspManager of this server process, fed by the live config.
import type { Config } from '../config/types.ts';
import { LspManager } from './manager.ts';

let manager: LspManager | null = null;

export function getLspManager(config: () => Config): LspManager {
  if (!manager) {
    manager = new LspManager(() => {
      const c = config().lsp;
      return { enabled: c.enabled, waitMs: c.waitMs, servers: c.servers };
    });
    manager.startSweeper();
  }
  return manager;
}

export async function shutdownLsp(): Promise<void> {
  if (manager) await manager.shutdownAll();
  manager = null;
}
