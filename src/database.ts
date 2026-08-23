/**
 * Database backend boundary.
 *
 * Every SQL call this library makes goes through {@link DatabaseAdapter}. The
 * `@libsql/client` adapter is built here, because that client is the declared
 * peer dependency and the only backend the main entry point knows about. Other
 * backends supply their own adapter from their own entry point, so the main
 * bundle never imports, resolves, or references their package.
 */

import type { Client, InStatement } from '@libsql/client';

/**
 * The narrow database contract the indexer, search, and retrieval helpers use.
 *
 * This interface is deliberately self-contained: it names no other type from
 * this package and no type from any backend package. That keeps the declaration
 * emitted into every entry point's `.d.ts` structurally identical, so an adapter
 * built by one entry point is assignable to the parameter types of another
 * without the two entry points sharing a nominal symbol.
 *
 * Do not brand this with a `unique symbol`. Each bundled `.d.ts` declares its
 * own copy of the interface, and a `unique symbol` would make those copies
 * nominally distinct — an adapter from the `libsql-search/turso` entry point
 * would stop being assignable to `SearchOptions['client']`.
 */
export interface DatabaseAdapter {
  /**
   * Marker set by this package's adapter factories.
   *
   * Public functions accept either a raw `@libsql/client` `Client` or an
   * adapter, and this property is how they tell the two apart. It is a plain
   * property rather than structural method sniffing on purpose: guessing a
   * backend from its method names would risk picking the wrong atomicity
   * primitive, and the two backends disagree about which primitive is
   * transactional.
   */
  readonly libsqlSearchAdapter: true;

  /** Which backend this adapter drives. Informational; behavior keys off the capability flags. */
  readonly backend: string;

  /**
   * Whether the backend can build a `libsql_vector_idx()` index and query it
   * through `vector_top_k()`.
   *
   * When false, `createTable()` skips the vector index and `search()` runs the
   * exact full-scan path automatically. Both are required, not optimizations:
   * on a backend without the index, `CREATE INDEX ... libsql_vector_idx(...)`
   * is a parse error and `vector_top_k` is not a table.
   */
  readonly supportsVectorIndex: boolean;

  /** Run a schema statement that returns no rows. */
  executeDdl(sql: string): Promise<void>;

  /**
   * Run one statement and return its rows as plain column-keyed objects.
   *
   * The bind-value union is spelled out inline rather than named, so that this
   * interface stays free of any other symbol. It is narrower than `unknown` on
   * purpose: it is the only compile-time check that a caller is binding
   * something a SQLite driver can actually store.
   */
  executeQuery(
    sql: string,
    args?:
      | Readonly<Record<string, string | number | bigint | Uint8Array | null>>
      | ReadonlyArray<string | number | bigint | Uint8Array | null>
  ): Promise<Array<Record<string, unknown>>>;

  /**
   * Apply every statement atomically: either all of them commit, or none do.
   *
   * The whole "a failed rebuild leaves the previous index intact" guarantee
   * rests on this method. A backend whose batch primitive is not transactional
   * must implement this with an explicit transaction instead.
   */
  executeAtomicWrite(
    statements: ReadonlyArray<{
      sql: string;
      args?: ReadonlyArray<string | number | bigint | Uint8Array | null>;
    }>
  ): Promise<void>;
}

/**
 * A client accepted by this library's public functions: either the
 * `@libsql/client` client, or an adapter built by one of this package's
 * adapter factories.
 */
export type DatabaseClient = Client | DatabaseAdapter;

/**
 * Whether a value is one of this package's adapters.
 */
export function isDatabaseAdapter(client: unknown): client is DatabaseAdapter {
  return (
    typeof client === 'object' &&
    client !== null &&
    (client as { libsqlSearchAdapter?: unknown }).libsqlSearchAdapter === true
  );
}

/**
 * Normalize a public `client` argument into an adapter.
 *
 * Anything that is not already an adapter is treated as a `@libsql/client`
 * client, which is what the public type says it must be.
 */
export function resolveDatabase(client: DatabaseClient): DatabaseAdapter {
  if (isDatabaseAdapter(client)) {
    assertCompleteAdapter(client);
    return client;
  }

  return createLibsqlAdapter(client);
}

/** The adapter methods every caller in this package relies on. */
const ADAPTER_METHODS = ['executeDdl', 'executeQuery', 'executeAtomicWrite'] as const;

/**
 * Reject an object that carries the adapter marker but not the adapter surface.
 *
 * The marker alone is not proof. Two copies of `libsql-search` can coexist in
 * one pnpm workspace — a direct dependency and a transitive one resolve
 * independently — and an adapter built by the other copy's `tursoAdapter()`
 * passes the marker check while potentially missing a method this copy calls.
 * Without this, that surfaces much later as
 * `TypeError: database.executeQuery is not a function`, which names nothing
 * useful. `tursoAdapter()` validates its own input for the same reason.
 */
function assertCompleteAdapter(adapter: DatabaseAdapter): void {
  const missing = ADAPTER_METHODS.filter(
    method => typeof (adapter as unknown as Record<string, unknown>)[method] !== 'function'
  );

  if (missing.length > 0) {
    throw new TypeError(
      `This client is marked as a libsql-search database adapter but is missing ` +
        `${missing.join(', ')}. The usual cause is two different versions of libsql-search ` +
        `resolved in one dependency tree, so the adapter was built by a different copy of the ` +
        `package than the one calling it. Deduplicate libsql-search, or build the adapter from ` +
        `the same copy you call.`
    );
  }
}

/**
 * Adapter for `@libsql/client`.
 *
 * `batch(statements, 'write')` is the atomic primitive here. It wraps its
 * statements in a transaction and rolls the whole group back if any statement
 * fails, and unlike `transaction()` it also works with in-memory clients, which
 * drop their connection when a transaction is opened.
 *
 * Argument-free statements are passed in the client's string form rather than
 * as `{ sql, args: undefined }`: the client's `InStatement` object form
 * requires `args`, so the string form is the correct call, not a stylistic
 * choice.
 */
export function createLibsqlAdapter(client: Client): DatabaseAdapter {
  return {
    libsqlSearchAdapter: true,
    backend: 'libsql',
    supportsVectorIndex: true,

    async executeDdl(sql: string): Promise<void> {
      await client.execute(sql);
    },

    async executeQuery(
      sql: string,
      args?:
        | Readonly<Record<string, string | number | bigint | Uint8Array | null>>
        | ReadonlyArray<string | number | bigint | Uint8Array | null>
    ): Promise<Array<Record<string, unknown>>> {
      const result = args === undefined
        ? await client.execute(sql)
        // The cast widens `readonly` away, nothing else: every member of the
        // bind union above is already an `InValue`.
        : await client.execute({ sql, args } as InStatement);

      return result.rows;
    },

    async executeAtomicWrite(
      statements: ReadonlyArray<{
        sql: string;
        args?: ReadonlyArray<string | number | bigint | Uint8Array | null>;
      }>
    ): Promise<void> {
      // The statement objects are forwarded as-is rather than copied: the
      // indexer hands over one object per document, and rebuilding them here
      // would allocate a second wrapper for every row in the corpus.
      // As above, the cast only discards `readonly`.
      const batch: InStatement[] = statements.map(statement =>
        statement.args === undefined ? statement.sql : (statement as InStatement)
      );

      await client.batch(batch, 'write');
    }
  };
}
