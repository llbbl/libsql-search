# Turso Database backend (experimental)

`libsql-search` can run against the in-process [`@tursodatabase/database`](https://www.npmjs.com/package/@tursodatabase/database)
client in addition to `@libsql/client`.

**This backend is experimental, and search on it is exact-only.** Read
[What is different on Turso](#what-is-different-on-turso) before adopting it —
the difference is architectural, not a rough edge that will be smoothed out by
an upgrade.

`@libsql/client` remains the default and the only backend the main entry point
knows about. Nothing on this page affects you if you do not import
`libsql-search/turso`.

## Install

`@tursodatabase/database` is an **optional** peer dependency, declared as
`^0.7.0 || ^0.8.0`. It is not installed, resolved, or imported unless you ask
for it. Both lines behave identically on every dimension this adapter depends
on; the disjunction is a caret-per-minor range for the same reason
`@libsql/client`'s is.

```bash
pnpm add libsql-search @tursodatabase/database
```

```bash
npm install libsql-search @tursodatabase/database
```

## Usage

Wrap the connected handle with `tursoAdapter()` and pass the result as `client`
everywhere you would otherwise pass a libSQL client.

```ts
import { connect } from "@tursodatabase/database";
import { tursoAdapter } from "libsql-search/turso";
import { createTable, indexContent, search } from "libsql-search";

// connect() is async. Awaiting it is not optional — tursoAdapter() rejects a
// pending Promise with a message saying so, because it is the most common
// first-use mistake.
const database = await connect("./local.db");
const client = tursoAdapter(database);

const embeddingOptions = {
  provider: "openai-compatible" as const,
  baseUrl: process.env.EMBEDDING_BASE_URL!,
  model: "bge-large-en-v1.5",
  dimensions: 1024,
};

await createTable(client, "articles", 1024);

await indexContent({
  client,
  contentPath: "./content",
  embeddingOptions,
});

const results = await search({
  client,
  query: "how do I deploy my docs site",
  limit: 5,
  embeddingOptions,
});

// When this adapter's lifetime ends, drain and close its cached statements
// before closing the caller-owned database handle.
await client.dispose();
await database.close();
```

Use `":memory:"` instead of a file path for an ephemeral database.

`createTable`, `indexContent`, `search`, `getAllArticles`, `getArticleBySlug`,
`getArticlesByFolder`, and `getFolders` all accept the adapter. The option and
result shapes — `SearchOptions`, `SearchResult`, `IndexerOptions`,
`IndexResult` — are identical on both backends.

### Adapter lifetime and disposal

One adapter caches up to **32 query statements**, keyed by SQL and evicted in
least-recently-used order. The bound matters because public `tableName` options
are embedded in SQL: an unbounded cache would let a long-lived process retain a
new native statement for every valid table name it sees. Statements that are
currently running or queued are closed after they finish rather than being
evicted out from under a call.

Call `await client.dispose()` after all work using that adapter has settled.
Disposal drains queued query calls and closes every cached statement, but does
**not** close the database handle you supplied. It is terminal: later calls on
that adapter reject. Close the database separately, after disposal. If you omit
disposal, the reusable cache is still bounded at 32 entries and lives until the
underlying handle or process exits; statements evicted while in flight live
only until their queued calls finish.

The adapter serializes concurrent calls that share one cached statement. This
is required for correctness, not just memory use: the native statement mutates
its current bindings, so overlapping `all()` calls with different arguments can
otherwise return another caller's rows. Different cached SQL statements remain
independent.

## What is different on Turso

### There is no ANN vector index, so search is a full scan

Turso Database implements the vector *functions* — `vector()`, `vector32()`,
`vector_distance_cos()` — but not the approximate-nearest-neighbor index that
libSQL exposes through `libsql_vector_idx()` and `vector_top_k()`. Attempting
either produces a parse error and a "no such table: vector_top_k" respectively.

Two consequences, both handled for you:

- `createTable()` creates the table, the folder index, and the slug index, and
  **skips** the vector index. It does not skip it on `@libsql/client`.
- `search()` runs the exact full-scan path automatically. You do not pass
  `exact: true`, and passing it changes nothing.

**Search cost is therefore linear in the number of indexed rows.** For a
personal site or a docs set this is generally fine and often faster than an
index probe. For a large corpus, use `@libsql/client`, which is not affected by
any of this.

This is a design direction rather than an unshipped feature:

- [`tursodatabase/turso` #832](https://github.com/tursodatabase/turso/issues/832),
  the DiskANN port, is open, unassigned, and in the Backlog milestone.
- [`tursodatabase/turso` #3778](https://github.com/tursodatabase/turso/issues/3778)
  was closed as *completed* by shipping SIMD-accelerated **exact** vector search,
  with the maintainer noting that "fast exact search is what many use cases
  actually want".
- The project's `COMPAT.md` lists the vector functions as supported and has no
  row for `libsql_vector_idx` or `vector_top_k` at all.

One thing worth knowing, because it costs people an afternoon: Turso's own
**AI & Embeddings** documentation page markets `vector_top_k` as a "Turso and
libSQL" feature without distinguishing the two engines. If you arrived expecting
it to work on `@tursodatabase/database`, that page is why. It does not.

### Index replacement uses a transaction, not a batch

`indexContent()` builds every document in memory and then replaces the table
contents in one atomic write, so a failed rebuild leaves the previous index
intact. That guarantee holds identically on both backends, but the primitive
behind it is inverted between them:

| | `@libsql/client` | `@tursodatabase/database` |
| --- | --- | --- |
| `batch(statements, "write")` | atomic | **not atomic** |
| `transaction()` | breaks in-memory clients | atomic, but **deferred** — see below |

Turso's `batch()` is not transactional: a batch that fails part way through
leaves the statements before the failure committed. On this backend the
replacement therefore runs inside an explicit `BEGIN IMMEDIATE` / `COMMIT`, with
an explicit `ROLLBACK` on failure. If you are extending this library, do not
"simplify" the Turso path to use `batch()` — it would silently convert a failed
rebuild into a half-destroyed index.

**Nor is `transaction()` the shortcut it looks like.** Turso's `transaction()`
is better-sqlite3-style: it *returns a wrapped function* rather than executing.
`await db.transaction(fn)` resolves to that function and never runs `fn` — no
error, no rows written. That is why this adapter issues `BEGIN IMMEDIATE`
itself.

This one is genuinely dangerous to get wrong, because it fails green. Rewriting
`executeAtomicWrite()` as `await database.transaction(async () => { ... })`
throws nothing and **still passes every test in the suite**, including the one
asserting that a failed rebuild leaves the previous index intact — an index that
was never touched trivially satisfies "unchanged". The reindex becomes a silent
no-op in production while CI stays green. `tests/turso-database.test.ts` pins
the deferred-execution behavior directly for this reason.

## Platform support

`@tursodatabase/database` ships prebuilt native binaries for these targets only:

- `darwin-arm64` (Apple Silicon)
- `linux-x64-gnu`
- `linux-arm64-gnu`
- `win32-x64-msvc`

Two gaps follow from that list, and Turso's documentation does not address
either one, so this is an observation about the published binaries rather than a
statement of their support policy:

- **No musl target.** Alpine-based images are not covered by a prebuilt binary.
- **No `darwin-x64`.** Intel Macs are not covered either.

`@libsql/client` has no such constraint, which is another reason it stays the
default.

The integration suite in `tests/turso-database.test.ts` skips itself — with a
warning naming the platform and the reason — anywhere the native module fails to
load, rather than failing the run. The capability-driven behavior it covers
(skipping the vector index, forcing the exact search path, routing the
replacement through the atomic write) is additionally covered on every platform
by `tests/database.test.ts`, which uses a stub adapter and no native code.

Tests never require Turso Cloud credentials, a URL, or a token. Everything runs
against an in-process `:memory:` database.

## Deno and JSR

The JSR package exports only the main entry point. `libsql-search/turso` is not
available there.

That is a scope decision, not a technical limit. `src/turso.ts` imports nothing
from `@tursodatabase/database` — it accepts the handle through a structural
`TursoDatabase` interface declared in this package — so exposing it on JSR would
not force Deno to resolve a Node-native package. It is left off because the
backend is experimental and the native binaries target Node platforms. The entry
point is still type-checked by `deno task check` so the claim above stays true.

## Type compatibility

`IndexerOptions["client"]` and `SearchOptions["client"]` accept either a
`@libsql/client` `Client` or an adapter. Existing `Client`-typed code compiles
unchanged, and the main entry point exports no new symbol and references no
Turso type.

`tursoAdapter()` returns a `TursoAdapter`, which extends `DatabaseAdapter` with
the disposal hook. Both types are exported from `libsql-search/turso` so you can
name them:

```ts
import { tursoAdapter, type TursoAdapter } from "libsql-search/turso";

let client: TursoAdapter;
```

It is exported from the subpath only. The main entry point does not export it,
so `libsql-search`'s public surface is unchanged for everyone else. An export
modifier is not a structural member, so the asymmetry does not affect
assignability between the two entry points.

`libsql-search` and `libsql-search/turso` are bundled separately, so each ships
its own structural copy of the adapter declaration. `pnpm check:dist-types`
compiles an adapter from the subpath against the client type from the main entry
to prove the two stay interchangeable, and runs as part of
`pnpm validate:package`.

## If you are extending this adapter

Three things in `src/turso.ts` look like noise and are not. Each has a
regression test; none of them fails loudly at runtime if removed.

**Prepared statements are bounded, serialized, and explicitly disposed.** A
statement holds native memory that the garbage collector cannot reclaim,
because it is not JavaScript heap. The query path therefore reuses a 32-entry
LRU instead of preparing on every request, serializes rebinds per entry, and
closes evictions only after their queued calls finish. `TursoAdapter.dispose()`
drains and closes the remaining cache. Measured through the built bundle,
60 000 `executeQuery()` calls grew RSS by ~570 MB when statements were never
closed, ~150 MB when each call prepared and closed, and ~7 MB when one statement
was reused. `search()` issues exactly one query, so the SSR-per-request path is
where reuse matters most. Inside `executeAtomicWrite()` the transaction-local
statements are still released only *after* `COMMIT` or `ROLLBACK` — a statement
stays bound to the transaction while it is open.

**`BEGIN IMMEDIATE` sits outside the `try`.** If it were inside, a `BEGIN` that
fails because another rebuild already holds the write lock would fall into the
`catch` and issue a `ROLLBACK`, ending the *other* call's in-flight transaction
and destroying a good rebuild that was about to commit. Failing to start a
transaction must never end one.

**Do not reach for `batch()` or `transaction()`.** Both are covered above; both
fail silently rather than loudly.
