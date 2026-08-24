/**
 * Backend boundary tests.
 *
 * These run on every platform, including ones where the `@tursodatabase/database`
 * native module cannot load and `tests/turso-database.test.ts` skips. The
 * capability-driven behavior — skipping the vector index, forcing the exact
 * search path, routing the replacement through the adapter's atomic write — is
 * therefore always covered, using a stub adapter rather than a real backend.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import {
  createLibsqlAdapter,
  isDatabaseAdapter,
  resolveDatabase,
  type DatabaseAdapter
} from '../src/database.js';
import { createTable, indexContent } from '../src/indexer.js';
import { search, getFolders } from '../src/search.js';
import { tursoAdapter } from '../src/turso.js';
import {
  resetEmbeddingServiceMock,
  TEST_EMBEDDING_OPTIONS
} from './embedding-service.mock.js';

interface RecordedWrite {
  sql: string;
  args?: readonly unknown[];
}

/**
 * A minimal adapter that records what it was asked to do.
 *
 * Deliberately not a mock of any real driver: the point is to pin the behavior
 * this library drives off {@link DatabaseAdapter.supportsVectorIndex},
 * independently of whether any particular backend is installable here.
 */
function createRecordingAdapter(supportsVectorIndex: boolean): DatabaseAdapter & {
  ddl: string[];
  queries: Array<{ sql: string; args?: unknown }>;
  writes: RecordedWrite[][];
} {
  const ddl: string[] = [];
  const queries: Array<{ sql: string; args?: unknown }> = [];
  const writes: RecordedWrite[][] = [];

  return {
    ddl,
    queries,
    writes,
    libsqlSearchAdapter: true,
    backend: 'recording',
    supportsVectorIndex,
    async executeDdl(sql: string): Promise<void> {
      ddl.push(sql);
    },
    async executeQuery(sql: string, args?: unknown): Promise<Array<Record<string, unknown>>> {
      queries.push({ sql, args });
      return [];
    },
    async executeAtomicWrite(statements: readonly RecordedWrite[]): Promise<void> {
      writes.push([...statements]);
    }
  };
}

describe('database boundary', () => {
  beforeEach(() => {
    resetEmbeddingServiceMock();
  });

  describe('isDatabaseAdapter', () => {
    it('should recognize adapters built by this package', () => {
      expect(isDatabaseAdapter(createLibsqlAdapter({} as Client))).toBe(true);
      expect(isDatabaseAdapter(tursoAdapter({ exec: () => {}, prepare: () => ({ run: () => {}, all: () => [] }) }))).toBe(true);
    });

    it('should reject anything without the marker', () => {
      expect(isDatabaseAdapter(createClient({ url: ':memory:' }))).toBe(false);
      expect(isDatabaseAdapter({})).toBe(false);
      expect(isDatabaseAdapter({ libsqlSearchAdapter: 'yes' })).toBe(false);
      expect(isDatabaseAdapter(null)).toBe(false);
      expect(isDatabaseAdapter(undefined)).toBe(false);
      expect(isDatabaseAdapter('adapter')).toBe(false);
    });
  });

  describe('resolveDatabase', () => {
    it('should return an adapter unchanged', () => {
      const adapter = createRecordingAdapter(false);
      expect(resolveDatabase(adapter)).toBe(adapter);
    });

    it('should reject a marked adapter that is missing methods', () => {
      // Two copies of libsql-search in one dependency tree resolve
      // independently, so the marker alone is not proof of a usable adapter.
      const stale = { libsqlSearchAdapter: true, backend: 'turso', supportsVectorIndex: false };

      expect(() => resolveDatabase(stale as never)).toThrow(TypeError);
      expect(() => resolveDatabase(stale as never)).toThrow(/executeDdl/);
      expect(() => resolveDatabase(stale as never)).toThrow(/two different versions/);
    });

    it('should wrap a libSQL client as a vector-index-capable adapter', () => {
      const adapter = resolveDatabase(createClient({ url: ':memory:' }));

      expect(adapter.backend).toBe('libsql');
      expect(adapter.supportsVectorIndex).toBe(true);
    });
  });

  describe('libSQL adapter call shapes', () => {
    let client: Client;

    beforeEach(() => {
      client = createClient({ url: ':memory:' });
    });

    it('should send argument-free statements in the client string form', async () => {
      // The client's object form requires `args`, so an argument-free statement
      // must not be sent as `{ sql, args: undefined }`.
      const spy = vi.spyOn(client, 'execute');
      await createLibsqlAdapter(client).executeQuery('SELECT 1 AS one');

      expect(spy).toHaveBeenCalledWith('SELECT 1 AS one');
    });

    it('should send parameterized statements in the client object form', async () => {
      const spy = vi.spyOn(client, 'execute');
      await createLibsqlAdapter(client).executeQuery('SELECT ? AS value', ['x']);

      expect(spy).toHaveBeenCalledWith({ sql: 'SELECT ? AS value', args: ['x'] });
    });

    it('should return rows as plain column-keyed objects', async () => {
      const rows = await createLibsqlAdapter(client).executeQuery('SELECT 1 AS one');

      expect(rows).toHaveLength(1);
      expect(rows[0].one).toBe(1);
    });

    it('should write atomically through batch in write mode', async () => {
      const batchSpy = vi.spyOn(client, 'batch');
      await client.execute('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');

      await createLibsqlAdapter(client).executeAtomicWrite([
        { sql: 'DELETE FROM t' },
        { sql: 'INSERT INTO t (name) VALUES (?)', args: ['a'] }
      ]);

      expect(batchSpy).toHaveBeenCalledWith(
        ['DELETE FROM t', { sql: 'INSERT INTO t (name) VALUES (?)', args: ['a'] }],
        'write'
      );
    });
  });

  describe('createTable vector index handling', () => {
    it('should create the vector index on a backend that supports it', async () => {
      const adapter = createRecordingAdapter(true);
      await createTable(adapter, 'articles', 384);

      expect(adapter.ddl.some(sql => sql.includes('libsql_vector_idx'))).toBe(true);
    });

    it('should not skip the vector index on a real libSQL client', async () => {
      // The capability flag must never cause libSQL to lose the index the
      // default search path depends on.
      const client = createClient({ url: ':memory:' });
      await createTable(client, 'articles', 384);

      const indexes = await client.execute(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='articles'"
      );

      expect(indexes.rows.map(row => row.name)).toContain('articles_embedding_idx');
    });

    it('should skip only the vector index on a backend without one', async () => {
      const adapter = createRecordingAdapter(false);
      await createTable(adapter, 'articles', 384);

      expect(adapter.ddl.some(sql => sql.includes('libsql_vector_idx'))).toBe(false);
      expect(adapter.ddl.some(sql => sql.includes('CREATE TABLE IF NOT EXISTS'))).toBe(true);
      expect(adapter.ddl.some(sql => sql.includes('articles_folder_idx'))).toBe(true);
      expect(adapter.ddl.some(sql => sql.includes('articles_slug_idx'))).toBe(true);
    });
  });

  describe('search path selection', () => {
    it('should use the index path when the backend supports it', async () => {
      const adapter = createRecordingAdapter(true);

      await search({
        client: adapter,
        query: 'TypeScript',
        embeddingOptions: TEST_EMBEDDING_OPTIONS
      });

      expect(adapter.queries).toHaveLength(1);
      expect(adapter.queries[0].sql).toContain('vector_top_k');
    }, 30000);

    it('should use the exact path when the backend has no vector index', async () => {
      const adapter = createRecordingAdapter(false);

      await search({
        client: adapter,
        query: 'TypeScript',
        embeddingOptions: TEST_EMBEDDING_OPTIONS
      });

      expect(adapter.queries).toHaveLength(1);
      expect(adapter.queries[0].sql).not.toContain('vector_top_k');
      expect(adapter.queries[0].sql).toContain('embedding IS NOT NULL');
      expect(adapter.queries[0].args).toEqual({
        queryVector: expect.any(String),
        resultLimit: 10
      });
    }, 30000);

    it('should route retrieval helpers through the adapter', async () => {
      const adapter = createRecordingAdapter(false);
      await getFolders(adapter);

      expect(adapter.queries[0].sql).toContain('SELECT DISTINCT folder');
      expect(adapter.queries[0].args).toBeUndefined();
    });
  });

  describe('turso adapter statement lifetime', () => {
    /**
     * A handle whose statements record every lifecycle event, in order.
     *
     * Prepared statements on `@tursodatabase/database` hold native memory that
     * the garbage collector cannot reclaim, so failing to close one leaks on
     * every call. These assertions are the only thing standing between that and
     * an SSR process that grows until it is killed.
     */
    function createRecordingHandle(options: { omitClose?: boolean } = {}) {
      const events: string[] = [];
      let closes = 0;

      const handle = {
        exec: async (sql: string) => {
          events.push(`exec:${sql}`);
        },
        prepare: (sql: string) => {
          events.push(`prepare:${sql}`);

          const statement: Record<string, unknown> = {
            run: async () => {
              events.push('run');
              return { changes: 1 };
            },
            all: async () => {
              events.push('all');
              return [];
            }
          };

          if (!options.omitClose) {
            statement.close = () => {
              events.push('close');
              closes += 1;
            };
          }

          return statement as never;
        }
      };

      return { handle, events, closeCount: () => closes };
    }

    it('should close the prepared statement after a query', async () => {
      const { handle, events } = createRecordingHandle();

      await tursoAdapter(handle).executeQuery('SELECT 1');

      expect(events).toEqual(['prepare:SELECT 1', 'all', 'close']);
    });

    it('should close the prepared statement even when the query throws', async () => {
      const events: string[] = [];
      const handle = {
        exec: async () => {},
        prepare: (sql: string) => {
          events.push(`prepare:${sql}`);
          return {
            run: async () => {},
            all: async () => {
              throw new Error('query exploded');
            },
            close: () => {
              events.push('close');
            }
          } as never;
        }
      };

      await expect(tursoAdapter(handle).executeQuery('SELECT 1')).rejects.toThrow(
        'query exploded'
      );
      // A leak on the error path is the one that compounds fastest, because a
      // failing query is usually a repeating query.
      expect(events).toContain('close');
    });

    it('should not require close() to exist', async () => {
      // Optional on the interface, so the repo's own fake handles and any
      // driver that manages statement lifetime itself keep working.
      const { handle } = createRecordingHandle({ omitClose: true });

      await expect(tursoAdapter(handle).executeQuery('SELECT 1')).resolves.toEqual([]);
    });

    it('should close cached statements only after COMMIT', async () => {
      const { handle, events, closeCount } = createRecordingHandle();

      await tursoAdapter(handle).executeAtomicWrite([
        { sql: 'DELETE FROM articles' },
        { sql: 'INSERT INTO articles VALUES (?)', args: ['a'] },
        { sql: 'INSERT INTO articles VALUES (?)', args: ['b'] }
      ]);

      // Two distinct SQL strings, so two prepares and two closes regardless of
      // row count.
      expect(closeCount()).toBe(2);
      expect(events.indexOf('close')).toBeGreaterThan(events.indexOf('exec:COMMIT'));
      // A statement stays bound to the open transaction; closing before the
      // commit would release it out from under the write in progress.
      expect(events.slice(0, events.indexOf('exec:COMMIT'))).not.toContain('close');
    });

    it('should close cached statements after ROLLBACK', async () => {
      const events: string[] = [];
      const handle = {
        exec: async (sql: string) => {
          events.push(`exec:${sql}`);
        },
        prepare: () => ({
          run: async () => {
            throw new Error('insert exploded');
          },
          all: async () => [],
          close: () => {
            events.push('close');
          }
        }) as never
      };

      await expect(
        tursoAdapter(handle).executeAtomicWrite([{ sql: 'INSERT INTO articles VALUES (1)' }])
      ).rejects.toThrow('insert exploded');

      expect(events).toContain('close');
      expect(events.indexOf('close')).toBeGreaterThan(events.indexOf('exec:ROLLBACK'));
    });

    it('should warn when a rollback fails for a reason other than no active transaction', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const handle = {
          exec: async (sql: string) => {
            if (sql === 'ROLLBACK') {
              throw new Error('disk I/O error');
            }
          },
          prepare: () => ({
            run: async () => {
              throw new Error('insert exploded');
            },
            all: async () => []
          }) as never
        };

        await expect(
          tursoAdapter(handle).executeAtomicWrite([{ sql: 'INSERT INTO articles VALUES (1)' }])
        ).rejects.toThrow('insert exploded');

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('disk I/O error');
        expect(String(warn.mock.calls[0][0])).toContain('open transaction');
      } finally {
        warn.mockRestore();
      }
    });

    it('should warn when the rollback rejects with a non-Error', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const handle = {
          exec: async (sql: string) => {
            if (sql === 'ROLLBACK') {
              // Deliberately not an Error: drivers do reject with strings.
              throw 'rollback exploded';
            }
          },
          prepare: () => ({
            run: async () => {
              throw new Error('insert exploded');
            },
            all: async () => []
          }) as never
        };

        await expect(
          tursoAdapter(handle).executeAtomicWrite([{ sql: 'INSERT INTO articles VALUES (1)' }])
        ).rejects.toThrow('insert exploded');

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0][0])).toContain('rollback exploded');
      } finally {
        warn.mockRestore();
      }
    });

    it('should not let a failing close() replace the real error', async () => {
      // close() runs in a finally, so a throw there would mask whatever the
      // caller actually needs to see.
      const handle = {
        exec: async () => {},
        prepare: () => ({
          run: async () => {},
          all: async () => {
            throw new Error('query exploded');
          },
          close: () => {
            throw new Error('close exploded');
          }
        }) as never
      };

      await expect(tursoAdapter(handle).executeQuery('SELECT 1')).rejects.toThrow(
        'query exploded'
      );
    });

    it('should stay quiet when the rollback reports no active transaction', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const handle = {
          exec: async (sql: string) => {
            if (sql === 'ROLLBACK') {
              throw new Error('no transaction is active');
            }
          },
          prepare: () => ({
            run: async () => {
              throw new Error('insert exploded');
            },
            all: async () => []
          }) as never
        };

        await expect(
          tursoAdapter(handle).executeAtomicWrite([{ sql: 'INSERT INTO articles VALUES (1)' }])
        ).rejects.toThrow('insert exploded');

        // Nothing to undo is the state we wanted, not a problem to report.
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('indexContent replacement', () => {
    const testDir = join(process.cwd(), 'test-content-adapter');

    beforeEach(async () => {
      resetEmbeddingServiceMock();
      await mkdir(testDir, { recursive: true });
    });

    afterEach(async () => {
      await rm(testDir, { recursive: true, force: true });
      resetEmbeddingServiceMock();
    });

    it('should hand the whole replacement to the adapter as one atomic write', async () => {
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nContent');
      await writeFile(join(testDir, 'beta.md'), '---\ntitle: Beta\n---\nContent');

      const adapter = createRecordingAdapter(false);

      const result = await indexContent({
        client: adapter,
        contentPath: testDir,
        embeddingOptions: TEST_EMBEDDING_OPTIONS
      });

      expect(result.success).toBe(2);
      expect(adapter.writes).toHaveLength(1);

      const [statements] = adapter.writes;
      expect(statements[0].sql).toContain('DELETE FROM');
      expect(statements[0].args).toBeUndefined();
      expect(statements).toHaveLength(3);
      expect(statements[1].sql).toContain('INSERT INTO');
      expect(statements[1].args).toHaveLength(6);
    }, 30000);
  });
});
