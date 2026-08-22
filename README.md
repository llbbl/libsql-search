# libsql-search

[![npm version](https://img.shields.io/npm/v/libsql-search.svg)](https://www.npmjs.com/package/libsql-search)
[![JSR](https://jsr.io/badges/@logan/libsql-search)](https://jsr.io/@logan/libsql-search)
[![CI](https://github.com/llbbl/libsql-search/actions/workflows/ci.yml/badge.svg)](https://github.com/llbbl/libsql-search/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

`libsql-search` adds semantic search to Markdown-backed sites using libSQL/Turso.
It indexes frontmatter and content from files on disk, stores vectors in your
database, and lets you query by meaning instead of exact keywords.

Use it when you want:

- a small TypeScript library instead of a hosted search product
- one search index shared across static-site builds and app routes
- local or API-based embeddings behind the same indexing/search API
- direct control over table names, dimensions, content shape, and deployment

## What It Supports

- Markdown indexing from local directories with frontmatter via `gray-matter`
- libSQL/Turso storage and vector search
- Embedding providers that exist in the code today: local
  `Xenova/all-MiniLM-L6-v2`, Google Gemini `text-embedding-004`, and OpenAI
  `text-embedding-3-small` and `text-embedding-3-large`
- npm distribution plus JSR publishing

## Install

`@libsql/client` is a peer dependency.

```bash
pnpm add libsql-search @libsql/client
```

```bash
npm install libsql-search @libsql/client
```

```bash
deno add jsr:@logan/libsql-search npm:@libsql/client
```

For npm usage, the package requires Node `>=22.12.0`.
Node examples in this README import from `libsql-search` and `@libsql/client`.
In Deno, after `deno add`, import from `@logan/libsql-search` and
`@libsql/client`.

## Quick Start

The shortest working flow is:

1. create a libSQL client
2. create the search table
3. index a Markdown directory
4. query it with the same embedding provider and dimensions

```ts
import { createClient } from "@libsql/client";
import { createTable, indexContent, search } from "libsql-search";

const client = createClient({
  url: "libsql://your-db.turso.io",
  authToken: "your-auth-token",
});

await createTable(client, "articles", 768);

await indexContent({
  client,
  contentPath: "./content",
  embeddingOptions: {
    provider: "local",
    dimensions: 768,
  },
});

const results = await search({
  client,
  query: "how do I deploy my docs site",
  limit: 5,
  embeddingOptions: {
    provider: "local",
    dimensions: 768,
  },
});

console.log(results.map((result) => ({
  slug: result.slug,
  title: result.title,
  distance: result.distance,
})));
```

Important behavior:

- Call `createTable()` before indexing or searching.
- Keep dimensions aligned across table creation, indexing, and search queries.
- `indexContent()` clears existing rows before rebuilding the index.

## Core API

- `createTable(client, tableName?, dimensions?)`
- `indexContent(options)`
- `search(options)`
- `getAllArticles(client, tableName?)`
- `getArticleBySlug(client, slug, tableName?)`
- `getArticlesByFolder(client, folder, tableName?)`
- `getFolders(client, tableName?)`
- `generateEmbedding(text, options?)`
- `prepareTextForEmbedding(fields)`

## Docs

- [Docs index](./docs/README.md)
- [Provider guide](./docs/PROVIDERS.md)
- [API reference](./docs/API.md)
- [Integration examples](./docs/INTEGRATIONS.md)
- [Indexing and operations](./docs/INDEXING.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)
- [Release workflow](./docs/RELEASING.md)

## License

MIT
