// resource_list / resource_test — surface configured remote resources
// to the agent and let it probe whether one is reachable. The actual
// file_* / exec target dispatch lives elsewhere; these tools just
// answer "what targets are available?" and "is this one alive?".

import { z } from 'zod';
import { logger } from '../../server/logger.ts';
import { getConnection, remoteExec } from '../../ssh/index.ts';
import type { ToolDefinition } from '../types.ts';
import { resolveVisibleResource, visibleResourcesForAgent } from './visibility.ts';

// ─────────────────────────────────────────────────────────────────────
// resource_list
// ─────────────────────────────────────────────────────────────────────

const ListInput = z.object({}).strict();

interface ListedResource {
  name: string;
  type: string;
  host: string;
  user: string;
  description: string | null;
  workspace: string | null;
}

export const resourceList: ToolDefinition<z.infer<typeof ListInput>> = {
  name: 'resource_list',
  toolset: 'memory', // grouped with discovery-style tools
  description:
    'List remote resources (named SSH targets) available to this agent. Each entry has a ' +
    '`name` to use as the `target` parameter in file_* / exec tools. Resources are configured ' +
    'in the global config.yaml under `resources:`; per-agent visibility filters in agent.yaml ' +
    '`resources.deny` hide individual entries. Use `resource_test` to verify reachability ' +
    'before running commands.',
  inputSchema: ListInput,
  jsonSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_input, ctx): Promise<{ count: number; resources: ListedResource[] }> {
    const visible = await visibleResourcesForAgent(ctx.agent, ctx.config);
    const resources: ListedResource[] = visible.map(({ name, resource }) => ({
      name,
      type: resource.type,
      host: resource.host,
      user: resource.user,
      description: resource.description ?? null,
      workspace: resource.workspace ?? null,
    }));
    return { count: resources.length, resources };
  },
};

// ─────────────────────────────────────────────────────────────────────
// resource_test
// ─────────────────────────────────────────────────────────────────────

const TestInput = z
  .object({
    name: z.string().min(1).describe('Resource name from `resource_list`.'),
  })
  .strict();

interface TestOutput {
  ok: boolean;
  resource: string;
  host: string;
  uptime?: string;
  whoami?: string;
  hostnameRemote?: string;
  uname?: string;
  ms: number;
  error?: string;
}

export const resourceTest: ToolDefinition<z.infer<typeof TestInput>> = {
  name: 'resource_test',
  toolset: 'memory',
  description:
    'Probe a remote resource for reachability. Connects (cached if previously open), runs a ' +
    'tiny diagnostic command (`whoami; hostname; uname -srm; uptime -p`), and returns the ' +
    'output. Use before running file_* / exec tools against an unfamiliar target — surfaces ' +
    'auth/network errors with a clear message instead of letting the actual workload tool fail.',
  inputSchema: TestInput,
  jsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Resource name from resource_list.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  async handler(input, ctx): Promise<TestOutput> {
    const start = Date.now();
    const resource = await resolveVisibleResource(ctx.agent, ctx.config, input.name);
    if (!resource) {
      return {
        ok: false,
        resource: input.name,
        host: '?',
        ms: Date.now() - start,
        error: `resource '${input.name}' not configured or denied for this agent`,
      };
    }
    if (resource.type !== 'ssh') {
      return {
        ok: false,
        resource: input.name,
        host: resource.host,
        ms: Date.now() - start,
        error: `resource type '${resource.type}' not supported yet`,
      };
    }
    try {
      const client = await getConnection(input.name, resource);
      const result = await remoteExec(
        client,
        // POSIX-portable. uptime -p is GNU-specific; we ignore non-zero
        // for the uptime line since some BSDs don't have -p.
        'whoami && hostname && uname -srm && (uptime -p 2>/dev/null || uptime)',
        { timeoutMs: 10_000 },
      );
      const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      logger.info({
        msg: 'tool.resource_test',
        agent: ctx.agent,
        resource: input.name,
        host: resource.host,
        code: result.code,
        ms: Date.now() - start,
      });
      return {
        ok: result.code === 0,
        resource: input.name,
        host: resource.host,
        whoami: lines[0],
        hostnameRemote: lines[1],
        uname: lines[2],
        uptime: lines.slice(3).join(' '),
        ms: Date.now() - start,
        ...(result.code === 0
          ? {}
          : {
              error: `probe exited ${result.code}: ${result.stderr.slice(0, 300).trim() || '(no stderr)'}`,
            }),
      };
    } catch (err) {
      return {
        ok: false,
        resource: input.name,
        host: resource.host,
        ms: Date.now() - start,
        error: (err as Error).message,
      };
    }
  },
};

export function resourceTools(): ToolDefinition[] {
  return [resourceList, resourceTest] as ToolDefinition[];
}
