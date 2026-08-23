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

`indexContent()` clears the target table before rebuilding:

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

That keeps the implementation simple, but it also means:

- failed rebuilds can leave the table partially repopulated
- provider or dimension changes should use a parallel table migration
- `createTable()` does not resize an existing vector column

If provider, dimensions, model, endpoint, or embedding-space assumptions change, fully reindex into a new table. See the canonical [Migration and reindexing guide](./MIGRATIONS.md).

## Quality Guidelines

- include descriptive frontmatter titles
- add meaningful `tags` when they help retrieval
- use the same provider and dimensions at index and query time
- keep `maxLength` intentional if your content is very large
- start with a smaller search `limit` and tune from real query behavior

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
