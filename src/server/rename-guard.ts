// Mid-rename an agent's folder moves and its files are rewritten
// (persona/rename.ts): no change to that agent goes through meanwhile —
// persona files, switches, sessions. Reading stays open.

import type { MiddlewareHandler } from 'hono';
import { AgentRenamingError, isRenaming } from '../persona/rename-lock.ts';

export const renameGuard: MiddlewareHandler = async (c, next) => {
  const agent = c.req.param('agent');
  const m = c.req.method;
  if (agent && m !== 'GET' && m !== 'HEAD' && isRenaming(agent)) {
    return c.json({ error: new AgentRenamingError(agent).message }, 409);
  }
  await next();
};
