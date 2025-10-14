/**
 * Vector search functionality
 */

import type { Client } from '@libsql/client';
import { generateEmbedding, type EmbeddingOptions } from './embeddings.js';

export interface SearchOptions {
  client: Client;
  query: string;
  limit?: number;
  tableName?: string;
  embeddingOptions?: EmbeddingOptions;
}

export interface SearchResult {
  id: number;
  slug: string;
  title: string;
  content: string;
  folder: string;
  tags: string[];
  distance: number;
  created_at: string;
}

/**
 * Perform semantic search using vector similarity
 */
export async function search(options: SearchOptions): Promise<SearchResult[]> {
  const {
    client,
    query,
    limit = 10,
    tableName = 'articles',
    embeddingOptions = {}
  } = options;

  // Generate embedding for query
  const queryEmbedding = await generateEmbedding(query, embeddingOptions);

  // Perform vector search
  const results = await client.execute({
    sql: `
      SELECT
        id,
        slug,
        title,
        content,
        folder,
        tags,
        created_at,
        vector_distance_cos(embedding, vector(?)) as distance
      FROM ${tableName}
      WHERE embedding IS NOT NULL
      ORDER BY distance
      LIMIT ?
    `,
    args: [JSON.stringify(queryEmbedding), limit]
  });

  // Parse and format results
  return results.rows.map(row => ({
    id: row.id as number,
    slug: row.slug as string,
    title: row.title as string,
    content: row.content as string,
    folder: row.folder as string,
    tags: JSON.parse(row.tags as string || '[]'),
    distance: row.distance as number,
    created_at: row.created_at as string
  }));
}

/**
 * Get all articles (for building static pages, navigation, etc.)
 */
export async function getAllArticles(
  client: Client,
  tableName: string = 'articles'
): Promise<Array<{
  id: number;
  slug: string;
  title: string;
  folder: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}>> {
  const results = await client.execute(`
    SELECT id, slug, title, folder, tags, created_at, updated_at
    FROM ${tableName}
    ORDER BY title
  `);

  return results.rows.map(row => ({
    id: row.id as number,
    slug: row.slug as string,
    title: row.title as string,
    folder: row.folder as string,
    tags: JSON.parse(row.tags as string || '[]'),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string
  }));
}

/**
 * Get a single article by slug
 */
export async function getArticleBySlug(
  client: Client,
  slug: string,
  tableName: string = 'articles'
): Promise<{
  id: number;
  slug: string;
  title: string;
  content: string;
  folder: string;
  tags: string[];
  created_at: string;
  updated_at: string;
} | null> {
  const results = await client.execute({
    sql: `
      SELECT id, slug, title, content, folder, tags, created_at, updated_at
      FROM ${tableName}
      WHERE slug = ?
      LIMIT 1
    `,
    args: [slug]
  });

  if (results.rows.length === 0) {
    return null;
  }

  const row = results.rows[0];
  return {
    id: row.id as number,
    slug: row.slug as string,
    title: row.title as string,
    content: row.content as string,
    folder: row.folder as string,
    tags: JSON.parse(row.tags as string || '[]'),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string
  };
}

/**
 * Get articles by folder
 */
export async function getArticlesByFolder(
  client: Client,
  folder: string,
  tableName: string = 'articles'
): Promise<Array<{
  id: number;
  slug: string;
  title: string;
  folder: string;
  tags: string[];
}>> {
  const results = await client.execute({
    sql: `
      SELECT id, slug, title, folder, tags
      FROM ${tableName}
      WHERE folder = ?
      ORDER BY title
    `,
    args: [folder]
  });

  return results.rows.map(row => ({
    id: row.id as number,
    slug: row.slug as string,
    title: row.title as string,
    folder: row.folder as string,
    tags: JSON.parse(row.tags as string || '[]')
  }));
}

/**
 * Get all unique folders
 */
export async function getFolders(
  client: Client,
  tableName: string = 'articles'
): Promise<string[]> {
  const results = await client.execute(`
    SELECT DISTINCT folder
    FROM ${tableName}
    ORDER BY folder
  `);

  return results.rows.map(row => row.folder as string);
}
