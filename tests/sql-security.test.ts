import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Client } from '@libsql/client';
import { createClient } from '@libsql/client';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { createTable, indexContent } from '../src/indexer.js';
import {
  getAllArticles,
  getArticleBySlug,
  getArticlesByFolder,
  getFolders,
  search
} from '../src/search.js';
import { generateEmbedding } from '../src/embeddings.js';

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/embeddings.js')>();

  return {
    ...actual,
    generateEmbedding: vi.fn(async () => [0.1, 0.2, 0.3])
  };
});

describe('SQL input security', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createMockClient(): Client {
    return {
      execute: vi.fn(async () => ({ rows: [] })),
      batch: vi.fn(async () => [])
    } as unknown as Client;
  }

  async function insertArticle(client: Client, tableName: string): Promise<void> {
    await client.execute({
      sql: `INSERT INTO "${tableName}"
            (slug, title, content, folder, tags, embedding, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, vector(?), datetime('now'), datetime('now'))`,
      args: [
        'docs/guide',
        'Guide',
        'Guide content',
        'docs',
        JSON.stringify(['docs']),
        JSON.stringify([0.1, 0.2, 0.3])
      ]
    });
  }

  it.each(['custom_articles', '_articles2', 'select'])(
    'supports valid custom or reserved table identifier %s',
    async (tableName) => {
      const client = createClient({ url: ':memory:' });
      await createTable(client, tableName, 3);
      await insertArticle(client, tableName);

      await expect(getAllArticles(client, tableName)).resolves.toHaveLength(1);
      await expect(getArticleBySlug(client, 'docs/guide', tableName)).resolves.toMatchObject({
        slug: 'docs/guide',
        title: 'Guide'
      });
      await expect(getArticlesByFolder(client, 'docs', tableName)).resolves.toHaveLength(1);
      await expect(getFolders(client, tableName)).resolves.toEqual(['docs']);
      await expect(search({
        client,
        query: 'guide',
        tableName,
        limit: 1,
        embeddingOptions: { provider: 'openai', apiKey: 'key' }
      })).resolves.toHaveLength(1);
    }
  );

  it.each([
    '',
    '1articles',
    'article-name',
    'article.name',
    'articles; DROP TABLE articles; --',
    'articles"',
    'articles space',
    'cafe\u0301',
    'ártica'
  ])('rejects invalid table identifier %s before database calls', async (tableName) => {
    const client = createMockClient();

    await expect(createTable(client, tableName)).rejects.toThrow('Invalid SQL tableName');
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('rejects invalid table names in indexContent before filesystem, database, or embedding work', async () => {
    const client = createMockClient();

    await expect(indexContent({
      client,
      contentPath: '/path/that/should/not/be/read',
      tableName: 'articles; DROP TABLE articles; --'
    })).rejects.toThrow('Invalid SQL tableName');

    expect(client.execute).not.toHaveBeenCalled();
    expect(client.batch).not.toHaveBeenCalled();
    expect(generateEmbedding).not.toHaveBeenCalled();
  });

  it('rejects invalid table names in search before database or embedding work', async () => {
    const client = createMockClient();

    await expect(search({
      client,
      query: 'guide',
      tableName: 'articles; DROP TABLE articles; --'
    })).rejects.toThrow('Invalid SQL tableName');

    expect(client.execute).not.toHaveBeenCalled();
    expect(generateEmbedding).not.toHaveBeenCalled();
  });

  it('requires explicit embedding options for indexing and search', async () => {
    const client = createMockClient();

    await expect(indexContent({
      client,
      contentPath: '/path/that/should/not/be/read'
    } as never)).rejects.toThrow('embeddingOptions is required');

    await expect(search({
      client,
      query: 'guide'
    } as never)).rejects.toThrow('embeddingOptions is required');

    expect(client.execute).not.toHaveBeenCalled();
    expect(generateEmbedding).not.toHaveBeenCalled();
  });

  it.each([
    ['getAllArticles', (client: Client) => getAllArticles(client, 'bad-name')],
    ['getArticleBySlug', (client: Client) => getArticleBySlug(client, 'slug', 'bad-name')],
    ['getArticlesByFolder', (client: Client) => getArticlesByFolder(client, 'docs', 'bad-name')],
    ['getFolders', (client: Client) => getFolders(client, 'bad-name')]
  ])('rejects invalid table names in %s before database calls', async (_name, call) => {
    const client = createMockClient();

    await expect(call(client)).rejects.toThrow('Invalid SQL tableName');
    expect(client.execute).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 101, '10', null])(
    'rejects invalid search limit %s before database or embedding work',
    async (limit) => {
      const client = createMockClient();

      await expect(search({
        client,
        query: 'guide',
        limit: limit as number
      })).rejects.toThrow('Invalid search limit');

      expect(client.execute).not.toHaveBeenCalled();
      expect(generateEmbedding).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['default', undefined, 10, 40],
    ['minimum', 1, 1, 32],
    ['maximum', 100, 100, 400]
  ])(
    'uses the %s search limit policy',
    async (_name, limit, expectedLimit, expectedCandidates) => {
      const client = createMockClient();

      await search({
        client,
        query: 'guide',
        embeddingOptions: { provider: 'openai', apiKey: 'key' },
        ...(limit === undefined ? {} : { limit })
      });

      expect(generateEmbedding).toHaveBeenCalledWith('guide', {
        provider: 'openai',
        apiKey: 'key',
        intent: 'query'
      });
      expect(client.execute).toHaveBeenCalledWith(expect.objectContaining({
        args: {
          queryVector: JSON.stringify([0.1, 0.2, 0.3]),
          indexName: 'articles_embedding_idx',
          candidates: expectedCandidates,
          resultLimit: expectedLimit
        }
      }));
    }
  );

  it('defaults indexing embeddings to document intent', async () => {
    const client = createMockClient();
    const contentPath = join(process.cwd(), 'test-content-intent');

    await mkdir(contentPath, { recursive: true });
    await writeFile(join(contentPath, 'guide.md'), '---\ntitle: Guide\n---\n\nContent');

    try {
      await indexContent({
        client,
        contentPath,
        embeddingOptions: { provider: 'openai', apiKey: 'key', intent: undefined }
      });

      expect(generateEmbedding).toHaveBeenCalledWith(
        'Guide\n\n\nContent',
        { provider: 'openai', apiKey: 'key', intent: 'document' }
      );
    } finally {
      await rm(contentPath, { recursive: true, force: true });
    }
  });

  it('preserves explicit embedding intent from callers', async () => {
    const client = createMockClient();

    await search({
      client,
      query: 'guide',
      embeddingOptions: { provider: 'openai', apiKey: 'key', intent: 'document' }
    });

    expect(generateEmbedding).toHaveBeenCalledWith('guide', {
      provider: 'openai',
      apiKey: 'key',
      intent: 'document'
    });
  });

  it('rejects invalid vector dimensions before database calls', async () => {
    const client = createMockClient();

    await expect(createTable(client, 'articles', 1.5)).rejects.toThrow('Invalid vector dimensions');
    expect(client.execute).not.toHaveBeenCalled();
  });
});
