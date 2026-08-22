# Indexing And Operations

## Content Shape

`indexContent()` walks a directory tree, reads Markdown files, parses
frontmatter with `gray-matter`, and stores:

- `slug`
- `title`
- `content`
- `folder`
- `tags`
- `embedding`

The slug is derived from the file path relative to `contentPath`.

## Rebuild Behavior

`indexContent()` clears the target table before rebuilding:

```ts
await indexContent({
  client,
  contentPath: "./content",
  tableName: "articles",
  embeddingOptions: {
    provider: "local",
  },
});
```

That keeps the implementation simple, but it also means a failed rebuild can
leave the index partially repopulated.

Changing an embedding provider or dimension count requires a full re-embed.
For existing local indexes created with the older padded-local behavior, create
or recreate a 384-dimensional table before rebuilding. Those older local
768-dimensional tables stored 384 model values followed by zero padding;
`indexContent()` clears rows but does not change the table's `F32_BLOB` width.

For Gemini specifically, indexes created with the retired `text-embedding-004`
model must be rebuilt for `gemini-embedding-2` even when staying at 768
dimensions, because the model and query/document formatting both changed. If
you adopt Gemini's 3072-dimensional default, recreate the vector table or build
into a separate table first; clearing rows with `indexContent()` does not change
the table's `F32_BLOB` width.

## Quality Guidelines

- include descriptive frontmatter titles
- add meaningful `tags` when they help retrieval
- use the same embedding provider and dimensions at index and query time
- keep `maxLength` intentional if your content is very large
- start with a smaller search `limit` and tune from real query behavior

## Build Integration

Many projects wire indexing into a dedicated script and call it before their
site build:

```json
{
  "scripts": {
    "index": "node ./scripts/index.js",
    "build": "pnpm index && astro build"
  }
}
```

## Table Names

`tableName` must be an ASCII SQLite identifier matching
`[A-Za-z_][A-Za-z0-9_]*`. Valid names are quoted internally for table and index
SQL, so reserved words such as `"select"` work safely. Invalid names fail before
database calls or embedding generation.

## Runtime Notes

- local embeddings may download and cache a model on the first run
- Node users need `@libsql/client` installed alongside the package
- the repository validates both the npm package build and `deno check`, but the
  indexing flow itself still depends on filesystem access
