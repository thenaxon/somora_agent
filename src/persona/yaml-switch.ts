// Set one root true/false switch of an agent.yaml (`a2a:`, `dreams:`)
// without touching the rest: the value of the root key is replaced in
// place, however the key is written (`a2a:`, `"a2a":`, `a2a :`), or the
// line is added. Comments and order stay. A file that is not valid YAML,
// or a result that would not read back as the switch, throws and nothing
// is written: a broken agent.yaml loads as no settings at all.

import { isMap, isScalar, parseDocument } from 'yaml';
import { parseYaml } from '../config/yaml.ts';

export function setRootSwitchInText(text: string, key: string, on: boolean): string {
  let next: string;
  const blank = text.split(/\r?\n/).every((line) => /^\s*(#.*)?$/.test(line));
  if (blank) {
    const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    next = `${text}${sep}${key}: ${on}\n`;
  } else {
    const doc = parseDocument(text);
    if (doc.errors.length > 0) throw new Error(`agent.yaml is not valid YAML: ${doc.errors[0]!.message}`);
    if (!isMap(doc.contents)) throw new Error('agent.yaml is not a map of settings');
    const pair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === key);
    if (pair) {
      const value = pair.value;
      if (!isScalar(value) || !value.range) throw new Error(`agent.yaml: ${key} is not a plain true/false`);
      next = text.slice(0, value.range[0]) + String(on) + text.slice(value.range[1]);
    } else {
      const sep = text.endsWith('\n') ? '' : '\n';
      next = `${text}${sep}${key}: ${on}\n`;
    }
  }
  let back: unknown;
  try {
    back = parseYaml(next);
  } catch (err) {
    throw new Error(`agent.yaml would not be valid YAML with the switch: ${(err as Error).message}`);
  }
  if ((back as Record<string, unknown> | undefined)?.[key] !== on) throw new Error(`agent.yaml would not read back with ${key} set; edit it by hand`);
  return next;
}
