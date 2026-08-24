import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { mkdir, writeFile, rm, symlink } from 'fs/promises';
import { join } from 'path';
import { createTable, indexContent, IndexingError } from '../src/indexer.js';
import {
  huggingFaceTransformersMock,
  resetHuggingFaceTransformersMock
} from './huggingface-transformers.mock.js';

type BatchStatement = string | { sql: string; args?: unknown };

/**
 * Wraps a client so the replacement batch hits a real database error after the
 * delete and the first inserts have already been applied. Repeating an insert
 * violates the unique slug constraint, so the failure exercises the real
 * rollback path rather than a mocked one.
 */
function createFailingBatchClient(base: Client): Client {
  const bind = (target: object, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop);
    return typeof value === 'function' ? value.bind(target) : value;
  };

  return new Proxy(base, {
    get(target, prop) {
      if (prop !== 'batch') {
        return bind(target, prop);
      }

      return async (statements: BatchStatement[], mode?: string) => {
        const inserts = statements.filter(statement =>
          typeof statement !== 'string' && statement.sql.includes('INSERT')
        );

        expect(inserts.length).toBeGreaterThan(0);

        return (target.batch as (stmts: unknown, mode?: unknown) => Promise<unknown>)(
          [...statements, inserts[0]],
          mode
        );
      };
    }
  }) as Client;
}

/**
 * Wraps a client so the replacement batch rejects with the given value, which
 * is deliberately not an Error.
 */
function createRejectingBatchClient(base: Client, rejection: unknown): Client {
  return new Proxy(base, {
    get(target, prop) {
      if (prop !== 'batch') {
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }

      return async () => {
        throw rejection;
      };
    }
  }) as Client;
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }

  throw new Error('Expected the call to reject, but it resolved');
}

describe('indexer', () => {
  const testDbUrl = ':memory:';
  let client: ReturnType<typeof createClient>;
  const testDir = join(process.cwd(), 'test-content');

  beforeEach(async () => {
    client = createClient({ url: testDbUrl });
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    resetHuggingFaceTransformersMock();
    vi.unstubAllGlobals();
  });

  describe('createTable', () => {
    it('should create articles table with correct schema', async () => {
      await createTable(client);

      const result = await client.execute(`
        SELECT name, sql FROM sqlite_master
        WHERE type='table' AND name='articles'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('articles');
      expect(result.rows[0].sql).toContain('embedding F32_BLOB(384)');
    });

    it('should create indexes', async () => {
      await createTable(client, 'articles', 384);

      const result = await client.execute(`
        SELECT name FROM sqlite_master
        WHERE type='index' AND tbl_name='articles'
      `);

      const indexNames = result.rows.map(row => row.name);
      expect(indexNames).toContain('articles_slug_idx');
      expect(indexNames).toContain('articles_folder_idx');
    });

    it('should be idempotent (can be called multiple times)', async () => {
      await createTable(client);
      await createTable(client);

      const result = await client.execute(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='articles'
      `);

      expect(result.rows).toHaveLength(1);
    });
  });

  describe('indexContent', () => {
    beforeEach(async () => {
      await createTable(client);
    });

    it('should index markdown files', async () => {
      await writeFile(
        join(testDir, 'test.md'),
        '---\ntitle: Test Article\ntags: [test, demo]\n---\n\nTest content'
      );

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.total).toBe(1);
      expect(result.replaced).toBe(true);
      expect(result.partial).toBe(false);
      expect(result.failures).toEqual([]);

      const articles = await client.execute('SELECT * FROM articles');
      expect(articles.rows).toHaveLength(1);
      expect(articles.rows[0].title).toBe('Test Article');
    }, 30000);

    it('should handle nested directories', async () => {
      await mkdir(join(testDir, 'nested'), { recursive: true });
      await writeFile(
        join(testDir, 'nested', 'nested.md'),
        '---\ntitle: Nested Article\n---\n\nNested content'
      );

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(result.success).toBe(1);

      const articles = await client.execute('SELECT * FROM articles');
      expect(articles.rows[0].folder).toBe('nested');
    }, 30000);

    it('should generate slug from file path', async () => {
      await writeFile(
        join(testDir, 'my-article.md'),
        '---\ntitle: My Article\n---\n\nContent'
      );

      await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      const articles = await client.execute('SELECT * FROM articles');
      expect(articles.rows[0].slug).toBe('my-article');
    }, 30000);

    it('should parse tags from frontmatter', async () => {
      await writeFile(
        join(testDir, 'tagged.md'),
        '---\ntitle: Tagged Article\ntags: [tag1, tag2, tag3]\n---\n\nContent'
      );

      await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      const articles = await client.execute('SELECT * FROM articles');
      const tags = JSON.parse(articles.rows[0].tags as string);
      expect(tags).toEqual(['tag1', 'tag2', 'tag3']);
    }, 30000);

    it('should handle files without frontmatter', async () => {
      await writeFile(join(testDir, 'no-frontmatter.md'), 'Just content');

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(result.success).toBe(1);

      const articles = await client.execute('SELECT * FROM articles');
      expect(articles.rows[0].title).toBe('no frontmatter');
    }, 30000);

    it('should clear existing content before indexing', async () => {
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

      const articles = await client.execute('SELECT * FROM articles');
      expect(articles.rows).toHaveLength(1);
      expect(articles.rows[0].title).toBe('Second');
    }, 30000);

    it('should exclude specified directories', async () => {
      await mkdir(join(testDir, 'node_modules'), { recursive: true });
      await writeFile(
        join(testDir, 'node_modules', 'excluded.md'),
        '---\ntitle: Excluded\n---\nContent'
      );

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 },
        allowEmptyIndex: true
      });

      expect(result.total).toBe(0);
    });

    it('should call onProgress callback', async () => {
      await writeFile(join(testDir, 'test.md'), '---\ntitle: Test\n---\nContent');

      const progressCalls: Array<{ current: number; total: number; file: string }> = [];

      await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 },
        onProgress: (current, total, file) => {
          progressCalls.push({ current, total, file });
        }
      });

      expect(progressCalls).toHaveLength(1);
      expect(progressCalls[0]).toEqual({
        current: 1,
        total: 1,
        file: 'test.md'
      });
    }, 30000);

    it('should throw for an empty directory by default', async () => {
      const error = await captureError(() => indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      expect((error as IndexingError).phase).toBe('build');
      expect((error as IndexingError).message).toContain('No source files found');
      expect((error as IndexingError).message).toContain('allowEmptyIndex');
    });
  });

  describe('indexContent atomicity', () => {
    beforeEach(async () => {
      await createTable(client);
    });

    async function seedIndex(): Promise<void> {
      await writeFile(join(testDir, 'first.md'), '---\ntitle: First\n---\nContent');

      await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      await rm(join(testDir, 'first.md'));
    }

    async function indexedTitles(): Promise<string[]> {
      const articles = await client.execute('SELECT title FROM articles ORDER BY title');
      return articles.rows.map(row => row.title as string);
    }

    it('should keep stale rows when the source directory becomes empty', async () => {
      await seedIndex();

      const error = await captureError(() => indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should empty the index when allowEmptyIndex is true', async () => {
      await seedIndex();

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 },
        allowEmptyIndex: true
      });

      expect(result).toEqual({
        success: 0,
        failed: 0,
        total: 0,
        replaced: true,
        partial: false,
        failures: []
      });
      expect(await indexedTitles()).toEqual([]);
    }, 30000);

    it('should abort and preserve the index when the provider fails', async () => {
      await seedIndex();
      await writeFile(join(testDir, 'second.md'), '---\ntitle: Second\n---\nContent');

      huggingFaceTransformersMock.model.mockRejectedValueOnce(new Error('provider unavailable'));

      const error = await captureError(() => indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('build');
      expect(indexingError.failures).toHaveLength(1);
      expect(indexingError.failures[0].file).toBe('second.md');
      expect(indexingError.failures[0].stage).toBe('embed');
      expect((indexingError.cause as Error).message).toContain('provider unavailable');

      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should abort and preserve the index when frontmatter cannot be parsed', async () => {
      await seedIndex();
      await writeFile(join(testDir, 'broken.md'), '---\ntitle: [unclosed\n---\nContent');

      const error = await captureError(() => indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('build');
      expect(indexingError.failures[0].file).toBe('broken.md');
      expect(indexingError.failures[0].stage).toBe('parse');
      expect(indexingError.cause).toBeInstanceOf(Error);

      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should abort and preserve the index when a file cannot be read', async () => {
      await seedIndex();
      await symlink('./does-not-exist.md', join(testDir, 'dangling.md'));

      const error = await captureError(() => indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('build');
      expect(indexingError.failures[0].file).toBe('dangling.md');
      expect(indexingError.failures[0].stage).toBe('read');

      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should rebuild from survivors when failurePolicy is skip', async () => {
      await seedIndex();
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nContent');
      await writeFile(join(testDir, 'beta.md'), '---\ntitle: Beta\n---\nContent');

      huggingFaceTransformersMock.model.mockRejectedValueOnce(new Error('provider unavailable'));

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 },
        failurePolicy: 'skip'
      });

      expect(result.total).toBe(2);
      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.replaced).toBe(true);
      expect(result.partial).toBe(true);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].stage).toBe('embed');

      const skippedTitle = result.failures[0].file === 'alpha.md' ? 'Alpha' : 'Beta';
      const titles = await indexedTitles();
      expect(titles).toHaveLength(1);
      expect(titles).not.toContain(skippedTitle);
      expect(titles).not.toContain('First');
    }, 30000);

    it('should not replace the index when every file fails under skip', async () => {
      await seedIndex();
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nContent');
      await writeFile(join(testDir, 'beta.md'), '---\ntitle: Beta\n---\nContent');

      huggingFaceTransformersMock.model.mockRejectedValueOnce(new Error('provider unavailable'));
      huggingFaceTransformersMock.model.mockRejectedValueOnce(new Error('provider unavailable'));

      const error = await captureError(() => indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 },
        failurePolicy: 'skip'
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('build');
      expect(indexingError.failures).toHaveLength(2);

      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should roll back and preserve the index when the database fails', async () => {
      await seedIndex();
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nContent');
      await writeFile(join(testDir, 'beta.md'), '---\ntitle: Beta\n---\nContent');

      const failingClient = createFailingBatchClient(client);

      const error = await captureError(() => indexContent({
        client: failingClient,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('replace');
      expect((indexingError.cause as Error).message).toContain('UNIQUE constraint failed');

      // The delete and the successful inserts were rolled back with the failure
      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should normalize a non-Error database failure and name itself', async () => {
      await seedIndex();
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nContent');

      const rejectingClient = createRejectingBatchClient(client, 'database exploded');

      const error = await captureError(() => indexContent({
        client: rejectingClient,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.name).toBe('IndexingError');
      expect(indexingError.phase).toBe('replace');
      expect(indexingError.cause).toBeInstanceOf(Error);
      expect((indexingError.cause as Error).message).toBe('database exploded');

      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    // The normalization here happens in embeddings.ts, which wraps every
    // provider rejection via providerError(); this is not toError() coverage
    it('should record a normalized Error when the provider rejects with a non-Error', async () => {
      await seedIndex();
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nContent');

      huggingFaceTransformersMock.model.mockRejectedValueOnce('provider down');

      const error = await captureError(() => indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.name).toBe('IndexingError');
      expect(indexingError.failures[0].error).toBeInstanceOf(Error);
      expect(indexingError.failures[0].error.message).toContain('provider down');

      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should wrap a missing content directory as a build failure', async () => {
      await seedIndex();

      const error = await captureError(() => indexContent({
        client,
        contentPath: join(testDir, 'does-not-exist'),
        embeddingOptions: { provider: 'local', dimensions: 384 }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('build');
      expect(indexingError.failures).toEqual([]);
      expect((indexingError.cause as Error).message).toContain('ENOENT');

      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should throw when every file fails even with allowEmptyIndex', async () => {
      await seedIndex();
      await writeFile(join(testDir, 'alpha.md'), '---\ntitle: Alpha\n---\nContent');
      await writeFile(join(testDir, 'beta.md'), '---\ntitle: Beta\n---\nContent');

      huggingFaceTransformersMock.model.mockRejectedValueOnce(new Error('provider unavailable'));
      huggingFaceTransformersMock.model.mockRejectedValueOnce(new Error('provider unavailable'));

      const error = await captureError(() => indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 },
        failurePolicy: 'skip',
        allowEmptyIndex: true
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('build');
      expect(indexingError.failures).toHaveLength(2);

      // allowEmptyIndex covers an empty source set, never a fully failed one
      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);
  });

  describe('indexContent content defects', () => {
    beforeEach(async () => {
      await createTable(client);
      await writeFile(join(testDir, 'first.md'), '---\ntitle: First\n---\nContent');

      await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      await rm(join(testDir, 'first.md'));
    }, 30000);

    async function indexedTitles(): Promise<string[]> {
      const articles = await client.execute('SELECT title FROM articles ORDER BY title');
      return articles.rows.map(row => row.title as string);
    }

    it('should treat a list-valued frontmatter title as a parse failure', async () => {
      await writeFile(join(testDir, 'listed.md'), '---\ntitle:\n  - a\n  - b\n---\nContent');

      const error = await captureError(() => indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('build');
      expect(indexingError.failures).toHaveLength(1);
      expect(indexingError.failures[0].file).toBe('listed.md');
      expect(indexingError.failures[0].stage).toBe('parse');
      expect(indexingError.message).toContain('listed.md');

      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should skip a list-valued frontmatter title under skip policy', async () => {
      await writeFile(join(testDir, 'listed.md'), '---\ntitle:\n  - a\n  - b\n---\nContent');
      await writeFile(join(testDir, 'valid.md'), '---\ntitle: Valid\n---\nContent');

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 },
        failurePolicy: 'skip'
      });

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.partial).toBe(true);
      expect(result.failures[0].file).toBe('listed.md');

      expect(await indexedTitles()).toEqual(['Valid']);
    }, 30000);

    it('should treat an unserializable embedding as an embed failure', async () => {
      await writeFile(join(testDir, 'broken.md'), '---\ntitle: Broken\n---\nContent');

      const embedding = new Array(384).fill(1);
      const circular: { self?: unknown } = {};
      circular.self = circular;
      Object.defineProperty(embedding, 'toJSON', { value: () => circular });

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ data: [{ index: 0, embedding }] })
      }));

      const error = await captureError(() => indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: {
          provider: 'openai-compatible',
          baseUrl: 'https://example.com/v1',
          model: 'test-model',
          dimensions: 384
        }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('build');
      expect(indexingError.failures).toHaveLength(1);
      expect(indexingError.failures[0].file).toBe('broken.md');
      expect(indexingError.failures[0].stage).toBe('embed');
      expect(indexingError.failures[0].error.message).toContain('circular');

      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should skip an unserializable embedding under skip policy', async () => {
      await writeFile(join(testDir, 'broken.md'), '---\ntitle: Broken\n---\nContent');
      await writeFile(join(testDir, 'valid.md'), '---\ntitle: Valid\n---\nContent');

      const embedding = new Array(384).fill(1);
      const circular: { self?: unknown } = {};
      circular.self = circular;
      Object.defineProperty(embedding, 'toJSON', { value: () => circular });

      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers(),
          json: async () => ({ data: [{ index: 0, embedding }] })
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers(),
          json: async () => ({
            data: [{ index: 0, embedding: new Array(384).fill(1) }]
          })
        });
      vi.stubGlobal('fetch', fetchMock);

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: {
          provider: 'openai-compatible',
          baseUrl: 'https://example.com/v1',
          model: 'test-model',
          dimensions: 384
        },
        failurePolicy: 'skip'
      });

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.partial).toBe(true);
      expect(result.failures[0].file).toBe('broken.md');
      expect(result.failures[0].stage).toBe('embed');

      expect(await indexedTitles()).toEqual(['Valid']);
    }, 30000);

    it('should accept scalar frontmatter titles', async () => {
      await writeFile(join(testDir, 'numeric.md'), '---\ntitle: 2024\n---\nContent');

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(result.success).toBe(1);
      expect(await indexedTitles()).toEqual(['2024']);
    }, 30000);

    it('should treat unserializable tags as a parse failure', async () => {
      // A YAML anchor referencing its own sequence yields a self-referencing
      // array that Array.isArray accepts and tags.join() tolerates
      await writeFile(join(testDir, 'anchored.md'), '---\ntags: &t\n  - *t\n---\nContent');

      const error = await captureError(() => indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('build');
      expect(indexingError.failures).toHaveLength(1);
      expect(indexingError.failures[0].file).toBe('anchored.md');
      expect(indexingError.failures[0].stage).toBe('parse');

      // Pins the failure to tag serialization rather than an incidental YAML error
      expect(indexingError.failures[0].error.message).toContain('circular');

      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should skip unserializable tags under skip policy', async () => {
      await writeFile(join(testDir, 'anchored.md'), '---\ntags: &t\n  - *t\n---\nContent');
      await writeFile(join(testDir, 'valid.md'), '---\ntitle: Valid\n---\nContent');

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 },
        failurePolicy: 'skip'
      });

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.failures[0].file).toBe('anchored.md');
      expect(result.failures[0].stage).toBe('parse');

      expect(await indexedTitles()).toEqual(['Valid']);
    }, 30000);

    it('should accept a date frontmatter title', async () => {
      // Unquoted ISO dates are parsed into Date objects by the YAML loader
      await writeFile(join(testDir, 'dated.md'), '---\ntitle: 2024-01-01\n---\nContent');

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(result.success).toBe(1);
      expect(await indexedTitles()).toEqual(['2024-01-01T00:00:00.000Z']);
    }, 30000);

    it('should report colliding slugs as a build failure', async () => {
      await writeFile(join(testDir, 'foo.md'), '---\ntitle: Md\n---\nContent');
      await writeFile(join(testDir, 'foo.markdown'), '---\ntitle: Markdown\n---\nContent');

      const error = await captureError(() => indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      }));

      expect(error).toBeInstanceOf(IndexingError);
      const indexingError = error as IndexingError;
      expect(indexingError.phase).toBe('build');
      expect(indexingError.failures).toHaveLength(1);
      expect(indexingError.failures[0].stage).toBe('parse');

      // Sorted path order is what decides the winner: foo.markdown sorts first
      expect(indexingError.failures[0].file).toBe('foo.md');
      expect(indexingError.message).toContain('foo.md');
      expect(indexingError.message).toContain('foo.markdown');

      expect(await indexedTitles()).toEqual(['First']);
    }, 30000);

    it('should keep the first colliding slug under skip policy', async () => {
      await writeFile(join(testDir, 'foo.md'), '---\ntitle: Md\n---\nContent');
      await writeFile(join(testDir, 'foo.markdown'), '---\ntitle: Markdown\n---\nContent');

      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 384 },
        failurePolicy: 'skip'
      });

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.failures[0].file).toBe('foo.md');

      expect(await indexedTitles()).toEqual(['Markdown']);
    }, 30000);
  });
});
