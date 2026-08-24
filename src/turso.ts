/**
 * Turso Database adapter — `libsql-search/turso`.
 *
 * **Experimental, and exact-search only.** See `docs/TURSO.md`.
 *
 * This entry point exists so that the main entry point never mentions
 * `@tursodatabase/database`. Nothing here imports it either: the database
 * handle is accepted through the structural {@link TursoDatabase} type, so
 * neither `tsc`, nor Deno, nor a bundler is ever asked to resolve the
 * native package on behalf of a user who does not use it.
 *
 * ```ts
 * import { connect } from '@tursodatabase/database';
 * import { tursoAdapter } from 'libsql-search/turso';
 * import { createTable, indexContent, search } from 'libsql-search';
 *
 * const database = await connect('./local.db');
 * const client = tursoAdapter(database);
 * const embeddingOptions = {
 *   provider: 'openai-compatible' as const,
 *   baseUrl: 'https://embeddings.example.com/v1',
 *   model: 'bge-large-en-v1.5',
 *   dimensions: 1024
 * };
 *
 * await createTable(client, 'articles', 1024);
 * await indexContent({ client, contentPath: './content', embeddingOptions });
 * const results = await search({ client, query: 'vector search', embeddingOptions });
 *
 * await client.dispose();
 * await database.close();
 * ```
 *
 * @module libsql-search/turso
 */

import type { DatabaseAdapter } from './database.js';

/**
 * The type {@link tursoAdapter} returns, and the type every public `client`
 * argument accepts alongside `@libsql/client`'s `Client`.
 *
 * Re-exported from this entry point only. The main entry point deliberately
 * does not export it: doing so would add a symbol to `libsql-search`'s public
 * surface for a backend most users never touch. An export modifier is not a
 * structural member, so naming it here does not affect whether an adapter built
 * by this entry point is assignable to the main entry point's client type.
 */
export type { DatabaseAdapter } from './database.js';

/**
 * The prepared-statement surface this adapter uses, as
 * `@tursodatabase/database` exposes it.
 *
 * Every method returns a Promise on this backend, but they are typed as
 * possibly-synchronous and always awaited, so a synchronous driver with the
 * same shape works too.
 */
export interface TursoStatement {
  run(args?: unknown): unknown;
  all(args?: unknown): unknown;
  /**
   * Release the native statement. Optional: a driver that manages statement
   * lifetime itself may omit it.
   *
   * Not closing leaks roughly 10 KB of native memory per prepare on
   * `@tursodatabase/database`, which the garbage collector does not reclaim
   * because it is not JavaScript heap. The adapter therefore closes
   * transaction-local statements immediately and query statements on safe LRU
   * eviction or disposal.
   */
  close?(): unknown;
}

/**
 * The database-handle surface this adapter uses, matching the object returned
 * by `connect()` from `@tursodatabase/database`.
 *
 * Declared structurally on purpose. Importing the real type would make
 * `@tursodatabase/database` a hard resolution target for anyone who type-checks
 * this package, including the many users who only ever touch `@libsql/client`.
 */
export interface TursoDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): TursoStatement;
}

/**
 * A Turso-backed adapter with an explicit prepared-statement disposal hook.
 *
 * `dispose()` is terminal: it waits for queued query calls, closes every
 * cached query statement, and rejects later adapter operations. It does not
 * close the caller-owned {@link TursoDatabase} handle.
 */
export interface TursoAdapter extends DatabaseAdapter {
  dispose(): Promise<void>;
}

/**
 * Maximum number of idle/reusable query statements retained by one adapter.
 *
 * SQL includes caller-controlled table names, so an unbounded map would turn
 * statement reuse into a slower native-memory leak. Thirty-two entries cover
 * the library's fixed query shapes across several tables while keeping that
 * lifetime cost small and deterministic.
 */
const MAX_QUERY_STATEMENT_CACHE_SIZE = 32;

interface QueryStatementCacheEntry {
  readonly sql: string;
  readonly statement: TursoStatement;
  /** Resolves when every call already queued on this statement has finished. */
  tail: Promise<void>;
  /** Includes the running call and calls waiting for their turn. */
  pending: number;
  retired: boolean;
  closePromise?: Promise<void>;
}

/**
 * Wrap a `@tursodatabase/database` handle so this library's functions can use
 * it.
 *
 * The returned value is passed as `client` to `createTable()`,
 * `indexContent()`, `search()`, and the retrieval helpers.
 *
 * Two behaviors differ from `@libsql/client`, and both are forced by the
 * backend rather than chosen here:
 *
 * - **No ANN vector index.** Turso Database implements the vector *functions*
 *   but not `libsql_vector_idx()` or `vector_top_k()`, so `createTable()` skips
 *   the vector index and `search()` always runs the exact full scan. Search is
 *   therefore O(rows) on this backend.
 * - **Transactions, not batches.** Turso's `batch()` is not atomic — a failing
 *   batch can leave earlier statements committed — so the index replacement
 *   runs inside an explicit `BEGIN IMMEDIATE` / `COMMIT` transaction, which is.
 *   This preserves the guarantee that a failed rebuild leaves the previous
 *   index intact.
 */
export function tursoAdapter(database: TursoDatabase): TursoAdapter {
  assertTursoDatabase(database);

  const queryStatementsBySql = new Map<string, QueryStatementCacheEntry>();
  const liveQueryStatements = new Set<QueryStatementCacheEntry>();
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  const assertUsable = (): void => {
    if (disposed) {
      throw new Error('This Turso adapter has been disposed');
    }
  };

  const closeQueryStatement = (
    entry: QueryStatementCacheEntry
  ): Promise<void> => {
    entry.closePromise ??= closeStatement(entry.statement).finally(() => {
      liveQueryStatements.delete(entry);
    });

    return entry.closePromise;
  };

  const retireQueryStatement = (entry: QueryStatementCacheEntry): void => {
    if (queryStatementsBySql.get(entry.sql) === entry) {
      queryStatementsBySql.delete(entry.sql);
    }

    entry.retired = true;
    if (entry.pending === 0) {
      // closeStatement() absorbs both synchronous throws and rejected close
      // promises, so deliberately detaching this cannot create an unhandled
      // rejection.
      void closeQueryStatement(entry);
    }
  };

  const acquireQueryStatement = (sql: string): {
    entry: QueryStatementCacheEntry;
    turn: Promise<void>;
    release: () => void;
  } => {
    assertUsable();

    let entry = queryStatementsBySql.get(sql);
    if (entry === undefined) {
      entry = {
        sql,
        statement: database.prepare(sql),
        tail: Promise.resolve(),
        pending: 0,
        retired: false
      };
      queryStatementsBySql.set(sql, entry);
      liveQueryStatements.add(entry);

      if (queryStatementsBySql.size > MAX_QUERY_STATEMENT_CACHE_SIZE) {
        const oldest = queryStatementsBySql.values().next().value as
          | QueryStatementCacheEntry
          | undefined;
        if (oldest !== undefined) {
          retireQueryStatement(oldest);
        }
      }
    } else {
      // Map iteration order is the LRU order. Refresh a hit to the newest end.
      queryStatementsBySql.delete(sql);
      queryStatementsBySql.set(sql, entry);
    }

    entry.pending += 1;

    // The native statement mutates its bound parameters. Concurrent all()
    // calls on one statement race and can return another caller's rows, so
    // every cache entry owns a tiny promise queue.
    const turn = entry.tail;
    let release!: () => void;
    const completion = new Promise<void>(resolve => {
      release = resolve;
    });
    entry.tail = turn.then(() => completion);

    return { entry, turn, release };
  };

  const adapter: TursoAdapter = {
    libsqlSearchAdapter: true,
    backend: 'turso',

    /**
     * Turso Database ships the vector functions but no ANN index. This is a
     * design direction rather than a gap: the project shipped SIMD-accelerated
     * exact search instead, and the DiskANN port remains an open backlog item.
     */
    supportsVectorIndex: false,

    async executeDdl(sql: string): Promise<void> {
      assertUsable();
      await database.exec(sql);
    },

    async executeQuery(
      sql: string,
      args?:
        | Readonly<Record<string, string | number | bigint | Uint8Array | null>>
        | ReadonlyArray<string | number | bigint | Uint8Array | null>
    ): Promise<Array<Record<string, unknown>>> {
      const { entry, turn, release } = acquireQueryStatement(sql);
      await turn;

      try {
        // `all()` binds nothing when called with no argument. Passing an
        // explicit `undefined` would be read as a single positional bind of
        // NULL.
        const rows = await (
          args === undefined ? entry.statement.all() : entry.statement.all(args)
        );

        return rows as Array<Record<string, unknown>>;
      } catch (error) {
        // Do not keep a statement whose execution failed in the reusable LRU.
        // Calls already queued on it may finish, then the final release closes
        // it; a later call prepares a clean replacement.
        retireQueryStatement(entry);
        throw error;
      } finally {
        entry.pending -= 1;
        release();

        if (entry.retired && entry.pending === 0) {
          await closeQueryStatement(entry);
        }
      }
    },

    /**
     * Replace the table contents inside one explicit transaction.
     *
     * `batch()` is deliberately not used. It is not transactional on this
     * backend: a batch that fails part way through leaves the statements before
     * the failure applied, which would silently turn a failed rebuild into a
     * half-destroyed index. `BEGIN IMMEDIATE` takes the write lock up front and
     * `ROLLBACK` restores the previous rows exactly.
     *
     * Statements are prepared once per distinct SQL string and rebound per row.
     * An index rebuild is one `DELETE` followed by N identical `INSERT`s, so
     * this turns N+1 prepares into exactly 2 regardless of corpus size.
     */
    async executeAtomicWrite(
      statements: ReadonlyArray<{
        sql: string;
        args?: ReadonlyArray<string | number | bigint | Uint8Array | null>;
      }>
    ): Promise<void> {
      assertUsable();
      const preparedBySql = new Map<string, TursoStatement>();

      const prepareOnce = (sql: string): TursoStatement => {
        let prepared = preparedBySql.get(sql);

        if (prepared === undefined) {
          prepared = database.prepare(sql);
          preparedBySql.set(sql, prepared);
        }

        return prepared;
      };

      // BEGIN IMMEDIATE is OUTSIDE the try, and must stay there.
      //
      // If it were inside, a BEGIN that fails because another rebuild already
      // holds the write lock would fall into the catch and issue a ROLLBACK --
      // ending the OTHER call's in-flight transaction and destroying a good
      // rebuild that was about to commit. Failing to start a transaction must
      // never end one. Do not "tidy" this line into the block below.
      await database.exec('BEGIN IMMEDIATE');

      try {
        for (const statement of statements) {
          const prepared = prepareOnce(statement.sql);
          await (statement.args === undefined ? prepared.run() : prepared.run(statement.args));
        }

        await database.exec('COMMIT');
      } catch (error) {
        // A rollback failure must not replace the error that caused it: the
        // original is what tells the caller why the rebuild failed. It is still
        // reported, because it changes the state the handle is left in.
        try {
          await database.exec('ROLLBACK');
        } catch (rollbackError) {
          warnOnFailedRollback(rollbackError);
        }

        throw error;
      } finally {
        // Released only after COMMIT or ROLLBACK has run. A prepared statement
        // stays bound to the transaction while it is open, so closing earlier
        // would release it out from under the write in progress.
        for (const prepared of preparedBySql.values()) {
          await closeStatement(prepared);
        }

        preparedBySql.clear();
      }
    },

    dispose(): Promise<void> {
      disposePromise ??= (async () => {
        disposed = true;

        // Copy first because retiring an entry removes it from the LRU map.
        for (const entry of [...queryStatementsBySql.values()]) {
          retireQueryStatement(entry);
        }

        // Includes already-evicted statements that still have queued calls.
        // Their per-entry tails resolve only after the last call releases its
        // turn, so no native statement is closed while it is still in use.
        await Promise.all(
          [...liveQueryStatements].map(async entry => {
            await entry.tail;
            await closeQueryStatement(entry);
          })
        );
      })();

      return disposePromise;
    }
  };

  return adapter;
}

/**
 * Release a prepared statement, ignoring any failure.
 *
 * Used from transaction `finally` blocks, query-cache eviction, and adapter
 * disposal. Throwing here could replace the error that is actually worth
 * reporting or turn best-effort cache cleanup into an unhandled rejection. A
 * close failure is not actionable by the caller, and closing is idempotent on
 * this backend.
 *
 * Deliberately quieter than `warnOnFailedRollback` below: a failed rollback
 * happens at most once per rebuild, while this runs once per query — on the
 * exact hot path the close exists to protect. Warning here would flood it.
 */
async function closeStatement(statement: TursoStatement): Promise<void> {
  try {
    await statement.close?.();
  } catch {
    // ignored on purpose
  }
}

/**
 * "No transaction is active" means the rollback had nothing to undo, which is
 * the state we wanted anyway. Every other rollback failure is worth saying out
 * loud.
 */
const NO_ACTIVE_TRANSACTION_PATTERN = /no transaction is active/i;

/**
 * Report a rollback that did not take.
 *
 * The original failure is still what gets thrown, but it says the transaction
 * was rolled back, and here it was not. Left silent, a disk error during
 * ROLLBACK resurfaces much later as "cannot start a transaction within a
 * transaction" on an unrelated write, pointing nowhere near the cause.
 */
function warnOnFailedRollback(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);

  if (NO_ACTIVE_TRANSACTION_PATTERN.test(message)) {
    return;
  }

  console.warn(
    `[libsql-search] ROLLBACK failed after a failed index replacement: ${message}. ` +
      `This database handle may still be inside an open transaction, in which case a later ` +
      `write on it fails with "cannot start a transaction within a transaction". ` +
      `Reconnect the handle before reusing it.`
  );
}

function assertTursoDatabase(database: TursoDatabase): void {
  if (
    typeof database !== 'object' ||
    database === null ||
    typeof database.exec !== 'function' ||
    typeof database.prepare !== 'function'
  ) {
    throw new TypeError(
      'tursoAdapter() expects a connected @tursodatabase/database handle with exec() and ' +
        'prepare() methods. connect() returns a Promise, so remember to await it.'
    );
  }
}
