import { describe, it, expect, beforeEach } from 'vitest';
import { createClient } from '@libsql/client';
import { createTable } from '../src/indexer.js';
import {
  search,
  getAllArticles,
  getArticleBySlug,
  getArticlesByFolder,
  getFolders
} from '../src/search.js';
import { generateEmbedding } from '../src/embeddings.js';

describe('search', () => {
  const testDbUrl = ':memory:';
  let client: ReturnType<typeof createClient>;

  beforeEach(async () => {
    client = createClient({ url: testDbUrl });
    await createTable(client);
  });

  async function insertTestArticle(data: {
    slug: string;
    title: string;
    content: string;
    folder?: string;
    tags?: string[];
  }) {
    const embedding = await generateEmbedding(data.content, {
      provider: 'local',
      dimensions: 768
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
        embeddingOptions: { provider: 'local', dimensions: 768 }
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
        embeddingOptions: { provider: 'local', dimensions: 768 }
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
        embeddingOptions: { provider: 'local', dimensions: 768 }
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
        embeddingOptions: { provider: 'local', dimensions: 768 }
      });

      expect(results[0].tags).toEqual(['tag1', 'tag2']);
    }, 30000);

    it('should return empty array when no articles exist', async () => {
      const results = await search({
        client,
        query: 'anything',
        embeddingOptions: { provider: 'local', dimensions: 768 }
      });

      expect(results).toEqual([]);
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
