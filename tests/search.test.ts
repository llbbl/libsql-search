import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createClient } from '@libsql/client';
import { createTable } from '../src/indexer.js';
import {
  search,
  getAllArticles,
  getArticleBySlug,
  getArticlesByFolder,
  getFolders,
  MAX_SEARCH_CANDIDATES
} from '../src/search.js';
import { generateEmbedding } from '../src/embeddings.js';
import {
  huggingFaceTransformersMock,
  resetHuggingFaceTransformersMock
} from './huggingface-transformers.mock.js';

describe('search', () => {
  const testDbUrl = ':memory:';
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    resetHuggingFaceTransformersMock();
    client = createClient({ url: testDbUrl });
    await createTable(client);
  });

  /**
   * Build a unit vector with a single non-zero component. Two such vectors on
   * different axes are orthogonal, so their cosine distance is exactly 1.
   */
  function unitVector(axis: number): number[] {
    const vector = new Array(384).fill(0);
    vector[axis] = 1;
    return vector;
  }

  /**
   * Insert a row whose stored embedding is an exact vector rather than one
   * derived from its text, so distances can be made to tie deliberately.
   */
  async function insertArticleWithVector(slug: string, vector: number[]): Promise<void> {
    huggingFaceTransformersMock.queuedVectors.push(vector);

    await insertTestArticle({
      slug,
      title: slug,
      content: slug
    });
  }

  async function insertTestArticle(data: {
    slug: string;
    title: string;
    content: string;
    folder?: string;
    tags?: string[];
  }) {
    const embedding = await generateEmbedding(data.content, {
      provider: 'local',
      dimensions: 384
    });

    await client.execute({
      sql: `INSERT INTO articles
            (slug, title, content, folder, tags, embedding, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, vector(?), datetime('now'), datetime('now'))`,
      args: [
        data.slug,
        data.title,
        data.content,
        data.folder || 'root',
        JSON.stringify(data.tags || []),
        JSON.stringify(embedding)
      ]
    });
  }

  describe('search', () => {
    it('should find semantically similar articles', async () => {
      await insertTestArticle({
        slug: 'astro-guide',
        title: 'Astro Guide',
        content: 'Learn how to build with Astro static site generator'
      });

      await insertTestArticle({
        slug: 'react-tutorial',
        title: 'React Tutorial',
        content: 'Learn React components and hooks'
      });

      const results = await search({
        client,
        query: 'static site building',
        limit: 5,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(results).toHaveLength(2);
      expect(results[0].slug).toBe('astro-guide');
      expect(results[0]).toHaveProperty('distance');
      expect(typeof results[0].distance).toBe('number');
    }, 30000);

    it('should limit results', async () => {
      await insertTestArticle({
        slug: 'article-1',
        title: 'Article 1',
        content: 'JavaScript programming'
      });

      await insertTestArticle({
        slug: 'article-2',
        title: 'Article 2',
        content: 'JavaScript development'
      });

      await insertTestArticle({
        slug: 'article-3',
        title: 'Article 3',
        content: 'JavaScript coding'
      });

      const results = await search({
        client,
        query: 'JavaScript',
        limit: 2,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(results).toHaveLength(2);
    }, 30000);

    it('should order results by distance (ascending)', async () => {
      await insertTestArticle({
        slug: 'exact-match',
        title: 'TypeScript',
        content: 'TypeScript is a typed superset of JavaScript'
      });

      await insertTestArticle({
        slug: 'partial-match',
        title: 'Python',
        content: 'Python is a programming language'
      });

      const results = await search({
        client,
        query: 'TypeScript programming',
        limit: 5,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(results[0].slug).toBe('exact-match');
      expect(results[0].distance).toBeLessThan(results[1].distance);
    }, 30000);

    it('should parse tags from JSON', async () => {
      await insertTestArticle({
        slug: 'tagged-article',
        title: 'Tagged Article',
        content: 'Article with tags',
        tags: ['tag1', 'tag2']
      });

      const results = await search({
        client,
        query: 'article',
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(results[0].tags).toEqual(['tag1', 'tag2']);
    }, 30000);

    it('should return empty array when no articles exist', async () => {
      const results = await search({
        client,
        query: 'anything',
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(results).toEqual([]);
    }, 30000);

    it('should exclude rows with a null embedding', async () => {
      await insertTestArticle({
        slug: 'embedded',
        title: 'Embedded',
        content: 'Article with content'
      });

      await client.execute({
        sql: `INSERT INTO articles
              (slug, title, content, folder, tags, embedding, created_at, updated_at)
              VALUES (?, ?, ?, 'root', '[]', NULL, datetime('now'), datetime('now'))`,
        args: ['not-embedded', 'Not Embedded', 'Article with content']
      });

      const results = await search({
        client,
        query: 'article',
        limit: 10,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(results.map(result => result.slug)).toEqual(['embedded']);
    }, 30000);
  });

  describe('search vector index path', () => {
    it('should return the same results as the exact path for a representative fixture', async () => {
      await insertTestArticle({
        slug: 'astro-guide',
        title: 'Astro Guide',
        content: 'Learn how to build with Astro static site generator'
      });

      await insertTestArticle({
        slug: 'react-tutorial',
        title: 'React Tutorial',
        content: 'Learn React components and hooks'
      });

      await insertTestArticle({
        slug: 'typescript-notes',
        title: 'TypeScript Notes',
        content: 'TypeScript is a typed superset of JavaScript'
      });

      const embeddingOptions = { provider: 'local' as const, dimensions: 384 };

      const indexed = await search({
        client,
        query: 'static site building',
        limit: 3,
        embeddingOptions
      });

      const exact = await search({
        client,
        query: 'static site building',
        limit: 3,
        exact: true,
        embeddingOptions
      });

      expect(indexed[0]).toEqual(exact[0]);
      expect(indexed).toEqual(exact);
    }, 30000);

    it('should order tied distances deterministically across repeated runs', async () => {
      // Two rows orthogonal to the query sit at distance 1 exactly. The vector
      // index is free to return them in either order, so only the exact
      // re-rank's (distance, id) tiebreaker can make this reproducible.
      await insertArticleWithVector('tied-first', unitVector(10));
      await insertArticleWithVector('tied-second', unitVector(11));
      await insertArticleWithVector('nearest', unitVector(12));

      const runs: string[] = [];

      // The measured per-run flip rate without the tiebreaker is roughly 1 in 3,
      // so 25 runs leave a deleted `, a.id` about a 0.008% chance of slipping
      // through. With the tiebreaker present the result is fully deterministic,
      // so a higher count adds no flake risk of its own.
      for (let run = 0; run < 25; run++) {
        huggingFaceTransformersMock.queuedVectors.push(unitVector(12));

        const results = await search({
          client,
          query: 'tie breaker',
          limit: 3,
          embeddingOptions: { provider: 'local', dimensions: 384 }
        });

        runs.push(results.map(result => result.slug).join(','));
      }

      expect(new Set(runs).size).toBe(1);
      expect(runs[0]).toBe('nearest,tied-first,tied-second');
    }, 30000);

    it('should honor an explicit candidates value', async () => {
      await insertTestArticle({
        slug: 'article-1',
        title: 'Article 1',
        content: 'JavaScript programming'
      });

      const executeSpy = vi.spyOn(client, 'execute');

      await search({
        client,
        query: 'JavaScript',
        limit: 5,
        candidates: 50,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({
        args: expect.objectContaining({ candidates: 50, resultLimit: 5 })
      }));
    }, 30000);

    it.each([
      ['limit * 4 above the floor', 20, 80],
      ['the floor for small limits', 5, 32],
      ['the ceiling for the largest limit', 100, 400]
    ])('should default candidates to %s', async (_name, limit, expectedCandidates) => {
      await insertTestArticle({
        slug: 'article-1',
        title: 'Article 1',
        content: 'JavaScript programming'
      });

      const executeSpy = vi.spyOn(client, 'execute');

      await search({
        client,
        query: 'JavaScript',
        limit,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(executeSpy).toHaveBeenCalledWith(expect.objectContaining({
        args: expect.objectContaining({ candidates: expectedCandidates, resultLimit: limit })
      }));
    }, 30000);

    it.each([
      ['below the limit', 4],
      ['non-integer', 12.5],
      ['negative', -1],
      ['zero', 0],
      ['above the cap', MAX_SEARCH_CANDIDATES + 1],
      ['not a number', '32' as unknown as number],
      ['NaN', Number.NaN],
      ['infinite', Number.POSITIVE_INFINITY]
    ])(
      'should reject a %s candidates value before any database or embedding work',
      async (_name, candidates) => {
        const executeSpy = vi.spyOn(client, 'execute');

        await expect(search({
          client,
          query: 'JavaScript',
          limit: 5,
          candidates: candidates as number,
          embeddingOptions: { provider: 'local', dimensions: 384 }
        })).rejects.toThrow('Invalid search candidates');

        expect(executeSpy).not.toHaveBeenCalled();
        expect(huggingFaceTransformersMock.model).not.toHaveBeenCalled();
      }
    );

    it('should throw an actionable error when the table has no vector index', async () => {
      await client.execute(`
        CREATE TABLE unindexed (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT UNIQUE NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          folder TEXT NOT NULL DEFAULT 'root',
          tags TEXT DEFAULT '[]',
          embedding F32_BLOB(384),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      const embedding = await generateEmbedding('JavaScript programming', {
        provider: 'local',
        dimensions: 384
      });

      await client.execute({
        sql: `INSERT INTO unindexed
              (slug, title, content, folder, tags, embedding, created_at, updated_at)
              VALUES (?, ?, ?, 'root', '[]', vector(?), datetime('now'), datetime('now'))`,
        args: ['article-1', 'Article 1', 'JavaScript programming', JSON.stringify(embedding)]
      });

      let thrown: unknown;

      try {
        await search({
          client,
          query: 'JavaScript',
          tableName: 'unindexed',
          embeddingOptions: { provider: 'local', dimensions: 384 }
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error;
      expect(error.message).toContain('unindexed_embedding_idx');
      expect(error.message).toContain('createTable()');
      expect(error.message).toContain('exact: true');
      expect(error.message).not.toContain('failed to parse vector index parameters');
      expect((error.cause as Error).message).toContain(
        'failed to parse vector index parameters'
      );
      // The no-vector-support case has its own message; this one must not
      // muddy the remedy by mentioning it
      expect(error.message).not.toContain('no vector index support');
    }, 30000);

    it('should search a pre-index table after createTable() retrofits the index', async () => {
      // This is the exact remedy documented in MIGRATIONS.md, INDEXING.md, and
      // TROUBLESHOOTING.md, and it depends on libSQL backfilling the vector
      // index over rows that already existed at CREATE INDEX time. If that ever
      // stops holding, search() returns [] instead of throwing and the user has
      // followed the documented fix exactly, so it is pinned here.
      await client.execute(`
        CREATE TABLE legacy (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT UNIQUE NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          folder TEXT NOT NULL DEFAULT 'root',
          tags TEXT DEFAULT '[]',
          embedding F32_BLOB(384),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      for (const [slug, content] of [
        ['exact-match', 'TypeScript is a typed superset of JavaScript'],
        ['partial-match', 'Python is a programming language']
      ]) {
        const embedding = await generateEmbedding(content, {
          provider: 'local',
          dimensions: 384
        });

        await client.execute({
          sql: `INSERT INTO legacy
                (slug, title, content, folder, tags, embedding, created_at, updated_at)
                VALUES (?, ?, ?, 'root', '[]', vector(?), datetime('now'), datetime('now'))`,
          args: [slug, slug, content, JSON.stringify(embedding)]
        });
      }

      // Rows exist first; the index is created over them afterwards
      await createTable(client, 'legacy', 384);

      const results = await search({
        client,
        query: 'TypeScript programming',
        tableName: 'legacy',
        limit: 5,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      // The full ordered list, not just "not empty": both pre-existing rows
      // must be reachable through the index and ranked correctly
      expect(results.map(result => result.slug)).toEqual(['exact-match', 'partial-match']);
      expect(results[0].distance).toBeLessThan(results[1].distance);
    }, 30000);

    it.each([
      ['unrelated to vectors', new Error('SQLITE_BUSY: database is locked')],
      // libSQL prefixes this with the same `vector index(search):` text as the
      // missing-index failure, so a prefix match would rewrite it into advice
      // to create an index that already exists
      [
        'a vector index diagnostic',
        new Error('SQLITE_ERROR: vector index(search): dimensions are different: 8 != 4')
      ],
      // A non-Error rejection cannot be inspected for a signature at all
      ['a non-Error rejection', 'a string, not an Error']
    ])('should rethrow %s query failures untouched', async (_name, failure) => {
      vi.spyOn(client, 'execute').mockRejectedValueOnce(failure);

      await expect(search({
        client,
        query: 'JavaScript',
        embeddingOptions: { provider: 'local', dimensions: 384 }
      })).rejects.toBe(failure);
    }, 30000);

    it('should explain how to proceed when the deployment has no vector support', async () => {
      // A libSQL build without vector support has no vector_top_k() at all.
      // No CREATE INDEX can fix that, so the message must not suggest one.
      const failure = new Error('SQLITE_ERROR: no such table: vector_top_k');
      vi.spyOn(client, 'execute').mockRejectedValueOnce(failure);

      let thrown: unknown;

      try {
        await search({
          client,
          query: 'JavaScript',
          embeddingOptions: { provider: 'local', dimensions: 384 }
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error;
      expect(error.message).toContain('no vector index support');
      expect(error.message).toContain('exact: true');
      expect(error.message).not.toContain('CREATE INDEX');
      expect(error.message).not.toContain('articles_embedding_idx');
      expect(error.cause).toBe(failure);
    }, 30000);

    it('should surface a real dimension mismatch instead of the missing-index message', async () => {
      // Dimension drift: the table was created 4 wide, but the local provider
      // queries with its native 384-wide vector. The vector index exists here,
      // so the missing-index advice would be actively wrong.
      await createTable(client, 'narrow', 4);

      await client.execute({
        sql: `INSERT INTO narrow
              (slug, title, content, folder, tags, embedding, created_at, updated_at)
              VALUES (?, ?, ?, 'root', '[]', vector(?), datetime('now'), datetime('now'))`,
        args: ['article-1', 'Article 1', 'content', JSON.stringify([1, 0, 0, 0])]
      });

      let thrown: unknown;

      try {
        await search({
          client,
          query: 'mismatched width',
          tableName: 'narrow',
          embeddingOptions: { provider: 'local', dimensions: 384 }
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      const error = thrown as Error;
      expect(error.message).toContain('dimensions are different');
      expect(error.message).toContain('384 != 4');
      expect(error.message).not.toContain('narrow_embedding_idx');
      expect(error.message).not.toContain('createTable()');
      expect(error.message).not.toContain('exact: true');
      // The message is libSQL's, verbatim: not rewritten and not demoted to a cause
      expect(error.message).toBe(
        'SQLITE_ERROR: vector index(search): dimensions are different: 384 != 4'
      );
    }, 30000);
  });

  describe('search exact path', () => {
    it('should return exact results without using the vector index', async () => {
      await client.execute(`
        CREATE TABLE unindexed (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT UNIQUE NOT NULL,
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          folder TEXT NOT NULL DEFAULT 'root',
          tags TEXT DEFAULT '[]',
          embedding F32_BLOB(384),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      for (const [slug, content] of [
        ['exact-match', 'TypeScript is a typed superset of JavaScript'],
        ['partial-match', 'Python is a programming language']
      ]) {
        const embedding = await generateEmbedding(content, {
          provider: 'local',
          dimensions: 384
        });

        await client.execute({
          sql: `INSERT INTO unindexed
                (slug, title, content, folder, tags, embedding, created_at, updated_at)
                VALUES (?, ?, ?, 'root', '[]', vector(?), datetime('now'), datetime('now'))`,
          args: [slug, slug, content, JSON.stringify(embedding)]
        });
      }

      const results = await search({
        client,
        query: 'TypeScript programming',
        tableName: 'unindexed',
        limit: 5,
        exact: true,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      expect(results.map(result => result.slug)).toEqual(['exact-match', 'partial-match']);
      expect(results[0].distance).toBeLessThan(results[1].distance);
    }, 30000);

    it('should not query the vector index when exact is true', async () => {
      await insertTestArticle({
        slug: 'article-1',
        title: 'Article 1',
        content: 'JavaScript programming'
      });

      const executeSpy = vi.spyOn(client, 'execute');

      await search({
        client,
        query: 'JavaScript',
        exact: true,
        candidates: 64,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      });

      const statement = executeSpy.mock.calls[0][0] as { sql: string; args: unknown };
      expect(statement.sql).not.toContain('vector_top_k');
      expect(statement.sql).toContain('embedding IS NOT NULL');
      expect(statement.args).toEqual({
        queryVector: expect.any(String),
        resultLimit: 10
      });
    }, 30000);

    it('should still validate candidates when exact is true', async () => {
      // candidates has no effect on this path, but it is validated anyway:
      // silently accepting nonsense on one path and rejecting it on the other
      // would make the contract depend on which path a caller happened to take.
      const executeSpy = vi.spyOn(client, 'execute');

      await expect(search({
        client,
        query: 'JavaScript',
        limit: 10,
        candidates: 5,
        exact: true,
        embeddingOptions: { provider: 'local', dimensions: 384 }
      })).rejects.toThrow('Invalid search candidates');

      expect(executeSpy).not.toHaveBeenCalled();
      expect(huggingFaceTransformersMock.model).not.toHaveBeenCalled();
    }, 30000);
  });

  describe('getAllArticles', () => {
    it('should return all articles', async () => {
      await insertTestArticle({
        slug: 'article-1',
        title: 'Article 1',
        content: 'Content 1'
      });

      await insertTestArticle({
        slug: 'article-2',
        title: 'Article 2',
        content: 'Content 2'
      });

      const articles = await getAllArticles(client);

      expect(articles).toHaveLength(2);
      expect(articles[0]).toHaveProperty('id');
      expect(articles[0]).toHaveProperty('slug');
      expect(articles[0]).toHaveProperty('title');
      expect(articles[0]).toHaveProperty('created_at');
      expect(articles[0]).toHaveProperty('updated_at');
    }, 30000);

    it('should order articles by title', async () => {
      await insertTestArticle({
        slug: 'z-article',
        title: 'Z Article',
        content: 'Content'
      });

      await insertTestArticle({
        slug: 'a-article',
        title: 'A Article',
        content: 'Content'
      });

      const articles = await getAllArticles(client);

      expect(articles[0].title).toBe('A Article');
      expect(articles[1].title).toBe('Z Article');
    }, 30000);
  });

  describe('getArticleBySlug', () => {
    it('should return article by slug', async () => {
      await insertTestArticle({
        slug: 'test-article',
        title: 'Test Article',
        content: 'Test content'
      });

      const article = await getArticleBySlug(client, 'test-article');

      expect(article).not.toBeNull();
      expect(article?.slug).toBe('test-article');
      expect(article?.title).toBe('Test Article');
      expect(article?.content).toBe('Test content');
    }, 30000);

    it('should return null for non-existent slug', async () => {
      const article = await getArticleBySlug(client, 'non-existent');

      expect(article).toBeNull();
    });
  });

  describe('getArticlesByFolder', () => {
    it('should return articles in folder', async () => {
      await insertTestArticle({
        slug: 'docs/guide',
        title: 'Guide',
        content: 'Guide content',
        folder: 'docs'
      });

      await insertTestArticle({
        slug: 'blog/post',
        title: 'Post',
        content: 'Post content',
        folder: 'blog'
      });

      const articles = await getArticlesByFolder(client, 'docs');

      expect(articles).toHaveLength(1);
      expect(articles[0].folder).toBe('docs');
      expect(articles[0].title).toBe('Guide');
    }, 30000);

    it('should return empty array for non-existent folder', async () => {
      const articles = await getArticlesByFolder(client, 'non-existent');

      expect(articles).toEqual([]);
    });
  });

  describe('getFolders', () => {
    it('should return unique folders', async () => {
      await insertTestArticle({
        slug: 'docs/guide-1',
        title: 'Guide 1',
        content: 'Content',
        folder: 'docs'
      });

      await insertTestArticle({
        slug: 'docs/guide-2',
        title: 'Guide 2',
        content: 'Content',
        folder: 'docs'
      });

      await insertTestArticle({
        slug: 'blog/post',
        title: 'Post',
        content: 'Content',
        folder: 'blog'
      });

      const folders = await getFolders(client);

      expect(folders).toHaveLength(2);
      expect(folders).toContain('docs');
      expect(folders).toContain('blog');
    }, 30000);

    it('should return folders in sorted order', async () => {
      await insertTestArticle({
        slug: 'z/article',
        title: 'Article',
        content: 'Content',
        folder: 'z-folder'
      });

      await insertTestArticle({
        slug: 'a/article',
        title: 'Article',
        content: 'Content',
        folder: 'a-folder'
      });

      const folders = await getFolders(client);

      expect(folders[0]).toBe('a-folder');
      expect(folders[1]).toBe('z-folder');
    }, 30000);

    it('should return empty array when no articles exist', async () => {
      const folders = await getFolders(client);

      expect(folders).toEqual([]);
    });
  });
});
