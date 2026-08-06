// `${VAR}` / `${VAR:-default}` expansion for MCP config strings
// (claude-code idiom). Extracted so both the manager and the credential
// providers can use it without a circular import.

export class MissingEnvVarError extends Error {}

export function expandEnvString(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, def?: string) => {
    const v = env[name];
    if (v !== undefined && v !== '') return v;
    if (def !== undefined) return def;
    throw new MissingEnvVarError(`missing env var \${${name}}`);
  });
}
