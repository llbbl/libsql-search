/**
 * Content indexer for markdown and other formats
 */

import { readdir, readFile } from 'fs/promises';
import { join, relative, dirname, extname } from 'path';
import matter from 'gray-matter';
import type { Client } from '@libsql/client';
import { generateEmbedding, prepareTextForEmbedding, type EmbeddingOptions } from './embeddings.js';

export interface IndexerOptions {
  client: Client;
  contentPath: string;
  embeddingOptions?: EmbeddingOptions;
  fileExtensions?: string[];
  exclude?: string[];
  tableName?: string;
  onProgress?: (current: number, total: number, file: string) => void;
}

export interface IndexedDocument {
  slug: string;
  title: string;
  content: string;
  folder: string;
  tags: string[];
  embedding: number[];
  metadata?: Record<string, any>;
}

/**
 * Index markdown content from a directory
 */
export async function indexContent(options: IndexerOptions): Promise<{
  success: number;
  failed: number;
  total: number;
}> {
  const {
    client,
    contentPath,
    embeddingOptions = {},
    fileExtensions = ['.md', '.markdown'],
    exclude = ['node_modules', '.git', 'dist', 'build'],
    tableName = 'articles',
    onProgress
  } = options;

  // Find all content files
  const files = await findFiles(contentPath, contentPath, fileExtensions, exclude);

  if (files.length === 0) {
    console.warn(`No files found in ${contentPath}`);
    return { success: 0, failed: 0, total: 0 };
  }

  // Clear existing content
  await client.execute(`DELETE FROM ${tableName}`);

  // Process each file
  let success = 0;
  let failed = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if (onProgress) {
      onProgress(i + 1, files.length, file.relativePath);
    }

    try {
      const document = await processFile(file, embeddingOptions);
      await insertDocument(client, document, tableName);
      success++;
    } catch (error) {
      console.error(`Failed to index ${file.relativePath}:`, error);
      failed++;
    }
  }

  return { success, failed, total: files.length };
}

/**
 * Find all files matching extensions
 */
async function findFiles(
  dir: string,
  baseDir: string,
  extensions: string[],
  exclude: string[]
): Promise<Array<{ fullPath: string; relativePath: string; folder: string }>> {
  const files: Array<{ fullPath: string; relativePath: string; folder: string }> = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && !exclude.includes(entry.name)) {
        const subFiles = await findFiles(fullPath, baseDir, extensions, exclude);
        files.push(...subFiles);
      }
    } else if (extensions.includes(extname(entry.name))) {
      const relativePath = relative(baseDir, fullPath);
      const folder = dirname(relativePath);

      files.push({
        fullPath,
        relativePath,
        folder: folder === '.' ? 'root' : folder
      });
    }
  }

  return files;
}

/**
 * Process a single file into an indexed document
 */
async function processFile(
  file: { fullPath: string; relativePath: string; folder: string },
  embeddingOptions: EmbeddingOptions
): Promise<IndexedDocument> {
  const content = await readFile(file.fullPath, 'utf-8');
  const { data: frontMatter, content: markdown } = matter(content);

  // Generate slug from relative path
  const slug = file.relativePath
    .replace(/\.(md|markdown)$/, '')
    .replace(/\\/g, '/');

  // Extract metadata
  const title = frontMatter.title || file.relativePath
    .split('/').pop()
    ?.replace(/\.(md|markdown)$/, '')
    .replace(/-/g, ' ') || 'Untitled';

  const tags = Array.isArray(frontMatter.tags) ? frontMatter.tags : [];

  // Generate embedding
  const embeddingText = prepareTextForEmbedding({
    title,
    description: frontMatter.description,
    content: markdown,
    tags
  });

  const embedding = await generateEmbedding(embeddingText, embeddingOptions);

  return {
    slug,
    title,
    content: markdown,
    folder: file.folder,
    tags,
    embedding,
    metadata: frontMatter
  };
}

/**
 * Insert document into database
 */
async function insertDocument(
  client: Client,
  document: IndexedDocument,
  tableName: string
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO ${tableName}
          (slug, title, content, folder, tags, embedding, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, vector(?), datetime('now'), datetime('now'))`,
    args: [
      document.slug,
      document.title,
      document.content,
      document.folder,
      JSON.stringify(document.tags),
      JSON.stringify(document.embedding)
    ]
  });
}

/**
 * Create the articles table if it doesn't exist
 */
export async function createTable(
  client: Client,
  tableName: string = 'articles',
  dimensions: number = 768
): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT 'root',
      tags TEXT DEFAULT '[]',
      embedding F32_BLOB(${dimensions}),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS ${tableName}_embedding_idx
    ON ${tableName}(libsql_vector_idx(embedding))
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS ${tableName}_folder_idx
    ON ${tableName}(folder)
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS ${tableName}_slug_idx
    ON ${tableName}(slug)
  `);
}
