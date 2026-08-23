# Migration And Reindexing

Changing an embedding provider is not just a config flip. Stored vectors and query vectors must stay in the same embedding space for search quality to hold.

## What The Table Stores

`createTable(client, tableName, dimensions)` creates an `embedding` column with the exact Turso/libSQL vector type:

```sql
embedding F32_BLOB(dimensions)
```

That width is fixed by the table schema. `CREATE TABLE IF NOT EXISTS` does not resize an existing vector column.

References:

- [Turso AI and embeddings](https://docs.turso.tech/features/ai-and-embeddings)
- [Gemini model versions](https://ai.google.dev/gemini-api/docs/embeddings#model-versions)

## Rules

- if dimensions change, create a new table or recreate the old table, then fully re-embed
- if dimensions stay the same but provider, model, endpoint, model revision, pooling, normalization, or input formatting changes, fully reindex anyway
- never mix two embedding spaces in one table
- prefer a parallel table migration because `indexContent()` replaces the whole target table, so an in-place rebuild leaves no way back to the old vectors
- upgrading `@libsql/client` is not one of these migrations. The client moves bytes; it does not define the embedding space. Moving between the supported `^0.15.0` and `^0.17.0` lines leaves stored vectors, table widths, and the embedding index untouched and needs no reindex. This is checkable rather than merely inferred: `libsql`, the embedded native engine that owns the on-disk `F32_BLOB` format and the vector index, resolves to `0.5.29` under both client lines — the client bump does not move it. See [`@libsql/client` version differences](./TROUBLESHOOTING.md#libsqlclient-version-differences) for the two client-side behaviors that do change.

In practice, this means:

- `384 local` and `1024 Mistral` can never share a table
- `1024 Cloudflare` and `1024 Mistral` still need separate rebuilds because equal width does not make the vectors compatible
- a custom endpoint change at the same width still needs a new table because the model or serving stack may have changed

## Safe Migration Pattern

1. Pick a new table name that makes the provider and dimensions obvious.
2. Create that table with the target width.
3. Reindex all content into the new table.
4. Run search quality checks against the new table.
5. Switch application reads and writes to the new table.
6. Retire the old table in a separate cleanup step.

Step 3 is all or nothing. `indexContent()` throws `IndexingError` and leaves the target table untouched when a file or the replacement transaction fails, so a failed migration step can be retried without cleanup. See [Indexing and operational behavior](./INDEXING.md) for `failurePolicy` and `allowEmptyIndex`.

Example:

```ts
await createTable(client, "articles_gemini2_3072", 3072);

await indexContent({
  client,
  contentPath: "./content",
  tableName: "articles_gemini2_3072",
  embeddingOptions: {
    provider: "gemini",
    apiKey: process.env.GEMINI_API_KEY,
    dimensions: 3072,
    intent: "document",
  },
});
```

Then query the new table explicitly during validation:

```ts
const results = await search({
  client,
  tableName: "articles_gemini2_3072",
  query: "deployment checklist",
  embeddingOptions: {
    provider: "gemini",
    apiKey: process.env.GEMINI_API_KEY,
    dimensions: 3072,
    intent: "query",
  },
});
```

## Tables Without The Embedding Vector Index

`search()` queries the `<tableName>_embedding_idx` vector index by default rather than scanning the whole table. A table created by hand, or by a version of this package that predated that index, does not have it, and the default search path fails against such a table.

Re-running `createTable()` with the table's existing width is the fix. It is idempotent — `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` — so it adds the missing index without touching rows and without resizing the vector column:

```ts
// Same name and same width as the existing table
await createTable(client, "articles_local_384", 384);
```

Equivalently, in SQL:

```sql
CREATE INDEX IF NOT EXISTS "articles_local_384_embedding_idx"
ON "articles_local_384"(libsql_vector_idx(embedding));
```

Reindexing does not create the index; `indexContent()` only replaces rows. Any new table created by `createTable()` as part of a migration already has it, so this applies only to pre-existing tables you are carrying forward. Until the index exists, `search({ ..., exact: true })` keeps queries working on the exact full-scan path.

## Common Migration Paths

| From | To | Why a rebuild is required | Recommended table move |
| --- | --- | --- | --- |
| Legacy padded local `768` | Native local `384` | Old tables stored `384` model values plus zero padding; current local provider is a native `384`-dimension space | Build into `articles_local_384`, validate, then retire the legacy table |
| Any `768` space | Any `1024` space | Width changes from `F32_BLOB(768)` to `F32_BLOB(1024)` | Create a new `1024` table and reindex |
| Cloudflare `1024` | Mistral `1024` | Width stays the same, but provider/model space changes | Use a parallel `1024` table such as `articles_mistral_1024` |
| Mistral `1024` | Cloudflare `1024` | Same reason in reverse | Use a parallel `1024` table such as `articles_cf_bgem3_1024` |
| Any `1024` space | OpenAI `1536` | Width changes and model changes | Create `articles_openai_1536` and reindex |
| OpenAI `1536` | OpenAI or Gemini `3072` | Width changes to `3072` | Create a new `3072` table and reindex |
| Gemini legacy `text-embedding-004` at `768` | Gemini `gemini-embedding-2` at `768` | Same width, but the upstream model changed and the adapter now distinguishes document/query formatting | Build a parallel `articles_gemini2_768` table |
| Any custom endpoint/model | Any other custom endpoint/model, same width or different width | Endpoint, model, or serving revision may change the embedding space even when dimensions match | Always create a new table named for the target provider/model and reindex |

## Scenario Notes

### Legacy Local `768` To Native Local `384`

Earlier local migrations sometimes relied on zero padding to fit a `768`-wide table. The current local adapter emits the model's native `384` dimensions and rejects any other local dimension count.

Safe path:

```ts
await createTable(client, "articles_local_384", 384);
```

Reindex into `articles_local_384`; do not keep writing new local vectors into the legacy padded table.

### `768` To `1024`

Any move from `768` dimensions to `1024` dimensions changes the schema width. Examples include a legacy local table moving to Cloudflare or Mistral.

```ts
await createTable(client, "articles_mistral_1024", 1024);
```

### Cloudflare `1024` To Mistral `1024`

This is the main same-width example. The schema width can stay `1024`, but the vector space still changes.

```ts
await createTable(client, "articles_cf_bgem3_1024", 1024);
await createTable(client, "articles_mistral_1024", 1024);
```

Keep both tables side by side during validation. Do not clear the Cloudflare table until the Mistral table is validated in production-like queries.

### `1024` To OpenAI `1536`

```ts
await createTable(client, "articles_openai_1536", 1536);
```

This is both a width change and a provider/model change.

### `1536` To `3072`

Applies when moving from OpenAI `1536` to OpenAI `3072`, or from OpenAI `1536` to Gemini `3072`.

```ts
await createTable(client, "articles_openai_3072", 3072);
await createTable(client, "articles_gemini_3072", 3072);
```

Pick one target space and validate it before switching reads.

### Gemini Older Model `768` To Gemini 2 `768`

Even if you stay at `768`, rebuild because `text-embedding-004` has been replaced by `gemini-embedding-2`, and the current adapter uses different text formatting for document versus query intent.

```ts
await createTable(client, "articles_gemini2_768", 768);
```

### Custom Endpoint Or Model Change

Treat any `openai-compatible` move as a new embedding space:

- TEI model upgrade
- base URL change
- serving stack change
- pooling or normalization change
- gateway rewrite that changes input formatting

Example:

```ts
await createTable(client, "articles_tei_bge_1024_v2", 1024);
```

## Quality Checks Before Cutover

Run a small set of real queries against both old and new tables before switching:

- high-value navigation queries
- acronym or product-name queries
- queries that depend on tags or frontmatter wording
- long-tail queries that previously returned useful content

If the new table looks worse, keep the old table live while you inspect chunk size, source content, provider choice, and dimensionality.
