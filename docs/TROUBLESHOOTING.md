# Troubleshooting

Common operational checks:

- verify you called `createTable()` before indexing or searching
- verify the table dimension matches the embedding dimension in your code
- verify the same provider is used for indexing and querying
- verify hosted providers have `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_API_TOKEN`, `MISTRAL_API_KEY`, `GEMINI_API_KEY`, or
  `OPENAI_API_KEY` available as required by the selected provider
- after upgrading an existing Gemini index, fully re-embed with
  `gemini-embedding-2`; for 3072-dimensional Gemini indexes, recreate the table
  or use a new table name before rebuilding
- if `search()` reports that the `<tableName>_embedding_idx` vector index could
  not be used, the table has no embedding vector index: re-run `createTable()`
  with the table's existing name and width to add it without touching rows, or
  pass `exact: true` to search on the full-scan path meanwhile. See
  [Tables without the embedding vector index](./MIGRATIONS.md#tables-without-the-embedding-vector-index).
  The underlying libSQL message, preserved as the error's `cause`, reads
  "failed to parse vector index parameters" and does not mention the index
- if `search()` reports "no vector index support: vector_top_k() is
  unavailable", the libSQL build or server itself has no vector support, so
  creating an index will not help. Pass `exact: true` to search on the
  full-scan path, or move to a deployment with vector support
- a libSQL error reading "dimensions are different: 384 != 4" is a different
  problem and is passed through unchanged: the index exists, but the query
  embedding's width does not match the `embedding` column's width. Creating an
  index will not help and neither will `exact: true` — the exact path reports
  the same root cause in different words, as
  "vector_distance: vectors must have the same length: 4 != 384", with the
  operands in the opposite order. Align the widths across
  `createTable()`, `indexContent()`, and `search()`, and re-index if the stored
  vectors are in the wrong space; see the
  [Migration and reindexing guide](./MIGRATIONS.md)

## `@libsql/client` Version Differences

The peer range is `^0.15.0 || ^0.17.0`, verified against `0.15.15` and `0.17.4`.
There is no `0.16.x` line upstream. Everything this package depends on behaves
the same on both — `vector_top_k()` returns rowids in an `id` column, the
missing-index message this library rewrites ("failed to parse vector index
parameters") and the dimension-mismatch message it passes through unchanged are
both byte-identical, and `batch(..., "write")` still rolls the whole rebuild back
on failure — so upgrading the client is optional and neither direction requires
re-indexing. (The third message, the no-vector-support case, is not reproducible
against a local build on either version; see
[Requirements](./API.md#requirements).)

Two client-side differences are visible to callers on `0.17.x`:

- the client no longer exports `./package.json`. Reading it by specifier, as in
  `require("@libsql/client/package.json")`, throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED`. Nothing in this package does that; if your own
  tooling did, read the file through a direct `node_modules` path instead
- **constraint error codes lost the `_UNIQUE` suffix.** A duplicate slug that
  reported `SQLITE_CONSTRAINT_UNIQUE` on `0.15.x` reports the broader
  `SQLITE_CONSTRAINT` on `0.17.x`. This affects every caller on both query paths:

  | | `0.15.15` | `0.17.4` |
  | --- | --- | --- |
  | `execute()` | `SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: …` | `SQLITE_CONSTRAINT: UNIQUE constraint failed: …` |
  | `batch(…, "write")` | `SQLITE_CONSTRAINT_UNIQUE: UNIQUE constraint failed: …` | `SQLITE_CONSTRAINT: SQLITE_CONSTRAINT: UNIQUE constraint failed: …` |

  Note that the prefix is additionally **doubled on the `batch()` path only** —
  that is the path `indexContent()` uses, so it is what surfaces as the `cause`
  of an `IndexingError` with `phase: "replace"`. Your own `execute()` calls show
  the single prefix. Both are cosmetic: the rollback and the `IndexingError`
  contract are unchanged.

  A log matcher or alert rule keyed on `SQLITE_CONSTRAINT_UNIQUE` will stop
  matching after the upgrade, on either path. Match on `UNIQUE constraint failed`
  instead — it is the one substring stable across all four cells above.
