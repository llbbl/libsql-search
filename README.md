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
deno add jsr:@logan/libsql-search npm:@libsql/client@^0.17.0
```

For npm usage, the package requires Node `>=22.12.0`.

`@tursodatabase/database` is supported as an **optional** peer, behind the separate `libsql-search/turso` entry point. It is experimental and exact-search-only, because Turso Database has no ANN vector index. Nothing is installed or resolved for it unless you opt in — see the [Turso Database backend guide](./docs/TURSO.md).

**On npm/pnpm**, the peer range is `@libsql/client ^0.15.0 || ^0.17.0`. Both lines are supported: every behavior this package depends on — `vector_top_k()`'s result shape, the vector index error wording that `search()` matches on, and transactional `batch()` rollback — is identical across them, so an existing `0.15.x` install does not have to move. There is no `0.16.x` line upstream, which is why the range is a disjunction rather than a span. The packaged build is smoke-tested against both arms on every release, at the newest release each arm admits (currently `0.15.15` and `0.17.4`).

**On JSR/Deno the range does not apply to you.** `deno.json` declares no dependency on `@libsql/client` — this package imports only its *types* — so the client you `deno add` separately is constrained by nothing on our side, and a plain `deno add npm:@libsql/client` will silently take whatever is newest, including a future major we have never tested. Deno also cannot express our range: `npm:@libsql/client@^0.15.0 || ^0.17.0` is a parse error, as is any `>=`/`<` span. Pin an arm yourself instead:

```bash
deno add jsr:@logan/libsql-search npm:@libsql/client@^0.17.0
```

Note for `0.17.x`: the client no longer exports `./package.json`, so `require("@libsql/client/package.json")` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`. Nothing in this package reads it, but tooling of yours that inspected the client manifest by specifier needs a direct `node_modules` path instead. See [`@libsql/client` version differences](./docs/TROUBLESHOOTING.md#libsqlclient-version-differences) for the other upgrade-visible change.

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

- Call `createTable()` before indexing or searching. It creates the `<tableName>_embedding_idx` vector index that `search()` needs.
- Keep table width, provider, and dimensions aligned across create/index/query.
- `indexContent()` embeds every document before it touches the database, then replaces the table in one transaction, so a failed rebuild leaves the previous index intact.
- `indexContent()` throws `IndexingError` when a file fails; pass `failurePolicy: "skip"` to rebuild from the remaining files.
- `indexContent()` throws `IndexingError` when no source files are found; pass `allowEmptyIndex: true` to intentionally empty the index.
- Hosted providers send indexed and queried text to external services and may incur provider charges.

## Search Accuracy And Performance

`search()` queries the `<tableName>_embedding_idx` vector index through libSQL's `vector_top_k()`. It does not score every row, so query cost no longer grows linearly with the size of the index.

That index is an approximate-nearest-neighbor structure, so **the default search path is approximate and can miss a true nearest neighbor.** To limit the loss, `search()` over-fetches candidates from the index, recomputes the true cosine distance for each, and orders exactly by `(distance, id)` before trimming to `limit`. Distances on returned rows are always exact, and result ordering is fully deterministic — including when two rows tie — even though the index's own candidate order is not.

Two options control the trade-off:

```ts
// Widen the index probe to raise recall (default: max(limit * 4, 32))
await search({ client, query, limit: 10, candidates: 200 });

// Bypass the index entirely: exact, but linear in table size
await search({ client, query, exact: true });
```

`exact: true` is the only way to guarantee exactness. Use it for small corpora, for correctness checks against the index path, and for tables that have no vector index.

Requirements: `vector_top_k()` and `libsql_vector_idx()` need a libSQL build with native vector support. The peer dependency is `@libsql/client ^0.15.0 || ^0.17.0`, verified against `0.15.15` and `0.17.4`; remote Turso/libSQL servers must support vector indexes as well. See the [API reference](./docs/API.md#searchoptions) for full semantics, and [Indexing and operations](./docs/INDEXING.md) for tables created before the index existed.

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
