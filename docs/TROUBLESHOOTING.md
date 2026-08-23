# Troubleshooting

Use the page that matches the failure mode:

- [Sharp native module issues](./TROUBLESHOOTING-SHARP.md)

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
- after upgrading an existing local 768-dimensional padded index, create or
  recreate a 384-dimensional table and fully re-index before querying it
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
