// The bridge registers a changed tool again (naxon, 2026-09-26).
// Run: npx tsx src/mcp/hub/bridge.test.mts
import { bridgeMcpTools, toolFingerprint } from './bridge.ts';
import type { ToolDefinition } from '../../tools/types.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error('  FAIL', name, detail);
  }
};

const tools = new Map<string, Array<{ rawName: string; fullName: string; description: string; inputSchema: Record<string, unknown> }>>();
let listener: (() => void) | undefined;
const manager = {
  connectedTools: () => tools,
  addCatalogListener: (fn: () => void) => { listener = fn; },
  serverConfig: () => undefined,
  callTool: async () => ({ isError: false, text: '{}', images: [] }),
} as never;
const registered: ToolDefinition[] = [];
const registry = { register: (t: ToolDefinition) => { registered.push(t); } } as never;

tools.set('networth', [{ rawName: 'set_price', fullName: 'mcp__networth__set_price', description: 'Set a price', inputSchema: { type: 'object', properties: { p: { type: 'number' } } } }]);
bridgeMcpTools(manager, registry);
check('first refresh registers the tool', registered.length === 1 && registered[0]!.name === 'mcp__networth__set_price');
listener!();
check('an unchanged catalog registers nothing again', registered.length === 1);
tools.set('networth', [{ rawName: 'set_price', fullName: 'mcp__networth__set_price', description: 'Set a price (EUR)', inputSchema: { type: 'object', properties: { p: { type: 'number' } } } }]);
listener!();
check('a changed description registers the tool again', registered.length === 2 && registered[1]!.description === 'Set a price (EUR)', String(registered.length));
tools.set('networth', [{ rawName: 'set_price', fullName: 'mcp__networth__set_price', description: 'Set a price (EUR)', inputSchema: { type: 'object', properties: { p: { type: 'number' }, currency: { type: 'string' } } } }]);
listener!();
check('a changed schema registers the tool again', registered.length === 3 && JSON.stringify(registered[2]!.jsonSchema).includes('currency'));
listener!();
check('…and then stays quiet', registered.length === 3);
check('fingerprint covers description and schema', toolFingerprint({ description: 'a', inputSchema: {} }) !== toolFingerprint({ description: 'b', inputSchema: {} }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
