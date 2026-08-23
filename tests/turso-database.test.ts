/**
 * Integration suite for the `@tursodatabase/database` backend.
 *
 * Everything here runs against an in-process `:memory:` database. No Turso
 * Cloud account, URL, or auth token is involved, and nothing in this file
 * reaches the network.
 *
 * `@tursodatabase/database` ships prebuilt native binaries for a fixed set of
 * platforms only, so the whole suite is skipped — loudly — anywhere the module
 * cannot be loaded. See `docs/TURSO.md` for the platform list.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { createTable, indexContent, IndexingError } from '../src/indexer.js';
import {
  search,
  getAllArticles,
  getArticleBySlug,
  getArticlesByFolder,
  getFolders
} from '../src/search.js';
import { generateEmbedding } from '../src/embeddings.js';
import {
  tursoAdapter,
  type DatabaseAdapter,
  type TursoDatabase,
  type TursoStatement
} from '../src/turso.js';
import { resetHuggingFaceTransformersMock } from './huggingface-transformers.mock.js';

/** A connected handle, which additionally closes. */
type TursoConnection = TursoDatabase & { close(): void };
type Connect = (path: string) => Promise<TursoConnection>;

/**
 * Load the native module without letting an unsupported platform fail the run.
 *
 * The import is attempted rather than the platform being pattern-matched: a
 * hardcoded allow-list would have to guess about cases the package's own
 * documentation does not settle, notably musl-based Linux, and would go stale
 * the moment the package adds a target.
 */
let connect: Connect | undefined;
let loadFailure: string | undefined;

try {
  ({ connect } = (await import('@tursodatabase/database')) as unknown as { connect: Connect });
} catch (error) {
  loadFailure = error instanceof Error ? error.message : String(error);
}

if (connect === undefined) {
  // Deliberately loud. A silently skipped suite is indistinguishable from a
  // passing one, and this suite is the only coverage the Turso path has.
  console.warn(
    `\n[libsql-search] SKIPPING the @tursodatabase/database integration suite on ` +
      `${process.platform}-${process.arch}: the native module could not be loaded.\n` +
      `[libsql-search] Reason: ${loadFailure}\n` +
      `[libsql-search] Supported targets: darwin-arm64, linux-x64-gnu, linux-arm64-gnu, ` +
      `win32-x64-msvc. See docs/TURSO.md.\n`
  );
}

const describeTurso = connect === undefined ? describe.skip : describe;

describeTurso('turso database backend', () => {
  const testDir = join(process.cwd(), 'test-content-turso');
  let database: TursoConnection;
  let client: DatabaseAdapter;

  beforeEach(async () => {
    resetHuggingFaceTransformersMock();
    database = await connect!(':memory:');
    client = tursoAdapter(database);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    database.close();
    resetHuggingFaceTransformersMock();
  });

  async function query(sql: string, args?: unknown): Promise<Array<Record<string, unknown>>> {
    const statement = database.prepare(sql);
    return (await (args === undefined ? statement.all() : statement.all(args))) as Array<
      Record<string, unknown>
    >;
  }

  async function indexNames(): Promise<string[]> {
    const rows = await query(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='articles'"
    );
    return rows.map(row => row.name as string);
  }

  async function indexedTitles(): Promise<string[]> {
    const rows = await query('SELECT title FROM articles ORDER BY title');
    return rows.map(row => row.title as string);
  }

  /**
   * Insert a row directly, bypassing indexContent, so search and retrieval can
   * be exercised without a full rebuild.
   */
  async function insertTestArticle(data: {
    slug: string;
    title: string;
    content: string;
    folder?: string;
    tags?: string[];
  }): Promise<void> {
    const embedding = await generateEmbedding(data.content, {
      provider: 'local',
      dimensions: 384
    });

    await database
      .prepare(
        `INSERT INTO articles
         (slug, title, content, folder, tags, embedding, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, vector(?), datetime('now'), datetime('now'))`
      )
      .run([
        data.slug,
        data.title,
        data.content,
        data.folder ?? 'root',
        JSON.stringify(data.tags ?? []),
        JSON.stringify(embedding)
      ]);
  }

  describe('tursoAdapter', () => {
    it('should report the turso backend without vector index support', () => {
      expect(client.backend).toBe('turso');
      expect(client.supportsVectorIndex).toBe(false);
      expect(client.libsqlSearchAdapter).toBe(true);
    });

    it('should reject a handle that is not a database', () => {
      expect(() => tursoAdapter({} as TursoDatabase)).toThrow(TypeError);
      expect(() => tursoAdapter(null as unknown as TursoDatabase)).toThrow(TypeError);
    });

    it('should name the unawaited connect() mistake', () => {
      // connect() returns a Promise, and a Promise has neither exec nor
      // prepare, so this is the single most likely first-use error.
      const pending = connect!(':memory:') as unknown as TursoDatabase;

      expect(() => tursoAdapter(pending)).toThrow(/await/);
    });
  });

  describe('vector functions', () => {
    it('should support vector32 and vector_distance_cos', async () => {
      await database.exec('CREATE TABLE vectors (id INTEGER PRIMARY KEY, embedding F32_BLOB(4))');
      await database
        .prepare('INSERT INTO vectors (id, embedding) VALUES (?, vector32(?))')
        .run([1, JSON.stringify([1, 0, 0, 0])]);
      await database
        .prepare('INSERT INTO vectors (id, embedding) VALUES (?, vector32(?))')
        .run([2, JSON.stringify([0, 1, 0, 0])]);

      const rows = await query(
        `SELECT id, vector_distance_cos(embedding, vector32(?)) AS distance
         FROM vectors ORDER BY distance, id`,
        [JSON.stringify([1, 0, 0, 0])]
      );

      expect(rows.map(row => row.id)).toEqual([1, 2]);
      expect(rows[0].distance as number).toBeCloseTo(0, 6);
      // Orthogonal unit vectors are exactly one cosine distance apart
      expect(rows[1].distance as number).toBeCloseTo(1, 6);
    });

    it('should support vector() as an alias usable with the same distance function', async () => {
      await database.exec('CREATE TABLE aliased (id INTEGER PRIMARY KEY, embedding F32_BLOB(4))');
      await database
        .prepare('INSERT INTO aliased (id, embedding) VALUES (?, vector(?))')
        .run([1, JSON.stringify([0, 0, 1, 0])]);

      const rows = await query(
        'SELECT vector_distance_cos(embedding, vector(?)) AS distance FROM aliased',
        [JSON.stringify([0, 0, 1, 0])]
      );

      expect(rows[0].distance as number).toBeCloseTo(0, 6);
    });

    it('should return an unrun function from transaction(), not a transaction', async () => {
      // Pins the trap that makes the explicit BEGIN IMMEDIATE in the adapter
      // necessary. transaction() is better-sqlite3-style: it WRAPS fn and
      // returns it. `await db.transaction(fn)` therefore resolves to a function
      // and never runs fn -- no error, no rows, no clue. Rewriting
      // executeAtomicWrite() to use it would leave every other test in this
      // file passing while indexing silently did nothing.
      const handle = database as unknown as { transaction(fn: () => unknown): unknown };
      let ran = false;

      const returned = await handle.transaction(() => {
        ran = true;
      });

      expect(typeof returned).toBe('function');
      expect(ran).toBe(false);
    });

    it('should not provide libsql_vector_idx or vector_top_k', async () => {
      // Pins the capability flag to the backend's real behavior. If a future
      // Turso release adds either of these, this test fails and
      // supportsVectorIndex should be revisited rather than left false.
      await database.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, embedding F32_BLOB(4))');

      await expect(
        database.exec('CREATE INDEX probe_idx ON probe(libsql_vector_idx(embedding))')
      ).rejects.toThrow(/invalid expression in CREATE INDEX|libsql_vector_idx/i);

      await expect(
        query("SELECT * FROM vector_top_k('probe_idx', vector('[1,0,0,0]'), 3)")
      ).rejects.toThrow(/no such table:\s*vector_top_k/i);
    });
  });

  describe('createTable', () => {
    it('should create the articles table with the requested embedding width', async () => {
      await createTable(client, 'articles', 384);

      const rows = await query(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name='articles'"
      );

      expect(rows).toHaveLength(1);
      // Turso reprints the DDL from its own parser rather than storing the
      // original text, so the column type comes back as `F32_BLOB (384)`.
      // libSQL stores the statement verbatim. Match either spelling.
      expect(String(rows[0].sql)).toMatch(/embedding F32_BLOB\s*\(384\)/);
    });

    it('should create the folder and slug indexes', async () => {
      await createTable(client, 'articles', 384);

      const names = await indexNames();
      expect(names).toContain('articles_folder_idx');
      expect(names).toContain('articles_slug_idx');
    });

    it('should skip the vector index rather than failing on it', async () => {
      await createTable(client, 'articles', 384);

      // Turso cannot parse libsql_vector_idx(), so createTable must not attempt
      // it. The absence of the index here is the whole reason search on this
      // backend runs the exact scan.
      expect(await indexNames()).not.toContain('articles_embedding_idx');
    });

    it('should be idempotent', async () => {
      await createTable(client);
      await createTable(client);

      const rows = await query(
        "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name='articles'"
      );
      expect(Number(rows[0].count)).toBe(1);
    });

    it('should reject an invalid table name before touching the database', async () => {
      await expect(createTable(client, 'articles; DROP TABLE users')).rejects.toThrow(
        'Invalid SQL tableName'
      );
    });
  });

  describe('indexContent', () => {
    it('should index markdown files into the table', async () => {
      await createTable(client);
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\ntags: [a, b]\n---\nContent A');
      await writeFile(join(testDir, 'beta.md'), '---\ntitle: Beta\n---\nContent B');

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.replaced).toBe(true);
      expect(result.partial).toBe(false);
      expect(await indexedTitles()).toEqual(['Alpha', 'Beta']);
    }, 30000);

    it('should store an embedding that vector_distance_cos can read back', async () => {
      await createTable(client);
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nTypeScript');

      await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      const embedding = await generateEmbedding('TypeScript', {
        provider: 'local',
        dimensions: 384
      });

      const rows = await query(
        'SELECT vector_distance_cos(embedding, vector32(?)) AS distance FROM articles',
        [JSON.stringify(embedding)]
      );

      expect(rows[0].distance as number).toBeCloseTo(0, 5);
    }, 30000);

    it('should replace the previous contents on a successful rebuild', async () => {
      await createTable(client);
      await writeFile(join(testDir, 'first.md'), '---\ntitle: First\n---\nContent');
      await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      await rm(join(testDir, 'first.md'));
      await writeFile(join(testDir, 'second.md'), '---\ntitle: Second\n---\nContent');
      await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(await indexedTitles()).toEqual(['Second']);
    }, 30000);

    it('should leave the previous index intact when the replacement fails', async () => {
      // The Turso mirror of the libSQL rollback test. This is the #24 guarantee
      // and the single most important behavior on this backend, because Turso's
      // batch() is not transactional — using it here would leave the delete and
      // the successful inserts committed.
      await createTable(client);
      await writeFile(join(testDir, 'first.md'), '---\ntitle: First\n---\nContent');
      await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      await rm(join(testDir, 'first.md'));
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nContent');
      await writeFile(join(testDir, 'beta.md'), '---\ntitle: Beta\n---\nContent');

      const failing = tursoAdapter(createFailingTursoDatabase(database));

      const error = await captureError(() =>
        indexContent({
          client: failing,
          contentPath: testDir,
          embeddingOptions: { provider: 'local', dimensions: 384 }
        })
      );

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('replace');
      expect((indexingError.cause as Error).message).toContain('UNIQUE constraint failed');

      // The delete and the first insert were rolled back with the failure
      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should normalize a non-Error database failure on the replace path', async () => {
      await createTable(client);
      await writeFile(join(testDir, 'first.md'), '---\ntitle: First\n---\nContent');
      await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      await rm(join(testDir, 'first.md'));
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nContent');

      const rejecting = tursoAdapter(createRejectingTursoDatabase(database, 'database exploded'));

      const error = await captureError(() =>
        indexContent({
          client: rejecting,
          contentPath: testDir,
          embeddingOptions: { provider: 'local', dimensions: 384 }
        })
      );

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('replace');
      expect(indexingError.cause).toBeInstanceOf(Error);
      expect((indexingError.cause as Error).message).toBe('database exploded');
      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should replace inside an explicit transaction and never call batch()', async () => {
      // Turso exposes a batch() method, and it is NOT atomic. Pinning this
      // stops a future refactor from reaching for the familiar libSQL
      // primitive and silently losing the rollback guarantee above.
      await createTable(client);
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nContent');

      const executed: string[] = [];
      const batchCalls: unknown[] = [];
      const recording = {
        exec: (sql: string) => {
          executed.push(sql);
          return database.exec(sql);
        },
        prepare: (sql: string) => database.prepare(sql),
        batch: (...args: unknown[]) => {
          batchCalls.push(args);
          throw new Error('batch() must not be used: it is not transactional on Turso');
        }
      };

      await indexContent({
        client: tursoAdapter(recording),
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(batchCalls).toHaveLength(0);
      expect(executed).toContain('BEGIN IMMEDIATE');
      expect(executed).toContain('COMMIT');
      expect(executed).not.toContain('ROLLBACK');
    }, 30000);

    it('should prepare each distinct statement once regardless of row count', async () => {
      // A rebuild is one DELETE plus N identical INSERTs. Preparing per row
      // would scale prepares with the corpus for no benefit.
      await createTable(client);

      for (let i = 0; i < 5; i++) {
        await writeFile(join(testDir, `doc-${i}.md`), `---\ntitle: Doc ${i}\n---\nContent`);
      }

      const prepared: string[] = [];
      const recording = {
        exec: (sql: string) => database.exec(sql),
        prepare: (sql: string) => {
          prepared.push(sql);
          return database.prepare(sql);
        }
      };

      const result = await indexContent({
        client: tursoAdapter(recording),
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(result.success).toBe(5);
      expect(prepared).toHaveLength(2);
      expect(new Set(prepared).size).toBe(2);
      expect(await indexedTitles()).toHaveLength(5);
    }, 30000);

    it('should roll back explicitly when a statement inside the transaction fails', async () => {
      await createTable(client);
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nContent');
      await writeFile(join(testDir, 'beta.md'), '---\ntitle: Beta\n---\nContent');

      const executed: string[] = [];
      const failing = createFailingTursoDatabase(database);
      const recording = {
        exec: (sql: string) => {
          executed.push(sql);
          return failing.exec(sql);
        },
        prepare: (sql: string) => failing.prepare(sql)
      };

      await captureError(() =>
        indexContent({
          client: tursoAdapter(recording),
          contentPath: testDir,
          embeddingOptions: { provider: 'local', dimensions: 384 }
        })
      );

      expect(executed).toContain('BEGIN IMMEDIATE');
      expect(executed).toContain('ROLLBACK');
      expect(executed).not.toContain('COMMIT');
    }, 30000);
  });

  describe('statement lifetime against the real driver', () => {
    /**
     * Wrap the real handle so every statement it hands out reports its own
     * close, while still being a genuine native statement.
     *
     * The stub-based assertions in tests/database.test.ts prove the adapter
     * calls close(). This proves the real driver's statements actually accept
     * it on the paths users take, including inside an open transaction.
     */
    function createCloseTrackingHandle(): { handle: TursoDatabase; closed: number } {
      const tracker = { closed: 0 };

      const handle: TursoDatabase = {
        exec: (sql: string) => database.exec(sql),
        prepare: (sql: string): TursoStatement => {
          const statement = database.prepare(sql) as TursoStatement & { close?(): unknown };

          return {
            run: (args?: unknown) => (args === undefined ? statement.run() : statement.run(args)),
            all: (args?: unknown) => (args === undefined ? statement.all() : statement.all(args)),
            close: () => {
              tracker.closed += 1;
              return statement.close?.();
            }
          };
        }
      };

      return {
        handle,
        get closed() {
          return tracker.closed;
        }
      };
    }

    it('should close the statement behind a real search()', async () => {
      await createTable(client);
      await insertTestArticle({ slug: 'a', title: 'A', content: 'TypeScript' });

      const tracking = createCloseTrackingHandle();

      await search({
        client: tursoAdapter(tracking.handle),
        query: 'TypeScript',
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      // search() issues exactly one query, so one prepare and one close. An SSR
      // site calls this per request; leaking here grows the process without
      // bound.
      expect(tracking.closed).toBe(1);
    }, 30000);

    it('should close the statements behind a real retrieval helper', async () => {
      await createTable(client);
      await insertTestArticle({ slug: 'a', title: 'A', content: 'TypeScript' });

      const tracking = createCloseTrackingHandle();
      const folders = await getFolders(tursoAdapter(tracking.handle));

      expect(folders).toEqual(['root']);
      expect(tracking.closed).toBe(1);
    }, 30000);

    it('should close real statements after a committed rebuild', async () => {
      await createTable(client);
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nContent');
      await writeFile(join(testDir, 'beta.md'), '---\ntitle: Beta\n---\nContent');

      const tracking = createCloseTrackingHandle();

      await indexContent({
        client: tursoAdapter(tracking.handle),
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      // One DELETE plus one cached INSERT, both closed after COMMIT. Closing a
      // statement bound to a transaction that already committed is safe; the
      // committed rows below prove the close did not disturb the write.
      expect(tracking.closed).toBe(2);
      expect(await indexedTitles()).toEqual(['Alpha', 'Beta']);
    }, 30000);

    it('should survive repeated queries on one handle', async () => {
      // The leak this guards is linear in call count, so the shape that catches
      // it is a loop on a single long-lived handle -- exactly what a server
      // does, and what every other test in this file avoids by tearing the
      // handle down immediately.
      await createTable(client);
      await insertTestArticle({ slug: 'a', title: 'A', content: 'TypeScript' });

      const tracking = createCloseTrackingHandle();
      const tracked = tursoAdapter(tracking.handle);

      for (let i = 0; i < 250; i++) {
        const folders = await getFolders(tracked);
        expect(folders).toEqual(['root']);
      }

      expect(tracking.closed).toBe(250);
    }, 30000);
  });

  describe('search', () => {
    beforeEach(async () => {
      await createTable(client);
    });

    it('should rank results by cosine distance without exact: true', async () => {
      await insertTestArticle({
        slug: 'exact-match',
        title: 'TypeScript Guide',
        content: 'TypeScript programming'
      });
      await insertTestArticle({
        slug: 'unrelated',
        title: 'Python Basics',
        content: 'Python'
      });

      const results = await search({
        client,
        query: 'TypeScript programming',
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(results.map(result => result.slug)).toEqual(['exact-match', 'unrelated']);
      expect(results[0].distance).toBeLessThan(results[1].distance);
    }, 30000);

    it('should take the exact path automatically, never issuing vector_top_k', async () => {
      await insertTestArticle({
        slug: 'article-1',
        title: 'Article 1',
        content: 'JavaScript programming'
      });

      const prepared: string[] = [];
      const recording = {
        exec: (sql: string) => database.exec(sql),
        prepare: (sql: string) => {
          prepared.push(sql);
          return database.prepare(sql);
        }
      };

      await search({
        client: tursoAdapter(recording),
        query: 'JavaScript',
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(prepared).toHaveLength(1);
      expect(prepared[0]).not.toContain('vector_top_k');
      expect(prepared[0]).toContain('embedding IS NOT NULL');
    }, 30000);

    it('should honor limit', async () => {
      await insertTestArticle({ slug: 'a', title: 'A', content: 'TypeScript' });
      await insertTestArticle({ slug: 'b', title: 'B', content: 'Python' });
      await insertTestArticle({ slug: 'c', title: 'C', content: 'React' });

      const results = await search({
        client,
        query: 'TypeScript',
        limit: 2,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(results).toHaveLength(2);
    }, 30000);

    it('should still validate candidates even though the index path is unreachable', async () => {
      await expect(
        search({
          client,
          query: 'TypeScript',
          limit: 10,
          candidates: 5,
          embeddingOptions: { provider: 'local', dimensions: 384 }
        })
      ).rejects.toThrow('Invalid search candidates');
    }, 30000);

    it('should parse tags back out of the stored JSON', async () => {
      await insertTestArticle({
        slug: 'tagged',
        title: 'Tagged',
        content: 'TypeScript',
        tags: ['ts', 'guide']
      });

      const results = await search({
        client,
        query: 'TypeScript',
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(results[0].tags).toEqual(['ts', 'guide']);
      expect(typeof results[0].created_at).toBe('string');
    }, 30000);
  });

  describe('retrieval helpers', () => {
    beforeEach(async () => {
      await createTable(client);
      await insertTestArticle({
        slug: 'guides/typescript',
        title: 'TypeScript',
        content: 'TypeScript',
        folder: 'guides',
        tags: ['ts']
      });
      await insertTestArticle({
        slug: 'guides/python',
        title: 'Python',
        content: 'Python',
        folder: 'guides'
      });
      await insertTestArticle({
        slug: 'notes/react',
        title: 'React',
        content: 'React',
        folder: 'notes'
      });
    }, 30000);

    it('should return every article from getAllArticles', async () => {
      const articles = await getAllArticles(client);

      expect(articles.map(article => article.title)).toEqual(['Python', 'React', 'TypeScript']);
      expect(articles[2].tags).toEqual(['ts']);
    });

    it('should return one article from getArticleBySlug', async () => {
      const article = await getArticleBySlug(client, 'guides/typescript');

      expect(article).not.toBeNull();
      expect(article!.title).toBe('TypeScript');
      expect(article!.folder).toBe('guides');
      expect(article!.tags).toEqual(['ts']);
    });

    it('should return null from getArticleBySlug for an unknown slug', async () => {
      expect(await getArticleBySlug(client, 'nope')).toBeNull();
    });

    it('should filter by folder in getArticlesByFolder', async () => {
      const articles = await getArticlesByFolder(client, 'guides');

      expect(articles.map(article => article.title)).toEqual(['Python', 'TypeScript']);
    });

    it('should list distinct folders from getFolders', async () => {
      expect(await getFolders(client)).toEqual(['guides', 'notes']);
    });
  });
});

/**
 * Wrap a handle so the second INSERT inside the replacement transaction replays
 * the first document's arguments.
 *
 * The unique slug column then rejects it with a real database error, after the
 * delete and one insert have already been applied — which is exactly the state
 * a non-atomic write would leave behind, and exactly what the transaction must
 * undo.
 */
function createFailingTursoDatabase(base: TursoDatabase): TursoDatabase {
  let firstInsertArgs: unknown;

  return {
    exec: (sql: string) => base.exec(sql),
    prepare: (sql: string): TursoStatement => {
      const statement = base.prepare(sql);

      if (!sql.includes('INSERT')) {
        return statement;
      }

      return {
        all: (args?: unknown) => (args === undefined ? statement.all() : statement.all(args)),
        run: (args?: unknown) => {
          if (firstInsertArgs === undefined) {
            firstInsertArgs = args;
            return statement.run(args);
          }

          return statement.run(firstInsertArgs);
        }
      };
    }
  };
}

/** Wrap a handle so the replacement rejects with a value that is not an Error. */
function createRejectingTursoDatabase(base: TursoDatabase, rejection: unknown): TursoDatabase {
  return {
    exec: (sql: string) => base.exec(sql),
    prepare: (sql: string): TursoStatement => {
      if (!sql.includes('INSERT')) {
        return base.prepare(sql);
      }

      return {
        all: () => Promise.reject(rejection),
        run: () => Promise.reject(rejection)
      };
    }
  };
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }

  throw new Error('Expected the call to reject, but it resolved');
}
