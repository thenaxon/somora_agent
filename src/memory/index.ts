// Memory module — public surface.
//
// Architecture (DECISIONS #25–#28):
//   - Markdown on disk = source-of-truth (memory/notes/<slug>.md)
//   - SQLite + sqlite-vec as derived index (memory.db)
//   - Local embeddings (default: all-MiniLM-L6-v2 via @huggingface/transformers)
//   - Hybrid retrieval: vector cosine + FTS5 BM25, weighted fusion
//   - File-watcher re-indexes on change with debounce
//   - Optional Obsidian vault as read-only source
//
// One MemoryManager per agent. Server constructs and caches.

export { MemoryManager } from './manager.ts';
export type { ManagerOptions, NoteSummary, ObsidianSource } from './manager.ts';
export type { Hit } from './retrieval.ts';
