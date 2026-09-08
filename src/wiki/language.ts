// Wiki language — the one place that knows what the wiki's scaffolding
// is called in German and in English.
//
// `wiki.language` in config.yaml picks the set. Everything that writes
// scaffolding text derives from here: the Deep prompt (section
// headings, page types, default subfolders, the language the page prose
// is written in), the Lucid prompt examples, index.md and the monthly
// log. Page bodies themselves are written by the worker model; the
// prompt tells it which language to use.
//
// Default is `de` — the wiki started German, and an installation that
// never set the key must keep producing pages that match its existing
// ones. Switching later only affects NEW scaffolding: Merge preserves
// the sections a page already has.

export type WikiLanguage = 'de' | 'en';
export const WIKI_LANGUAGES: readonly WikiLanguage[] = ['de', 'en'];

export interface WikiSections {
  currentState: string;
  properties: string;
  timeline: string;
  notes: string;
}

export interface WikiSchema {
  language: WikiLanguage;
  /** Name of the language as the prompt says it ("German"). */
  languageName: string;
  /** Preferred `## …` headings for new pages. */
  sections: WikiSections;
  /** Preferred `type:` frontmatter values. */
  types: readonly string[];
  /** Subfolders Deep uses by default (config `wiki.defaultSubdirs` overrides). */
  subdirs: readonly string[];
  /** Further subfolders the prompt names as examples of "invent one". */
  extraSubdirExamples: readonly string[];
  /** Example page paths for prompts and tool descriptions. */
  examples: { person: string; project: string; tool: string; relatedPerson: string; relatedProject: string };
  /** Month names for the log file title. */
  months: readonly string[];
  /** Fixed strings in generated files. */
  text: {
    indexTitle: string;
    /** "Last update: <ts> by <who>" */
    indexUpdated: (ts: string, by: string) => string;
    indexMisc: string;
    indexRecent: string;
    logTitle: string;
    /** Log line for a promotion. */
    promoted: (wikiPath: string, source: string) => string;
    /** Example for the model's one-line merge summary. */
    logSummaryExample: string;
  };
}

const DE: WikiSchema = {
  language: 'de',
  languageName: 'German',
  sections: { currentState: 'Aktueller Stand', properties: 'Eigenschaften', timeline: 'Zeitleiste', notes: 'Notizen' },
  types: ['person', 'projekt', 'konzept', 'ort', 'werkzeug'],
  subdirs: ['personen', 'projekte', 'wissen'],
  extraSubdirExamples: ['orte', 'infrastruktur'],
  examples: {
    person: 'personen/jane-doe',
    project: 'projekte/orbit',
    tool: 'infrastruktur/mac-studio',
    relatedPerson: 'personen/rene',
    relatedProject: 'projekte/familie-luca-podcast',
  },
  months: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
  text: {
    indexTitle: 'somora-Wiki Index',
    indexUpdated: (ts, by) => `Letztes Update: ${ts} von ${by}`,
    indexMisc: 'Sonstiges',
    indexRecent: 'Letzte Updates',
    logTitle: 'Wiki-Log',
    promoted: (wikiPath, source) => `${wikiPath} übernommen aus ${source}`,
    logSummaryExample: '"X aktualisiert: <was>"',
  },
};

const EN: WikiSchema = {
  language: 'en',
  languageName: 'English',
  sections: { currentState: 'Current state', properties: 'Properties', timeline: 'Timeline', notes: 'Notes' },
  types: ['person', 'project', 'concept', 'place', 'tool'],
  subdirs: ['people', 'projects', 'knowledge'],
  extraSubdirExamples: ['places', 'infrastructure'],
  examples: {
    person: 'people/jane-doe',
    project: 'projects/orbit',
    tool: 'infrastructure/mac-studio',
    relatedPerson: 'people/rene',
    relatedProject: 'projects/family-luca-podcast',
  },
  months: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  text: {
    indexTitle: 'somora wiki index',
    indexUpdated: (ts, by) => `Last update: ${ts} by ${by}`,
    indexMisc: 'Other',
    indexRecent: 'Recent updates',
    logTitle: 'Wiki log',
    promoted: (wikiPath, source) => `${wikiPath} promoted from ${source}`,
    logSummaryExample: '"X updated: <what>"',
  },
};

export function wikiSchemaFor(language: WikiLanguage): WikiSchema {
  return language === 'en' ? EN : DE;
}

/** Schema for a config block: language picks the set, an explicit
 *  `defaultSubdirs` replaces the default subfolders. */
export function resolveWikiSchema(cfg: { language?: WikiLanguage; defaultSubdirs?: readonly string[] | undefined }): WikiSchema {
  const base = wikiSchemaFor(cfg.language ?? 'de');
  if (!cfg.defaultSubdirs || cfg.defaultSubdirs.length === 0) return base;
  return { ...base, subdirs: [...cfg.defaultSubdirs] };
}

/** Section headings as a `"## A" / "## B"` list for prompts. */
export function sectionList(s: WikiSchema): string {
  return [s.sections.currentState, s.sections.properties, s.sections.timeline, s.sections.notes].map((h) => `"## ${h}"`).join(' / ');
}

/** Both languages' headings, for tool descriptions that are static. */
export function allSectionHeadings(): string {
  return WIKI_LANGUAGES.map((l) => {
    const s = wikiSchemaFor(l);
    return `${l}: ${sectionList(s)}`;
  }).join('; ');
}

export const DEFAULT_WIKI_SCHEMA: WikiSchema = DE;
