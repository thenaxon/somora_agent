// Run: npx tsx src/mcp/tool-schema.test.mts
import { z } from 'zod';
import { unknownInputKeys } from './tool-schema.ts';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) pass++;
  else {
    fail++;
    console.error('  FAIL', name, detail);
  }
};

const execLike = { inputSchema: z.object({ command: z.string(), target: z.string().default('local') }) as never, toolset: 'exec' as const };
check('unknown key is named, not stripped', JSON.stringify(unknownInputKeys(execLike, { command: 'hostname', resource: 'gpu-box' })) === '["resource"]');
check('known keys pass', unknownInputKeys(execLike, { command: 'hostname', target: 'gpu-box' }).length === 0);
check('a non-strict schema is checked too', unknownInputKeys({ inputSchema: z.object({ a: z.string() }) as never, toolset: 'memory' }, { a: 'x', b: 1 }).join() === 'b');
check('bridged hub tools take anything', unknownInputKeys({ inputSchema: z.object({}).passthrough() as never, toolset: 'mcp' }, { anything: 1 }).length === 0);
const union = z.union([z.object({ op: z.literal('a') }), z.object({ op: z.literal('b'), n: z.number() })]);
check('non-object schemas are left to the registry', unknownInputKeys({ inputSchema: union as never, toolset: 'exec' }, { op: 'a', x: 1 }).length === 0);
check('non-object input is left to the registry', unknownInputKeys(execLike, 'text').length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
