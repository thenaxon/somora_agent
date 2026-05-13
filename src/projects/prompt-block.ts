// Renders a project as a compact Markdown block for injection into the
// system-prompt tail. Lives in the STABLE portion of the prompt (after
// skillsBlock, before per-turn ephemeralContext) so cache holds for
// every turn within the same session — only an explicit `/projekt`
// switch invalidates it, which is intentional.
//
// Design goals:
//   - kept short (target ≤ 800 tokens at typical 3–8 path counts)
//   - human-readable so the agent has no parsing burden
//   - scheme-tag (`[local]` / `[url]` / `[resource]`) per path so the
//     agent knows which tool family to use without further inference
//   - basename fallback for missing labels — raw paths read like noise
//     ("Setup.md" beats "~/Documents/somora-vault/Privat/Heimkino/Setup.md")
//
// What we DON'T include here:
//   - actual file contents (the agent uses its existing tools to read
//     on demand — see Variante A of the design discussion)
//   - paths to skills, memory, wiki — those go through their own injection
//   - timestamps beyond `expires` (clutter; agent rarely needs created/updated)

import { basename } from 'node:path';
import { inferPathType } from './scheme.ts';
import type { ProjectFrontmatter } from './types.ts';

/**
 * Render a project as the system-prompt project-block. Returns the
 * empty string if `project` is null/undefined so callers can do a
 * blanket `prompt + renderProjectBlock(p)` without conditional logic.
 */
export function renderProjectBlock(project: ProjectFrontmatter | null | undefined): string {
  if (!project) return '';

  const lines: string[] = [];
  // Section delimiter matches the existing `---` separators in
  // systemPromptForTurn (selfPointer + persona + skills).
  lines.push('\n\n---\n');
  lines.push(`## Active Project: ${project.name}`);
  lines.push('');
  lines.push(`**Entity:** ${project.entity}`);
  if (project.description) {
    lines.push(`**Description:** ${project.description}`);
  }
  if (project.tags.length > 0) {
    lines.push(`**Tags:** ${project.tags.join(', ')}`);
  }
  if (project.expires) {
    lines.push(`**Expires:** ${project.expires}`);
  }
  if (project.archived) {
    // Should be rare but possible — focused project was archived after
    // pin. Flag it so the agent knows the context is stale.
    lines.push(`**⚠ Archived:** ${project.archiveReason ?? '(no reason given)'}`);
  }

  if (project.paths.length > 0) {
    lines.push('');
    lines.push('**Pointers:**');
    for (const p of project.paths) {
      const inferred = inferPathType(p.ref);
      const typeTag = inferred ? inferred.type : 'unknown';
      const label = p.label ?? deriveLabel(p.ref, typeTag);
      lines.push(`- \`[${typeTag}]\` ${p.ref} — ${label}`);
    }
  } else {
    lines.push('');
    lines.push('*(no pointers configured yet)*');
  }

  lines.push('');
  lines.push(
    'When the user asks about this project, treat the pointers above as the canonical ' +
      'list of relevant resources. Use your standard tools (file_read for `[local]`, ' +
      'web_fetch / browser tools for `[url]`, resource tools for `[resource]`) to access ' +
      'them on demand — do not assume their contents from memory.',
  );

  return lines.join('\n');
}

/** Best-effort fallback label when `path.label` was omitted by the user.
 *  Returns the basename for local paths, the host for URLs, and the
 *  remote-path basename for resources. Plain `path` if nothing better
 *  can be derived. */
function deriveLabel(ref: string, type: string): string {
  try {
    if (type === 'url') {
      const u = new URL(ref);
      return u.hostname || ref;
    }
    if (type === 'local') {
      const b = basename(ref.replace(/\/$/, ''));
      return b || ref;
    }
    if (type === 'resource') {
      // resource refs are `<slug>:/path/...`. Take the remote basename.
      const m = ref.match(/^[a-z0-9_-]+:\/(.*)$/i);
      if (m && m[1]) {
        const b = basename(m[1].replace(/\/$/, ''));
        if (b) return b;
      }
    }
  } catch {
    /* fall through */
  }
  return ref;
}
