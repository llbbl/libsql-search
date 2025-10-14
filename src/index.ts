/**
 * libsql-search - Semantic search for static sites using libSQL/Turso
 *
 * @module libsql-search
 */

// Export embedding utilities
export {
  generateEmbedding,
  padEmbedding,
  prepareTextForEmbedding,
  type EmbeddingProvider,
  type EmbeddingOptions
} from './embeddings.js';

// Export indexing utilities
export {
  indexContent,
  createTable,
  type IndexerOptions,
  type IndexedDocument
} from './indexer.js';

// Export search utilities
export {
  search,
  getAllArticles,
  getArticleBySlug,
  getArticlesByFolder,
  getFolders,
  type SearchOptions,
  type SearchResult
} from './search.js';
