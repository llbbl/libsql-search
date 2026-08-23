/**
 * Vector search functionality
 */

import { generateEmbedding, type EmbeddingOptions } from './embeddings.js';
import { resolveDatabase, type DatabaseAdapter, type DatabaseClient } from './database.js';
import {
  DEFAULT_SEARCH_CANDIDATE_MULTIPLIER,
  MAX_SEARCH_CANDIDATES,
  MIN_SEARCH_CANDIDATES,
  normalizeSearchCandidates,
  normalizeSearchLimit,
  quoteSqlIdentifier,
  validateSqlIdentifier
} from './sql.js';

export {
  DEFAULT_SEARCH_CANDIDATE_MULTIPLIER,
  MAX_SEARCH_CANDIDATES,
  MIN_SEARCH_CANDIDATES
};

export interface SearchOptions {
  /**
   * A `@libsql/client` client, or an adapter from one of this package's
   * backend entry points, such as `tursoAdapter()` from `libsql-search/turso`.
   */
  client: DatabaseClient;
  query: string;
  limit?: number;
  tableName?: string;
  embeddingOptions?: EmbeddingOptions;
  /**
   * How many candidates to pull from the vector index before the exact
   * re-rank. Must be an integer from `limit` through {@link MAX_SEARCH_CANDIDATES}.
   *
   * Defaults to `max(limit * 4, 32)`.
   *
   * Has no effect when `exact` is `true`, but is still validated: an
   * out-of-range value throws on both paths rather than being quietly accepted
   * on one of them.
   */
  candidates?: number;
  /**
   * Bypass the vector index and score every row instead. Exact but linear in
   * table size. Defaults to `false`.
   *
   * Backends with no vector index take this path whether or not it is set: on
   * Turso Database `vector_top_k()` does not exist, so there is nothing to fall
   * back from.
   */
  exact?: boolean;
}

export interface SearchResult {
  id: number;
  slug: string;
  title: string;
  content: string;
  folder: string;
  tags: string[];
  distance: number;
  created_at: string;
}

/**
 * Columns every search path projects, in a fixed order, so both queries return
 * rows that {@link toSearchResult} can read identically.
 */
const RESULT_COLUMNS = 'a.id, a.slug, a.title, a.content, a.folder, a.tags, a.created_at';

/**
 * The one libSQL failure that means "this table has no vector index".
 *
 * libSQL reports a missing vector index as a parameter parse failure, which
 * names neither the index nor the real cause, so only this message is rewritten
 * into "create the index". Anything outside this list and
 * {@link NO_VECTOR_SUPPORT_PATTERNS} is rethrown untouched.
 *
 * Keep this narrow. libSQL prefixes unrelated failures with the same
 * `vector index(search):` text — a dimension mismatch surfaces as
 * `vector index(search): dimensions are different: 8 != 4`. Matching the prefix
 * would rewrite that into "create the missing index", advice that is wrong
 * twice over: the index exists, and the suggested `exact: true` fallback fails
 * for the same underlying reason. Dimension drift across createTable(),
 * indexContent(), and search() is this library's most common misconfiguration,
 * and its error already names both widths, so it must reach the caller intact.
 *
 * If a future libSQL version or transport words this differently, add the new
 * signature to this list. Do not widen it back to a general `vector` match.
 */
const MISSING_VECTOR_INDEX_PATTERNS = [
  /failed to parse vector index parameters/i
];

/**
 * libSQL builds without vector support at all, where `vector_top_k()` is not a
 * function this deployment has.
 *
 * Distinct from a missing index: no `CREATE INDEX` can fix it, so it gets its
 * own message pointing only at `exact: true`. Kept just as narrow as the list
 * above, and for the same reason.
 */
const NO_VECTOR_SUPPORT_PATTERNS = [
  /no such table:\s*vector_top_k/i
];

/**
 * Perform semantic search using vector similarity.
 *
 * By default this queries the `<tableName>_embedding_idx` vector index, which
 * is an approximate-nearest-neighbor structure: the candidate set it returns is
 * not guaranteed to contain the true nearest rows, and is not stable across
 * runs when distances tie. To limit both effects the query over-fetches
 * `candidates` rows, recomputes the true cosine distance for each, and orders
 * exactly by `(distance, id)`. The returned ordering is therefore fully
 * deterministic even though the candidate set is not.
 *
 * Pass `exact: true` for a guaranteed-exact full scan.
 *
 * On a backend with no ANN vector index — Turso Database, reached through
 * `tursoAdapter()` — the exact path is the only path, and is selected
 * automatically without `exact: true`.
 */
export async function search(options: SearchOptions): Promise<SearchResult[]> {
  const {
    client,
    query,
    limit = 10,
    tableName = 'articles',
    embeddingOptions = {},
    candidates,
    exact = false
  } = options;

  const database = resolveDatabase(client);

  // Every argument is validated before the embedding call so that bad input
  // fails without paying for a provider round trip
  const quotedTableName = quoteSqlIdentifier(tableName, 'tableName');
  const resultLimit = normalizeSearchLimit(limit);
  const embeddingIndexName = validateSqlIdentifier(
    `${tableName}_embedding_idx`,
    'embedding index name'
  );
  const candidateCount = normalizeSearchCandidates(candidates, resultLimit);

  // Generate embedding for query
  const queryEmbedding = await generateEmbedding(query, {
    ...embeddingOptions,
    intent: embeddingOptions.intent ?? 'query'
  });
  const queryVector = JSON.stringify(queryEmbedding);

  // A backend without `vector_top_k()` has no index path to choose, so it is
  // routed to the exact scan rather than being allowed to fail on a query it
  // could never have run.
  const useExactSearch = exact || !database.supportsVectorIndex;

  const rows = useExactSearch
    ? await executeExactSearch(database, quotedTableName, queryVector, resultLimit)
    : await executeIndexSearch(
        database,
        quotedTableName,
        embeddingIndexName,
        queryVector,
        candidateCount,
        resultLimit
      );

  return rows.map(toSearchResult);
}

/**
 * Approximate candidate fetch from the vector index, re-ranked exactly.
 *
 * `vector_top_k` yields rowids nearest-first and skips NULL embeddings on its
 * own, so no `IS NOT NULL` filter is needed here. The `a.id` tiebreaker is what
 * makes the result order reproducible when two rows share a distance.
 */
async function executeIndexSearch(
  database: DatabaseAdapter,
  quotedTableName: string,
  embeddingIndexName: string,
  queryVector: string,
  candidateCount: number,
  resultLimit: number
): Promise<SearchRow[]> {
  try {
    return await database.executeQuery(
      `
        SELECT
          ${RESULT_COLUMNS},
          vector_distance_cos(a.embedding, vector(:queryVector)) as distance
        FROM vector_top_k(:indexName, vector(:queryVector), :candidates) AS v
        JOIN ${quotedTableName} a ON a.rowid = v.id
        ORDER BY distance, a.id
        LIMIT :resultLimit
      `,
      {
        queryVector,
        indexName: embeddingIndexName,
        candidates: candidateCount,
        resultLimit
      }
    );
  } catch (error) {
    throw wrapIndexPathError(error, embeddingIndexName);
  }
}

/**
 * Exact full scan. Every row with an embedding is scored and sorted, so cost
 * grows linearly with the table.
 */
async function executeExactSearch(
  database: DatabaseAdapter,
  quotedTableName: string,
  queryVector: string,
  resultLimit: number
): Promise<SearchRow[]> {
  return database.executeQuery(
    `
      SELECT
        ${RESULT_COLUMNS},
        vector_distance_cos(a.embedding, vector(:queryVector)) as distance
      FROM ${quotedTableName} a
      WHERE a.embedding IS NOT NULL
      ORDER BY distance, a.id
      LIMIT :resultLimit
    `,
    { queryVector, resultLimit }
  );
}

/**
 * Replace libSQL's two opaque index-path failures with actionable ones.
 *
 * Only those two are rewritten, and each gets the remedy that actually applies:
 * a missing index is fixed by creating it, while a deployment without vector
 * support cannot be, so that message points only at `exact: true`. Any other
 * error, including a dimension mismatch, reaches the caller untouched.
 *
 * A missing index is never recovered from by silently falling back to the exact
 * scan: that would turn a one-line configuration fix into a permanent, silent
 * performance cliff, which is the exact failure mode the index path exists to
 * remove.
 */
function wrapIndexPathError(error: unknown, embeddingIndexName: string): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  if (MISSING_VECTOR_INDEX_PATTERNS.some(pattern => pattern.test(error.message))) {
    return new Error(
      `Vector index "${embeddingIndexName}" could not be used for search. ` +
        `createTable() creates this index; a table created before it existed, or created by ` +
        `hand, will not have it. Create it with ` +
        `CREATE INDEX IF NOT EXISTS "${embeddingIndexName}" ON <table>(libsql_vector_idx(embedding)), ` +
        `or pass exact: true to search without the index.`,
      { cause: error }
    );
  }

  if (NO_VECTOR_SUPPORT_PATTERNS.some(pattern => pattern.test(error.message))) {
    return new Error(
      `This libSQL deployment has no vector index support: vector_top_k() is unavailable. ` +
        `Pass exact: true to search on the full-scan path.`,
      { cause: error }
    );
  }

  return error;
}

/** A row as either backend returns it: column name to value. */
type SearchRow = Record<string, unknown>;

function toSearchResult(row: SearchRow): SearchResult {
  return {
    id: row.id as number,
    slug: row.slug as string,
    title: row.title as string,
    content: row.content as string,
    folder: row.folder as string,
    tags: JSON.parse(row.tags as string || '[]'),
    distance: row.distance as number,
    created_at: row.created_at as string
  };
}

/**
 * Get all articles (for building static pages, navigation, etc.)
 */
export async function getAllArticles(
  client: DatabaseClient,
  tableName: string = 'articles'
): Promise<Array<{
  id: number;
  slug: string;
  title: string;
  folder: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}>> {
  const database = resolveDatabase(client);
  const quotedTableName = quoteSqlIdentifier(tableName, 'tableName');
  const rows = await database.executeQuery(`
    SELECT id, slug, title, folder, tags, created_at, updated_at
    FROM ${quotedTableName}
    ORDER BY title
  `);

  return rows.map(row => ({
    id: row.id as number,
    slug: row.slug as string,
    title: row.title as string,
    folder: row.folder as string,
    tags: JSON.parse(row.tags as string || '[]'),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string
  }));
}

/**
 * Get a single article by slug
 */
export async function getArticleBySlug(
  client: DatabaseClient,
  slug: string,
  tableName: string = 'articles'
): Promise<{
  id: number;
  slug: string;
  title: string;
  content: string;
  folder: string;
  tags: string[];
  created_at: string;
  updated_at: string;
} | null> {
  const database = resolveDatabase(client);
  const quotedTableName = quoteSqlIdentifier(tableName, 'tableName');
  const rows = await database.executeQuery(
    `
      SELECT id, slug, title, content, folder, tags, created_at, updated_at
      FROM ${quotedTableName}
      WHERE slug = ?
      LIMIT 1
    `,
    [slug]
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    id: row.id as number,
    slug: row.slug as string,
    title: row.title as string,
    content: row.content as string,
    folder: row.folder as string,
    tags: JSON.parse(row.tags as string || '[]'),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string
  };
}

/**
 * Get articles by folder
 */
export async function getArticlesByFolder(
  client: DatabaseClient,
  folder: string,
  tableName: string = 'articles'
): Promise<Array<{
  id: number;
  slug: string;
  title: string;
  folder: string;
  tags: string[];
}>> {
  const database = resolveDatabase(client);
  const quotedTableName = quoteSqlIdentifier(tableName, 'tableName');
  const rows = await database.executeQuery(
    `
      SELECT id, slug, title, folder, tags
      FROM ${quotedTableName}
      WHERE folder = ?
      ORDER BY title
    `,
    [folder]
  );

  return rows.map(row => ({
    id: row.id as number,
    slug: row.slug as string,
    title: row.title as string,
    folder: row.folder as string,
    tags: JSON.parse(row.tags as string || '[]')
  }));
}

/**
 * Get all unique folders
 */
export async function getFolders(
  client: DatabaseClient,
  tableName: string = 'articles'
): Promise<string[]> {
  const database = resolveDatabase(client);
  const quotedTableName = quoteSqlIdentifier(tableName, 'tableName');
  const rows = await database.executeQuery(`
    SELECT DISTINCT folder
    FROM ${quotedTableName}
    ORDER BY folder
  `);

  return rows.map(row => row.folder as string);
}
