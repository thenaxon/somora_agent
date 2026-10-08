// The one way somora reads its YAML files (config.yaml, agent.yaml,
// team.yaml, …) with js-yaml.
//
// js-yaml 5 changed two defaults that would have changed what a person's
// files mean without a word: `<<: *anchor` merge keys stopped merging
// (the new default schema has no merge tag), and an empty file throws
// instead of reading as nothing. Both keep their js-yaml 4 behaviour
// here. Booleans stay YAML 1.2 core (`off`, `yes` remain text — a
// thinking level `off` must not become `false`); an unquoted date stays
// text as well.

import { CORE_SCHEMA, load, mergeTag } from 'js-yaml';

const SCHEMA = CORE_SCHEMA.withTags(mergeTag);

/** Parse YAML; a blank or comments-only file reads as `undefined`, like
 *  js-yaml 4 (5 throws "the input is empty" for both). */
export function parseYaml(text: string): unknown {
  if (text.split(/\r?\n/).every((line) => /^\s*(#.*)?$/.test(line))) return undefined;
  return load(text, { schema: SCHEMA });
}
