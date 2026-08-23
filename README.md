# libsql-search

[![npm version](https://img.shields.io/npm/v/libsql-search.svg)](https://www.npmjs.com/package/libsql-search)
[![JSR](https://jsr.io/badges/@logan/libsql-search)](https://jsr.io/@logan/libsql-search)
[![CI](https://github.com/llbbl/libsql-search/actions/workflows/ci.yml/badge.svg)](https://github.com/llbbl/libsql-search/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

`libsql-search` adds semantic search to Markdown-backed sites with a small TypeScript API. It indexes frontmatter and content from files on disk, stores vectors in libSQL/Turso, and lets you query by meaning instead of exact keywords.

Use it when you want:

- one indexing/search API across local and hosted embedding providers
- direct control over vector dimensions, table names, and deployment shape
- a lightweight library instead of a hosted search product

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

## Quick Start

This example uses the default local provider. Local embeddings run in-process after the initial model download and cache warmup; they are not automatically air-gapped.

```ts
import { createClient } from "@libsql/client";
import { createTable, indexContent, search } from "libsql-search";

const client = createClient({
  url: "libsql://your-db.turso.io",
  authToken: "your-auth-token",
});

await createTable(client, "articles_local_384", 384);

await indexContent({
  client,
  contentPath: "./content",
  tableName: "articles_local_384",
  embeddingOptions: {
    provider: "local",
  },
});

const results = await search({
  client,
  query: "how do I deploy my docs site",
  tableName: "articles_local_384",
  limit: 5,
  embeddingOptions: {
    provider: "local",
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
- Keep table width, provider, and dimensions aligned across create/index/query.
- `indexContent()` embeds every document before it touches the database, then replaces the table in one transaction, so a failed rebuild leaves the previous index intact.
- `indexContent()` throws `IndexingError` when a file fails; pass `failurePolicy: "skip"` to rebuild from the remaining files.
- `indexContent()` throws `IndexingError` when no source files are found; pass `allowEmptyIndex: true` to intentionally empty the index.
- Hosted providers send indexed and queried text to external services and may incur provider charges.

## Providers

Built-in providers:

- `local` with `Xenova/all-MiniLM-L6-v2` at 384 dimensions
- `cloudflare` with `@cf/baai/bge-m3` at 1024 dimensions
- `mistral` with `mistral-embed` at 1024 dimensions
- `gemini` with `gemini-embedding-2` at 128-3072 dimensions, default 3072
- `openai` with `text-embedding-3-small` or `text-embedding-3-large`, default 768
- `openai-compatible` for trusted OpenAI-compatible endpoints such as TEI

## Docs

- [Documentation index](./docs/README.md)
- [Provider selection and configuration](./docs/PROVIDERS.md)
- [API reference](./docs/API.md)
- [Integration examples](./docs/INTEGRATIONS.md)
- [Migration and reindexing guide](./docs/MIGRATIONS.md)
- [Testing guidance](./docs/TESTING.md)
- [Indexing and operations](./docs/INDEXING.md)
- [Troubleshooting](./docs/TROUBLESHOOTING.md)

## License

MIT
