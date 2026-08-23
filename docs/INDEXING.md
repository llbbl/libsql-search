# Indexing And Operations

## Content Shape

`indexContent()` walks a directory tree, reads Markdown files, parses frontmatter with `gray-matter`, and stores:

- `slug`
- `title`
- `content`
- `folder`
- `tags`
- `embedding`

The slug is derived from the file path relative to `contentPath`.

## Rebuild Behavior

`indexContent()` replaces the whole target table:

```ts
await indexContent({
  client,
  contentPath: "./content",
  tableName: "articles_local_384",
  embeddingOptions: {
    provider: "local",
  },
});
```

The rebuild runs in two phases:

1. build: every file is read, parsed, and embedded in memory, touching no database state
2. replace: the delete and all inserts run in a single write transaction

That means:

- a failed rebuild leaves the previously indexed rows exactly as they were
- provider or dimension changes should still use a parallel table migration
- `createTable()` does not resize an existing vector column

Files are discovered and indexed in sorted path order, so a rebuild is deterministic.

If provider, dimensions, model, endpoint, or embedding-space assumptions change, fully reindex into a new table. See the canonical [Migration and reindexing guide](./MIGRATIONS.md).

### Costs Of The Two-Phase Rebuild

Atomicity is not free, and both costs scale with corpus size:

- **Peak memory holds the whole corpus.** The build phase keeps every document in memory: content, frontmatter, and one embedding array per document. The replace phase then builds insert statements including a JSON copy of each embedding, roughly 5-8 KB per document at 384 dimensions and considerably more at 3072. Documents are released as their statements are built, but peak usage is still proportional to the entire corpus rather than to one file.
- **Remote clients send one request.** Against Turso or any remote client, the delete and every insert travel as a single batch. There is no chunking fallback, because splitting the batch would give up the atomicity this design exists to provide. A corpus large enough to exceed a remote request-size limit fails as an opaque `phase: "replace"` error.

For very large corpora, index into a parallel table and switch reads over once it validates, rather than rebuilding a live table in place. See the [Migration and reindexing guide](./MIGRATIONS.md).

## Content Requirements

Two authoring mistakes fail a file at the `parse` stage rather than corrupting the rebuild:

- **Frontmatter `title` must be a scalar.** Strings, numbers, booleans, and dates are accepted; dates are stored as ISO strings. A structured title such as a YAML list fails the file. A missing or empty title still falls back to the filename.
- **Slugs must be unique.** The slug comes from the path with the extension removed, so `foo.md` and `foo.markdown` collide. Files are processed in sorted path order and the first file to claim a slug keeps it, so `foo.markdown` wins and `foo.md` is reported as the failure.

Both are governed by `failurePolicy` like any other build failure, so they abort by default and are skippable.

## Failure Handling

`indexContent()` throws `IndexingError` instead of reporting a partially applied rebuild. The error carries `phase` (`"build"` or `"replace"`), a `failures` array, and the underlying error as `cause`.

```ts
import { indexContent, IndexingError } from "libsql-search";

try {
  await indexContent({ client, contentPath: "./content" });
} catch (error) {
  if (error instanceof IndexingError) {
    for (const failure of error.failures) {
      console.error(`${failure.file} failed during ${failure.stage}`);
    }
  }

  throw error;
}
```

By default one bad file aborts the whole rebuild. To index everything that can be indexed, opt into `failurePolicy: "skip"`:

```ts
const result = await indexContent({
  client,
  contentPath: "./content",
  failurePolicy: "skip",
});

if (result.partial) {
  console.warn(`Indexed ${result.success} of ${result.total} files`);
}
```

Skipped rebuilds still replace the table, so treat `partial: true` as a build warning rather than a clean rebuild. If every discovered file fails, the rebuild throws rather than trading a valid index for an empty one.

## Empty Source Directories

An empty source directory throws by default, because silently leaving stale rows in place serves search traffic from content that no longer exists. Emptying an index has to be intentional:

```ts
await indexContent({
  client,
  contentPath: "./content",
  allowEmptyIndex: true,
});
```

Both behaviors changed in a breaking way: partial failures used to be counted and reported, and an empty directory used to return zeros without clearing the table.

## The Embedding Vector Index

`createTable()` creates `<tableName>_embedding_idx` alongside the table:

```sql
CREATE INDEX IF NOT EXISTS "<tableName>_embedding_idx"
ON "<tableName>"(libsql_vector_idx(embedding))
```

`search()` requires that index by default. It queries the index through `vector_top_k()` instead of scoring every row, so query cost no longer grows linearly with the size of the index.

That index is approximate. `search()` compensates by over-fetching candidates and re-ranking them exactly; see [`search(options)`](./API.md#searchoptions) for the recall and ordering semantics and for the `candidates` and `exact` options.

### Tables Built Before The Index Existed

A table created by hand, or by a version of this package that predated the embedding index, has no `<tableName>_embedding_idx`. The default search path fails on such a table with an error naming the missing index — libSQL's own message for the case ("failed to parse vector index parameters") does not mention it.

`indexContent()` does not create the index; it only replaces rows. Two ways forward:

```ts
// Preferred: createTable() is idempotent and adds only what is missing
await createTable(client, "articles", 384);
```

```sql
-- Or create the index directly against the existing table
CREATE INDEX IF NOT EXISTS "articles_embedding_idx"
ON "articles"(libsql_vector_idx(embedding));
```

`createTable()` uses `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, so calling it against an existing table adds the missing index without touching rows. It still does not resize an existing vector column.

Until the index exists, pass `exact: true` to `search()` to keep queries working on the full-scan path.

## Quality Guidelines

- include descriptive frontmatter titles
- add meaningful `tags` when they help retrieval
- use the same provider and dimensions at index and query time
- keep `maxLength` intentional if your content is very large
- start with a smaller search `limit` and tune from real query behavior
- raise `candidates` if the approximate index path misses results the exact path finds; compare the two with `exact: true` on a fixed set of queries

## Build Integration

Many projects wire indexing into a dedicated script and call it before their site build:

```json
{
  "scripts": {
    "index": "node ./scripts/index.js",
    "build": "pnpm index && astro build"
  }
}
```

## Table Names

`tableName` must be an ASCII SQLite identifier matching `[A-Za-z_][A-Za-z0-9_]*`. Valid names are quoted internally for table and index SQL, so reserved words such as `"select"` work safely. Invalid names fail before database calls or embedding generation.

## Runtime Notes

- local embeddings may download and cache a model on the first run
- Node users need `@libsql/client` installed alongside the package
- hosted providers send indexed or queried text to external services
- the repository validates package build and `deno check`, but indexing still depends on filesystem access
