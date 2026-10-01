// The shipped wiki folder template — one per wiki language.
//
// Why (the operator, 2026-09-29): Deep used to be told "pick personen / projekte
// / wissen … or invent a new folder", saw the first 4 KB of index.md as
// its only map, and after five months a wiki had 40+ folders, a
// 300-page `wissen` catch-all, 15 page names living in several folders
// at once. The rule now, borrowed from well-kept Obsidian vaults: a
// folder says what KIND of page lives in it, never what a page is
// about — topics live in links and in index.md. The template below is
// the starting order every installation gets; a wiki's real folders
// win over it (src/wiki/map.ts), and the template only proposes where a
// new page of a kind should go. Adding a language = adding an entry
// here and in language.ts; nothing else knows the language.
//
// Purposes and rationales are written in the wiki's language: they are
// shown to the model as the meaning of a folder and to people in the
// structure file (src/wiki/structure-file.ts).

import type { WikiLanguage } from './language.ts';

export interface TaxonomySubfolder {
  path: string;
  purpose: string;
}

export interface TaxonomyFolder {
  path: string;
  /** One sentence: what kind of page lives here. */
  purpose: string;
  /** Why the order is this way — the part that lets the model place a
   *  kind the template did not foresee. */
  rationale: string;
  subfolders?: readonly TaxonomySubfolder[];
}

export interface WikiTaxonomy {
  language: WikiLanguage;
  /** Bumped when the template changes in a way a migration should notice. */
  version: number;
  folders: readonly TaxonomyFolder[];
  /** Folder names grown wikis commonly have, and the template folder
   *  their pages belong in — the migration's rule-based moves. Anything
   *  not listed here is judged page by page. */
  aliases: Readonly<Record<string, string>>;
}

const DE: WikiTaxonomy = {
  language: 'de',
  version: 1,
  folders: [
    { path: 'personen', purpose: 'Menschen: Familie, Freunde, Geschäftskontakte — eine Seite pro Mensch.', rationale: 'Ein Mensch ist eine Entität mit vielen Themen; die Themen verweisen auf ihn, nicht umgekehrt.' },
    { path: 'unternehmen', purpose: 'Firmen, Beteiligungen, Kanzleien, Lieferanten — eine Seite pro Firma.', rationale: 'Wie Personen: eine Firma ist eine Adresse für alles, was sie betrifft.' },
    { path: 'projekte', purpose: 'Abgegrenzte Vorhaben mit Anfang und Ziel — Software, Bau, Deal, Umzug; eine Seite pro Vorhaben, datierte Arbeitsberichte sind Einträge in deren Zeitleiste, keine eigenen Seiten.', rationale: 'Ein Projekt sammelt seinen Verlauf an einem Ort; verstreute Berichtsseiten werden nie wieder gefunden.' },
    { path: 'infrastruktur', purpose: 'Geräte, Rechner, laufende Dienste, Netzwerk, Zugänge bei Anbietern.', rationale: 'Technik, die betrieben wird, unabhängig vom Projekt, das sie nutzt.', subfolders: [
      { path: 'infrastruktur/geraete', purpose: 'Physische Geräte: Rechner, Server, Netzwerkhardware, Peripherie.' },
      { path: 'infrastruktur/hosts', purpose: 'Betriebene Rechner und VMs als Betriebseinheit: was darauf läuft, wie man hinkommt.' },
      { path: 'infrastruktur/dienste', purpose: 'Laufende Dienste und Anwendungen: Adresse, Zweck, Betrieb.' },
      { path: 'infrastruktur/konten', purpose: 'Zugänge und Konten bei Anbietern (APIs, Cloud, Abos) — ohne Geheimnisse.' },
    ] },
    { path: 'finanzen', purpose: 'Konten, Depot, Aktien, Krypto, Immobilien als Anlage, Kredite, Bewertungen.', rationale: 'Geldpositionen haben eigene Sorten; ein Ordner je Sorte hält sie nebeneinander.', subfolders: [
      { path: 'finanzen/konten', purpose: 'Bank- und Zahlungskonten.' },
      { path: 'finanzen/depot', purpose: 'Wertpapiere, Aktien, Fonds, Beobachtungslisten.' },
      { path: 'finanzen/krypto', purpose: 'Kryptowährungen und Wallets.' },
      { path: 'finanzen/immobilien', purpose: 'Immobilien als Anlage: Objekt, Erträge, Bewertung.' },
      { path: 'finanzen/kredite', purpose: 'Darlehen, Kredite, Leasing.' },
    ] },
    { path: 'besitz', purpose: 'Dinge, die einem gehören und keine Anlage sind: Autos, Ausstattung, Wohnung als Zuhause.', rationale: 'Besitz wird gepflegt, nicht bewertet — anders als eine Anlage.' },
    { path: 'orte', purpose: 'Häuser, Standorte, Städte, Reiseziele.', rationale: 'Ein Ort ist eine Adresse für Ereignisse und Dinge, die dort sind.' },
    { path: 'ereignisse', purpose: 'Vorfälle, Termine, Chronik — was wann passiert ist.', rationale: 'Ereignisse sind datiert und abgeschlossen; sie gehören zusammen, nicht unter das Thema.' },
    { path: 'wissen', purpose: 'Sachwissen ohne Bezug auf eine konkrete Person oder Firma: Konzepte, Anleitungen, Vergleiche, Werkzeuge — nur echtes Wissen, kein Sammelbecken.', rationale: 'Wissen ist wiederverwendbar; alles mit Bezug auf eine Entität gehört zu der Entität.', subfolders: [
      { path: 'wissen/konzepte', purpose: 'Was etwas ist und wie es funktioniert.' },
      { path: 'wissen/anleitungen', purpose: 'Wie man etwas macht, Schritt für Schritt.' },
      { path: 'wissen/vergleiche', purpose: 'X gegen Y: Bewertungen und Entscheidungsgrundlagen.' },
    ] },
    { path: 'regeln', purpose: 'Vorgaben, Präferenzen, Vereinbarungen, rechtliche Rahmen — was Agenten beachten sollen.', rationale: 'Regeln gelten quer über alle Themen; als eigene Art sind sie auffindbar und prüfbar.' },
    { path: 'agenten', purpose: 'Nur Steckbriefe: was ein Agent ist, kann und darf. Keine Arbeitsberichte.', rationale: 'Ein Agent ist eine Entität; seine Arbeit gehört zu den Projekten, an denen er arbeitet.' },
    { path: 'privat', purpose: 'Interessen, Hobbys, Haustiere, Gesundheit, Wohnen — das Leben abseits von Arbeit und Geld.', rationale: 'Persönliches braucht einen eigenen Ort, damit es weder unter Wissen noch unter Projekte rutscht.' },
  ],
  aliases: {
    hardware: 'infrastruktur/geraete', geraete: 'infrastruktur/geraete', hosts: 'infrastruktur/hosts', server: 'infrastruktur/hosts', homelab: 'infrastruktur', netzwerk: 'infrastruktur', dienste: 'infrastruktur/dienste', konten: 'infrastruktur/konten', zugaenge: 'infrastruktur/konten',
    aktien: 'finanzen/depot', depot: 'finanzen/depot', portfolio: 'finanzen/depot', watchlist: 'finanzen/depot', investments: 'finanzen/depot', investment: 'finanzen/depot', krypto: 'finanzen/krypto', immobilien: 'finanzen/immobilien', kredite: 'finanzen/kredite',
    haustiere: 'privat', tiere: 'privat', interessen: 'privat', hobbys: 'privat', wohnen: 'privat', gesundheit: 'privat',
    reisen: 'ereignisse', vorfaelle: 'ereignisse', vorfall: 'ereignisse', sicherheit: 'ereignisse', termine: 'ereignisse',
    praeferenzen: 'regeln', vorgaben: 'regeln', rechtliches: 'regeln', recht: 'regeln', vereinbarungen: 'regeln',
    konzepte: 'wissen/konzepte', anleitungen: 'wissen/anleitungen', runbooks: 'wissen/anleitungen', howto: 'wissen/anleitungen', skills: 'wissen/anleitungen', vergleiche: 'wissen/vergleiche', werkzeuge: 'wissen', tools: 'wissen',
    firmen: 'unternehmen', kontakte: 'personen', leute: 'personen', menschen: 'personen', standorte: 'orte', fahrzeuge: 'besitz', autos: 'besitz',
  },
};

const EN: WikiTaxonomy = {
  language: 'en',
  version: 1,
  folders: [
    { path: 'people', purpose: 'Humans: family, friends, business contacts — one page per person.', rationale: 'A person is an entity with many topics; the topics point at the person, not the other way round.' },
    { path: 'companies', purpose: 'Companies, holdings, firms, suppliers — one page per company.', rationale: 'Like people: a company is one address for everything that concerns it.' },
    { path: 'projects', purpose: 'Bounded undertakings with a start and a goal — software, construction, a deal, a move; one page per undertaking, dated work reports are timeline entries on that page, not pages of their own.', rationale: 'A project collects its history in one place; scattered report pages are never found again.' },
    { path: 'infrastructure', purpose: 'Devices, machines, running services, network, accounts with providers.', rationale: 'Technology that is operated, independent of the project that uses it.', subfolders: [
      { path: 'infrastructure/devices', purpose: 'Physical devices: computers, servers, network hardware, peripherals.' },
      { path: 'infrastructure/hosts', purpose: 'Operated machines and VMs as units: what runs there, how to reach them.' },
      { path: 'infrastructure/services', purpose: 'Running services and applications: address, purpose, operation.' },
      { path: 'infrastructure/accounts', purpose: 'Access and accounts with providers (APIs, cloud, subscriptions) — never secrets.' },
    ] },
    { path: 'finances', purpose: 'Accounts, portfolio, stocks, crypto, real estate as investment, loans, valuations.', rationale: 'Money positions come in kinds; one folder per kind keeps them side by side.', subfolders: [
      { path: 'finances/accounts', purpose: 'Bank and payment accounts.' },
      { path: 'finances/portfolio', purpose: 'Securities, stocks, funds, watchlists.' },
      { path: 'finances/crypto', purpose: 'Cryptocurrencies and wallets.' },
      { path: 'finances/real-estate', purpose: 'Real estate as investment: property, yields, valuation.' },
      { path: 'finances/loans', purpose: 'Loans, credit, leasing.' },
    ] },
    { path: 'possessions', purpose: 'Things one owns that are not investments: cars, equipment, the home as a home.', rationale: 'Possessions are maintained, not valued — unlike an investment.' },
    { path: 'places', purpose: 'Houses, sites, cities, travel destinations.', rationale: 'A place is an address for events and things that are there.' },
    { path: 'events', purpose: 'Incidents, appointments, chronicle — what happened when.', rationale: 'Events are dated and closed; they belong together, not under the topic.' },
    { path: 'knowledge', purpose: 'Subject knowledge with no tie to a specific person or company: concepts, how-tos, comparisons, tools — real knowledge only, not a catch-all.', rationale: 'Knowledge is reusable; anything tied to an entity belongs with that entity.', subfolders: [
      { path: 'knowledge/concepts', purpose: 'What something is and how it works.' },
      { path: 'knowledge/how-tos', purpose: 'How to do something, step by step.' },
      { path: 'knowledge/comparisons', purpose: 'X versus Y: evaluations and decision bases.' },
    ] },
    { path: 'rules', purpose: 'Directives, preferences, agreements, legal frames — what agents must respect.', rationale: 'Rules cut across all topics; as a kind of their own they can be found and checked.' },
    { path: 'agents', purpose: 'Profiles only: what an agent is, can and may do. No work reports.', rationale: 'An agent is an entity; its work belongs to the projects it works on.' },
    { path: 'personal', purpose: 'Interests, hobbies, pets, health, living — life apart from work and money.', rationale: 'Personal matters need a place of their own so they slide neither under knowledge nor under projects.' },
  ],
  aliases: {
    hardware: 'infrastructure/devices', devices: 'infrastructure/devices', hosts: 'infrastructure/hosts', servers: 'infrastructure/hosts', homelab: 'infrastructure', network: 'infrastructure', services: 'infrastructure/services', accounts: 'infrastructure/accounts',
    stocks: 'finances/portfolio', portfolio: 'finances/portfolio', watchlist: 'finances/portfolio', investments: 'finances/portfolio', crypto: 'finances/crypto', 'real-estate': 'finances/real-estate', property: 'finances/real-estate', loans: 'finances/loans',
    pets: 'personal', interests: 'personal', hobbies: 'personal', living: 'personal', health: 'personal',
    travel: 'events', trips: 'events', incidents: 'events', security: 'events', appointments: 'events',
    preferences: 'rules', legal: 'rules', agreements: 'rules',
    concepts: 'knowledge/concepts', 'how-tos': 'knowledge/how-tos', howto: 'knowledge/how-tos', runbooks: 'knowledge/how-tos', skills: 'knowledge/how-tos', comparisons: 'knowledge/comparisons', tools: 'knowledge',
    firms: 'companies', contacts: 'people', locations: 'places', vehicles: 'possessions', cars: 'possessions',
  },
};

export function taxonomyFor(language: WikiLanguage): WikiTaxonomy {
  return language === 'en' ? EN : DE;
}

/** Every folder path the template names, subfolders included. */
export function taxonomyPaths(t: WikiTaxonomy): string[] {
  return t.folders.flatMap((f) => [f.path, ...(f.subfolders ?? []).map((s) => s.path)]);
}
