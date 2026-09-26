// Run: npx tsx src/mcp/tool-schema.test.mts
import { z } from 'zod';
import { mcpInputSchemaFor } from './tool-schema.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error('  FAIL', name, detail);
  }
};

const execLike = z.object({ command: z.string(), target: z.string().default('local') });
const s = mcpInputSchemaFor({ inputSchema: execLike as never, toolset: 'exec' });
const wrong = s.safeParse({ command: 'hostname', resource: 'cerebro' });
check('unknown key is refused, not stripped', !wrong.success, JSON.stringify(wrong));
check('the refusal names the key', !wrong.success && /resource/.test(JSON.stringify(wrong.error.issues)), !wrong.success ? JSON.stringify(wrong.error.issues) : '');
const right = s.safeParse({ command: 'hostname', target: 'cerebro' });
check('known keys pass with defaults applied', right.success && (right.data as { target: string }).target === 'cerebro');
const dflt = s.safeParse({ command: 'hostname' });
check('default still fills in', dflt.success && (dflt.data as { target: string }).target === 'local');
const already = mcpInputSchemaFor({ inputSchema: z.object({ a: z.string() }).strict() as never, toolset: 'file' });
check('already strict stays strict', !already.safeParse({ a: 'x', b: 1 }).success);
const bridged = mcpInputSchemaFor({ inputSchema: z.object({}).passthrough() as never, toolset: 'mcp' });
check('bridged hub tools keep passthrough', bridged.safeParse({ anything: 1 }).success);
const union = z.union([z.object({ op: z.literal('a') }), z.object({ op: z.literal('b'), n: z.number() })]);
check('non-object schemas are handed over unchanged', mcpInputSchemaFor({ inputSchema: union as never, toolset: 'exec' }) === union);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
