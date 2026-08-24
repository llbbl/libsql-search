# API Reference

## Exports

`libsql-search` exports:

- `createTable`
- `indexContent`
- `search`
- `getAllArticles`
- `getArticleBySlug`
- `getArticlesByFolder`
- `getFolders`
- `generateEmbedding`
- `generateEmbeddings`
- `createEmbeddingProvider`
- `getEmbeddingProviderMetadata`
- `validateEmbeddingBatch`
- `padEmbedding`
- `prepareTextForEmbedding`
- `IndexingError`
- `DEFAULT_SEARCH_CANDIDATE_MULTIPLIER`
- `MIN_SEARCH_CANDIDATES`
- `MAX_SEARCH_CANDIDATES`

It also exports these types:

- `EmbeddingProvider`
- `EmbeddingIntent`
- `EmbeddingBatchMode`
- `EmbeddingBatchBehavior`
- `EmbeddingProviderMetadata`
- `EmbeddingRequestOptions`
- `EmbeddingProviderClient`
- `EmbeddingBatchResult`
- `EmbeddingBatchItemResult`
- `EmbeddingBatchItem`
- `EmbeddingOptions`
- `IndexerOptions`
- `IndexedDocument`
- `IndexResult`
- `IndexFailure`
- `IndexFailurePolicy`
- `IndexFailureStage`
- `IndexingErrorPhase`
- `SearchOptions`
- `SearchResult`

## Navigation

- [Provider matrix and credential rules](./PROVIDERS.md)
- [Migration and reindexing guide](./MIGRATIONS.md)
- [Indexing and operational behavior](./INDEXING.md)
- [Testing guidance](./TESTING.md)
- [Turso Database backend](./TURSO.md)

## The `client` argument

Every function that talks to a database takes a `client`. It accepts either:

- a `@libsql/client` `Client` — the default, and the only backend the main entry point references, or
- an adapter from a backend entry point, currently `tursoAdapter()` from `libsql-search/turso`

`IndexerOptions["client"]` and `SearchOptions["client"]` are typed as
`Client | DatabaseAdapter`, so existing `Client`-typed code needs no change. The
main entry point exports no new symbol for this and never imports a backend
package other than `@libsql/client`.

The adapter carries a capability flag that changes two behaviors on a backend
without an approximate-nearest-neighbor vector index: `createTable()` skips the
vector index, and `search()` uses the exact path automatically. Both are
described in the [Turso Database backend guide](./TURSO.md), which is currently
the only backend where they apply.

## `createTable(client, tableName?, dimensions?)`

Creates the search table and supporting indexes.

```ts
await createTable(client);
```

On a backend with no vector index support, the `<tableName>_embedding_idx`
vector index is skipped; the table, the folder index, and the slug index are
still created. On `@libsql/client` it is never skipped.

Defaults:

- `tableName`: `"articles"`
- `dimensions`: `384`

`tableName` must be an ASCII SQLite identifier matching `[A-Za-z_][A-Za-z0-9_]*`. Valid identifiers are quoted internally, so reserved words such as `"select"` are safe to use. `dimensions` must be a positive integer.

The created schema includes:

- `id` primary key
- `slug`
- `title`
- `content`
- `folder`
- `tags`
- `embedding F32_BLOB(dimensions)`
- `created_at`
- `updated_at`

`createTable()` uses `CREATE TABLE IF NOT EXISTS`, so it does not resize an existing vector column. See [Migration and reindexing guide](./MIGRATIONS.md) before changing widths or providers.

## `indexContent(options)`

Indexes Markdown files from a directory on disk.

```ts
interface IndexerOptions {
  client: Client | DatabaseAdapter;
  contentPath: string;
  embeddingOptions: EmbeddingOptions;
  fileExtensions?: string[];
  exclude?: string[];
  tableName?: string;
  onProgress?: (current: number, total: number, file: string) => void;
  failurePolicy?: "abort" | "skip";
  allowEmptyIndex?: boolean;
}
```

Defaults:

- `fileExtensions`: [".md", ".markdown"]
- `exclude`: ["node_modules", ".git", "dist", "build"]
- `tableName`: `"articles"`
- `failurePolicy`: `"abort"`
- `allowEmptyIndex`: `false`

Return shape:

```ts
interface IndexResult {
  success: number;   // documents written
  failed: number;    // files that could not be indexed
  total: number;     // files discovered on disk
  replaced: boolean; // whether table contents were replaced by this call
  partial: boolean;  // replaced, but some files were skipped
  failures: IndexFailure[];
}

interface IndexFailure {
  file: string;                        // path relative to contentPath
  stage: "read" | "parse" | "embed";
  error: Error;
}
```

Behavior notes:

- every file is read, parsed, and embedded in memory before any database state changes
- the target table is then replaced in a single write transaction, so a failed rebuild leaves the previous index exactly as it was
- that costs peak memory proportional to the whole corpus, and against remote clients the replacement travels as a single un-chunked batch request; see [Costs of the two-phase rebuild](./INDEXING.md#costs-of-the-two-phase-rebuild) before rebuilding a very large corpus in place
- files are discovered and indexed in sorted path order
- frontmatter `title` must be a scalar; a structured title such as a YAML list fails the file at the `parse` stage
- two files that reduce to the same slug (`foo.md` and `foo.markdown`) collide: the first in sorted path order keeps the slug and the later file is reported as a `parse` failure
- `failurePolicy: "abort"` throws `IndexingError` on the first file that fails
- `failurePolicy: "skip"` drops the failing file, records it in `failures`, and rebuilds from the survivors, returning `partial: true`
- under `"skip"`, if every discovered file fails, the rebuild throws instead of replacing a valid index with an empty one
- an empty source directory throws unless `allowEmptyIndex: true`, which intentionally empties the index
- `onProgress` is called once per file during the build phase
- frontmatter `title`, `description`, and `tags` are folded into the embedding text
- embeddings default to `intent: "document"` unless `embeddingOptions.intent` is set explicitly
- if a file has no frontmatter title, the filename becomes the title

### `IndexingError`

Thrown when a rebuild cannot complete. The previously indexed rows are always left unchanged.

```ts
class IndexingError extends Error {
  readonly phase: "build" | "replace";
  readonly failures: IndexFailure[];
}
```

- `phase: "build"` means the failure happened before any database work: a file failed, every file failed, the source directory was empty, or it could not be scanned
- `phase: "replace"` means the replacement transaction failed and was rolled back
- `cause` carries the underlying error
- on a `phase: "replace"` error, `failures` lists files skipped during the build phase. They are not the cause of the rollback, which is carried by `cause`

```ts
import { indexContent, IndexingError } from "libsql-search";

try {
  await indexContent({
    client,
    contentPath: "./content",
    embeddingOptions: {
      provider: "openai-compatible",
      baseUrl: process.env.EMBEDDING_BASE_URL!,
      model: "bge-large-en-v1.5",
      dimensions: 1024,
    },
  });
} catch (error) {
  if (error instanceof IndexingError) {
    console.error(error.phase, error.failures);
  }

  throw error;
}
```

Breaking changes in this behavior:

- partial failures previously counted into `failed` and still replaced the table; they now throw. Pass `failurePolicy: "skip"` for the previous lenient behavior.
- an empty source directory previously returned zeros and left stale rows in place; it now throws. Pass `allowEmptyIndex: true` to intentionally empty the index.

## `search(options)`

Generates a query embedding and performs vector similarity search.

```ts
interface SearchOptions {
  client: Client | DatabaseAdapter;
  query: string;
  limit?: number;
  tableName?: string;
  embeddingOptions: EmbeddingOptions;
  candidates?: number;
  exact?: boolean;
}
```

Defaults:

- `limit`: `10`
- `tableName`: `"articles"`
- `candidates`: `Math.max(limit * 4, 32)`
- `exact`: `false`

`limit` must be an integer from `1` through `100`; invalid values are rejected before query embedding generation.

### Search Is Approximate By Default

The default path queries the `<tableName>_embedding_idx` vector index through libSQL's `vector_top_k()`. **That index is an approximate-nearest-neighbor structure. It can miss a true nearest neighbor.** There is no configuration that makes the index path exact; only `exact: true` guarantees exactness.

To limit the accuracy loss, the default path over-fetches: it pulls `candidates` rows from the index, recomputes the true `vector_distance_cos` for each, and orders exactly by `(distance, id)` before trimming to `limit`. So:

- **Recall is approximate.** A row the index does not return as a candidate cannot appear in the results, no matter its true distance. Raising `candidates` raises recall.
- **Ranking within the candidate set is exact.** Distances on returned rows are always the true cosine distances, not index approximations.
- **Ordering is fully deterministic.** The `id` tiebreaker means two rows at an identical distance always come back in the same order, even though the index's own candidate order is not stable across runs.
- **Rows with a `NULL` embedding are never returned.** The vector index excludes them on its own.

**Both paths order by `(distance, id)`.** The determinism guarantee covers `exact: true` as well as the default, so the two paths return identical orderings for identical inputs and can be compared directly. This is a change in tie ordering for the exact path, which previously sorted by distance alone and left tied rows in whatever order the scan produced.

### `candidates`

Controls how many rows the index returns for the exact re-rank. It must be an integer from `limit` through `MAX_SEARCH_CANDIDATES`; a value below `limit` is rejected rather than clamped, because it would silently truncate the result set. Invalid values throw before query embedding generation and before any database call.

```ts
// Trade query cost for recall on a large corpus
const results = await search({ client, query, embeddingOptions, limit: 10, candidates: 200 });
```

`candidates` has no effect when `exact` is `true` — that path scans every row — but it is **still validated**. `search({ exact: true, limit: 10, candidates: 5 })` throws, exactly as it would on the index path. Validity does not depend on which path a call happens to take.

Related exported constants:

- `DEFAULT_SEARCH_CANDIDATE_MULTIPLIER` (`4`): multiplier applied to `limit`
- `MIN_SEARCH_CANDIDATES` (`32`): floor for the derived default
- `MAX_SEARCH_CANDIDATES` (`1000`): ceiling for any explicit value. The derived default cannot reach it today, since `limit` tops out at `100`; the cap constrains explicit values.

### `exact`

Set `exact: true` to bypass the index and score every row in the table.

```ts
const results = await search({ client, query, embeddingOptions, exact: true });
```

This is the guaranteed-exact path: it computes `vector_distance_cos` for every row with a non-`NULL` embedding, sorts by `(distance, id)`, and trims to `limit`. Cost grows linearly with table size, so it is intended for small corpora, correctness checks against the index path, and tables that have no vector index.

A backend with no vector index at all takes this path whether or not `exact` is set, because there is no index path for it to fall back from. That is the case for `@tursodatabase/database`; see the [Turso Database backend guide](./TURSO.md).

### Missing Vector Index

If the target table has no `<tableName>_embedding_idx`, the default path throws an error naming the missing index and pointing at `createTable()` and `exact: true`. libSQL's own message for this case ("failed to parse vector index parameters") says nothing about a missing index, so it is preserved as the thrown error's `cause` rather than surfaced directly.

A deployment with no vector support at all is a separate case with its own message. `vector_top_k()` does not exist there, so no `CREATE INDEX` can help and the error points only at `exact: true`.

**Those two messages are the only ones rewritten.** Every other failure from the index path reaches the caller with its original message intact. In particular, a width mismatch between the query embedding and the `embedding` column surfaces as libSQL's own `vector index(search): dimensions are different: 384 != 4`, which names both widths and is the useful diagnostic for the dimension drift described in the [Migration and reindexing guide](./MIGRATIONS.md).

Search never falls back to the exact scan on its own. A silent fallback would turn a one-line schema fix into an invisible, permanent full-table scan.

### Requirements

`vector_top_k()` and `libsql_vector_idx()` require a libSQL build with native vector support. The peer dependency is `@libsql/client ^0.15.0 || ^0.17.0`; this behavior is verified against `@libsql/client` `0.15.15` and `0.17.4` with a local `:memory:` database. On both, `vector_top_k()` returns the matched rowids in an `id` column, libSQL's missing-index wording ("failed to parse vector index parameters") is byte-identical, and so is the dimension-mismatch wording that is passed through unchanged — so the index path and the diagnostics above behave the same on either line. The two lines share one embedded engine (`libsql` `0.5.29`), which is why the on-disk format and index semantics do not differ between them.

Coverage differs by layer, and is worth stating plainly: the packaged build is smoke-tested against **both** peer arms on every release, which covers table and vector-index creation. The full test suite — including the byte-exact assertions on the messages above — runs against the dev-pinned client, currently `0.17.4`. The no-vector-support case is the one message not reproducible against a local build on either version; it is asserted from a synthesized error rather than a measured one. Remote Turso/libSQL servers must also support vector indexes — that is a property of the server, not the client, and no minimum server version is claimed here beyond that requirement. A deployment without it fails the default path with an error saying so and naming `exact: true` as the remedy. Use `exact: true` against any deployment where vector index support is unavailable or unverified.

Result shape:

```ts
interface SearchResult {
  id: number;
  slug: string;
  title: string;
  content: string;
  folder: string;
  tags: string[];
  distance: number;
  created_at: string;
}
```

Lower `distance` values are better matches.

Search embeddings default to `intent: "query"` unless `embeddingOptions.intent` is set explicitly.

## Article Retrieval Helpers

### `getAllArticles(client, tableName?)`

Returns all indexed articles ordered by title.

### `getArticleBySlug(client, slug, tableName?)`

Returns one article or `null`.

### `getArticlesByFolder(client, folder, tableName?)`

Returns articles in a specific folder.

### `getFolders(client, tableName?)`

Returns distinct folder names from the index.

All retrieval helpers validate `tableName` before executing SQL, and all of them accept either client kind.

## Embedding Helpers

### `EmbeddingOptions`

```ts
interface EmbeddingOptions {
  provider:
    | "cloudflare"
    | "mistral"
    | "gemini"
    | "openai"
    | "openai-compatible";
  apiKey?: string;
  accountId?: string;
  apiToken?: string;
  baseUrl?: string;
  model?: string;
  batchSize?: number;
  dimensions?: number;
  maxLength?: number;
  intent?: "document" | "query";
  timeoutMs?: number;
  signal?: AbortSignal;
}
```

Important option rules:

- `provider` is required; every provider is an external service
- `maxLength` defaults to `8000`
- `timeoutMs` defaults to `30000`
- `model` is only used by `openai-compatible`
- `baseUrl`, `model`, and `dimensions` are required for `openai-compatible`
- `batchSize` only applies to `openai-compatible` and defaults to `32`
- `openai-compatible` never reads `OPENAI_API_KEY`
- only the Gemini adapter currently changes payload formatting by `intent`

Dimension rules:

- Cloudflare: fixed `1024`
- Mistral: fixed `1024`
- Gemini: default `3072`, allowed integer range `128-3072`
- OpenAI: default `768`; `text-embedding-3-small` through `1536`, `text-embedding-3-large` above `1536`
- OpenAI-compatible: required positive integer, no default

See [Provider matrix and credential rules](./PROVIDERS.md) for the canonical provider table.

### `generateEmbedding(text, options)`

Generates one embedding vector.

```ts
const embedding = await generateEmbedding("deploy docs", {
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
  dimensions: 1536,
});
```

### `generateEmbeddings(texts, options)`

Generates an ordered batch of embeddings.

- empty batches return `[]` without configuring credentials or making a provider call
- OpenAI batches above `2048` inputs are rejected before network work
- `openai-compatible` batches are chunked sequentially according to `batchSize`

### `createEmbeddingProvider(options)`

Creates a provider client with immutable metadata and an `embed(texts, options?)` method.

```ts
const provider = createEmbeddingProvider({
  provider: "openai-compatible",
  baseUrl: "https://tei.example.internal/v1",
  model: "bge-large-en-v1.5",
  dimensions: 1024,
  batchSize: 32,
});

console.log(provider.metadata);
```

Provider clients return a rich `EmbeddingBatchResult`; the compatibility helpers `generateEmbedding()` and `generateEmbeddings()` return only vectors.

Hosted provider clients are scoped to their current options. The library does not reuse a Cloudflare, Mistral, Gemini, or OpenAI client across different credential sets or configurations.

### `getEmbeddingProviderMetadata(options)`

Returns the same metadata exposed by `createEmbeddingProvider(options).metadata` without resolving hosted-provider credentials.

Metadata shape:

```ts
interface EmbeddingProviderMetadata {
  name:
    | "cloudflare"
    | "mistral"
    | "gemini"
    | "openai"
    | "openai-compatible";
  model: string;
  dimensions: number;
  batch: {
    mode: "native" | "sequential";
    maxSize?: number;
  };
}
```

Batch interpretation:

- `"native"` means the provider accepts a batch request upstream
- `"sequential"` means the library accepts a batch but processes items one-by-one
- `batch.maxSize` is a hard client-side limit when present

`openai-compatible` metadata reports `batch.mode: "native"` because the remote endpoint is expected to accept batch inputs, even though the library may split large arrays into sequential outbound chunks at `batchSize`.

### `EmbeddingBatchResult`

```ts
interface EmbeddingBatchResult {
  embeddings: number[][];
  provider:
    | "cloudflare"
    | "mistral"
    | "gemini"
    | "openai"
    | "openai-compatible";
  model: string;
  dimensions: number;
  intent: "document" | "query";
}
```

### `validateEmbeddingBatch(items, expectedCount, expectedDimensions, provider)`

Validates provider responses before they reach the database:

- result count must match the requested input count
- vectors must match the effective dimensions
- values must be finite numbers
- indexed provider responses are reordered and checked for contiguous indices

### `padEmbedding(embedding, targetDimensions)`

Pads or truncates a vector to the target width. This is exported for compatibility and migration workflows; provider adapters otherwise validate and preserve the vectors returned by their external service.

### `prepareTextForEmbedding(fields)`

Builds the text that is embedded from title, description, content, and tags.
