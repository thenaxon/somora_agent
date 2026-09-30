// Plain line-based questions for the setup assistant. No TUI framework:
// it has to work over ssh, inside `curl … | bash` (stdin re-attached to
// /dev/tty) and with answers piped in from a script.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const tty = process.stdout.isTTY === true;
const c = (code: string) => (s: string): string => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const bold = c('1');
export const dim = c('2');
export const green = c('32');
export const yellow = c('33');
export const red = c('31');
export const cyan = c('36');

export function say(text = ''): void {
  process.stdout.write(`${text}\n`);
}
export function ok(text: string): void {
  say(`  ${green('✓')} ${text}`);
}
export function warn(text: string): void {
  say(`  ${yellow('!')} ${text}`);
}
export function fail(text: string): void {
  say(`  ${red('✗')} ${text}`);
}
export function heading(title: string): void {
  say();
  say(bold(`── ${title} ${'─'.repeat(Math.max(3, 66 - title.length))}`));
}
/** Indented explanatory paragraph. The common indentation of the
 *  source lines is removed, deeper indentation (lists) is kept. */
export function explain(text: string): void {
  const lines = text.replace(/^\n+|\s+$/g, '').split('\n');
  const indents = lines.slice(1).filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  lines.forEach((l, i) => say(`  ${dim(i === 0 ? l.trim() : l.slice(Math.min(cut, l.match(/^ */)![0].length)))}`));
}

export interface Choice<T> {
  label: string;
  value: T;
  hint?: string;
}

export class Prompter {
  /** Piped stdin is read once, up front — a readline interface that is
   *  closed between questions would throw away buffered lines. */
  private scripted: string[] | null = null;

  constructor() {
    if (process.stdin.isTTY !== true) {
      let text = '';
      try {
        text = readFileSync(0, 'utf8');
      } catch {
        /* no stdin at all */
      }
      this.scripted = text.split('\n');
      if (this.scripted.at(-1) === '') this.scripted.pop();
    }
  }

  get interactive(): boolean {
    return this.scripted === null;
  }

  private line(promptText: string): Promise<string> {
    if (this.scripted) {
      const answer = this.scripted.shift() ?? '';
      process.stdout.write(`${promptText}${answer}\n`);
      return Promise.resolve(answer);
    }
    return new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let answered = false;
      rl.question(promptText, (a) => {
        answered = true;
        rl.close();
        resolve(a);
      });
      // Ctrl-C stops the assistant. Without this listener readline just
      // closes, which would read as "take the default" and carry on.
      rl.on('SIGINT', () => {
        answered = true;
        rl.close();
        process.stdout.write('\n\n  stopped — nothing further was changed. Run `somora setup` again to continue.\n');
        process.exit(130);
      });
      // Ctrl-D: take the default instead of hanging.
      rl.on('close', () => { if (!answered) resolve(''); });
    });
  }

  async ask(question: string, def?: string): Promise<string> {
    const suffix = def !== undefined && def !== '' ? ` ${dim(`[${def}]`)}` : '';
    const a = (await this.line(`  ${question}${suffix}: `)).trim();
    return a === '' ? (def ?? '') : a;
  }

  /** Ask until `check` returns null (= fine) — it returns the complaint otherwise. */
  async askValid(question: string, def: string | undefined, check: (v: string) => string | null): Promise<string> {
    for (let i = 0; ; i++) {
      const v = await this.ask(question, def);
      const problem = check(v);
      if (problem === null) return v;
      warn(problem);
      if (!this.interactive && i >= 2) throw new Error(`no valid answer for: ${question}`);
    }
  }

  async confirm(question: string, def = true): Promise<boolean> {
    const a = (await this.line(`  ${question} ${dim(def ? '[Y/n]' : '[y/N]')} `)).trim().toLowerCase();
    if (a === '') return def;
    return ['y', 'yes', 'j', 'ja'].includes(a);
  }

  async choose<T>(question: string, choices: Array<Choice<T>>, defIndex = 0): Promise<T> {
    say(`  ${question}`);
    choices.forEach((ch, i) => say(`    ${cyan(String(i + 1))}. ${ch.label}${ch.hint ? dim(`  — ${ch.hint}`) : ''}`));
    const v = await this.askValid('Choose', String(defIndex + 1), (s) => {
      const n = Number(s);
      return Number.isInteger(n) && n >= 1 && n <= choices.length ? null : `a number from 1 to ${choices.length}, please`;
    });
    return choices[Number(v) - 1]!.value;
  }

  /** Several of a list: "1,3", "all" or "none". */
  async chooseMany<T>(question: string, choices: Array<Choice<T>>, defIndexes: number[]): Promise<T[]> {
    say(`  ${question}`);
    choices.forEach((ch, i) => say(`    ${cyan(String(i + 1))}. ${ch.label}${ch.hint ? dim(`  — ${ch.hint}`) : ''}`));
    const def = defIndexes.length ? defIndexes.map((i) => i + 1).join(',') : 'none';
    const parse = (s: string): number[] | null => {
      const t = s.trim().toLowerCase();
      if (t === 'none' || t === '-') return [];
      if (t === 'all') return choices.map((_, i) => i);
      const nums = t.split(/[\s,]+/).filter(Boolean).map(Number);
      if (nums.length === 0 || nums.some((n) => !Number.isInteger(n) || n < 1 || n > choices.length)) return null;
      return [...new Set(nums.map((n) => n - 1))];
    };
    const v = await this.askValid('Choose (e.g. 1,3 — or all / none)', def, (s) => (parse(s) ? null : `numbers from 1 to ${choices.length}, separated by commas`));
    return parse(v)!.map((i) => choices[i]!.value);
  }

  async pause(text = 'Press Enter to continue'): Promise<void> {
    await this.line(`  ${dim(text)} `);
  }

  /** Give the terminal to another program (a login flow, sudo, …). */
  handOver(cmd: string, args: string[], env?: NodeJS.ProcessEnv): number {
    const r = spawnSync(cmd, args, { stdio: 'inherit', env: env ?? process.env });
    if (r.error) {
      fail(`could not run ${cmd}: ${r.error.message}`);
      return 127;
    }
    return r.status ?? 1;
  }
}

/** Run quietly, capture output. */
export function capture(cmd: string, args: string[], timeoutMs = 30_000): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: timeoutMs });
  return { code: r.error ? 127 : (r.status ?? 1), stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? '') };
}

export function onPath(cmd: string): boolean {
  return capture('sh', ['-c', `command -v ${cmd}`]).code === 0;
}
