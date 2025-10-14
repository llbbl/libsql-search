import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { createTable, indexContent } from '../src/indexer.js';

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
  });

  describe('createTable', () => {
    it('should create articles table with correct schema', async () => {
      await createTable(client, 'articles', 768);

      const result = await client.execute(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name='articles'
      `);

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].name).toBe('articles');
    });

    it('should create indexes', async () => {
      await createTable(client, 'articles', 768);

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
        embeddingOptions: { provider: 'local', dimensions: 768 }
      });

      expect(result.success).toBe(1);
      expect(result.failed).toBe(0);
      expect(result.total).toBe(1);

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
        embeddingOptions: { provider: 'local', dimensions: 768 }
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
        embeddingOptions: { provider: 'local', dimensions: 768 }
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
        embeddingOptions: { provider: 'local', dimensions: 768 }
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
        embeddingOptions: { provider: 'local', dimensions: 768 }
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
        embeddingOptions: { provider: 'local', dimensions: 768 }
      });

      await rm(join(testDir, 'first.md'));
      await writeFile(join(testDir, 'second.md'), '---\ntitle: Second\n---\nContent');

      await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 768 }
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
        embeddingOptions: { provider: 'local', dimensions: 768 }
      });

      expect(result.total).toBe(0);
    });

    it('should call onProgress callback', async () => {
      await writeFile(join(testDir, 'test.md'), '---\ntitle: Test\n---\nContent');

      const progressCalls: Array<{ current: number; total: number; file: string }> = [];

      await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 768 },
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

    it('should return zero results for empty directory', async () => {
      const result = await indexContent({
        client,
        contentPath: testDir,
        embeddingOptions: { provider: 'local', dimensions: 768 }
      });

      expect(result.success).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.total).toBe(0);
    });
  });
});
