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
    dimensions: 768,
  },
});
```

That keeps the implementation simple, but it also means a failed rebuild can
leave the index partially repopulated.

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

`tableName` is interpolated into SQL. Treat it as a trusted identifier coming
from your own configuration, not from user input.

## Runtime Notes

- local embeddings may download a model on the first run
- Node users need `@libsql/client` installed alongside the package
- the repository validates both the npm package build and `deno check`, but the
  indexing flow itself still depends on filesystem access
