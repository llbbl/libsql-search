/**
 * Content indexer for markdown and other formats
 */

import { readdir, readFile } from 'fs/promises';
import { join, relative, dirname, extname } from 'path';
import matter from 'gray-matter';
import type { Client, InStatement } from '@libsql/client';
import { generateEmbedding, prepareTextForEmbedding, type EmbeddingOptions } from './embeddings.js';
import { normalizeVectorDimensions, quoteSqlIdentifier } from './sql.js';

/**
 * How build-phase failures are handled.
 *
 * - `abort` (default) rejects the whole rebuild on the first failure
 * - `skip` drops the failing file and rebuilds from the survivors
 */
export type IndexFailurePolicy = 'abort' | 'skip';

/** The step that failed while turning a file into an indexable document. */
export type IndexFailureStage = 'read' | 'parse' | 'embed';

/**
 * The phase an {@link IndexingError} was raised in.
 *
 * - `build` means no database state was touched
 * - `replace` means the replacement transaction failed and was rolled back
 */
export type IndexingErrorPhase = 'build' | 'replace';

export interface IndexFailure {
  /** Path of the file relative to `contentPath`. */
  file: string;
  stage: IndexFailureStage;
  error: Error;
}

export interface IndexerOptions {
  client: Client;
  contentPath: string;
  embeddingOptions?: EmbeddingOptions;
  fileExtensions?: string[];
  exclude?: string[];
  tableName?: string;
  onProgress?: (current: number, total: number, file: string) => void;
  /** Defaults to `abort`. */
  failurePolicy?: IndexFailurePolicy;
  /** Allow an empty source directory to empty the index. Defaults to `false`. */
  allowEmptyIndex?: boolean;
}

export interface IndexResult {
  /** Documents written to the table. */
  success: number;
  /** Files that could not be indexed. */
  failed: number;
  /** Files discovered on disk. */
  total: number;
  /** Whether table contents were replaced by this call. */
  replaced: boolean;
  /** Replaced, but some files were skipped. */
  partial: boolean;
  failures: IndexFailure[];
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
 * Raised when a rebuild cannot complete. The previously indexed rows are always
 * left exactly as they were.
 */
export class IndexingError extends Error {
  readonly phase: IndexingErrorPhase;
  readonly failures: IndexFailure[];

  constructor(
    message: string,
    phase: IndexingErrorPhase,
    failures: IndexFailure[] = [],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'IndexingError';
    this.phase = phase;
    this.failures = failures;
  }
}

interface ContentFile {
  fullPath: string;
  relativePath: string;
  folder: string;
}

/**
 * Internal build-phase view of a document.
 *
 * `serializedTags` is derived from `tags` during the parse stage so that
 * unserializable tags fail the file there rather than at bind time. It is an
 * implementation detail of the build-to-replace handoff and deliberately kept
 * off the exported `IndexedDocument`.
 */
interface BuiltDocument extends IndexedDocument {
  serializedTags: string;
}

type BuildOutcome =
  | { ok: true; document: BuiltDocument }
  | { ok: false; stage: IndexFailureStage; error: Error };

/**
 * Index markdown content from a directory.
 *
 * Every document is read, parsed, and embedded in memory before any database
 * state changes. The table is then replaced inside a single write transaction,
 * so a failure at any point leaves the previous index intact.
 */
export async function indexContent(options: IndexerOptions): Promise<IndexResult> {
  const {
    client,
    contentPath,
    embeddingOptions = {},
    fileExtensions = ['.md', '.markdown'],
    exclude = ['node_modules', '.git', 'dist', 'build'],
    tableName = 'articles',
    onProgress,
    failurePolicy = 'abort',
    allowEmptyIndex = false
  } = options;
  const quotedTableName = quoteSqlIdentifier(tableName, 'tableName');

  // Find all content files, in a deterministic order so that slug collisions
  // and progress reporting do not depend on directory read order
  let files: ContentFile[];
  try {
    files = await findFiles(contentPath, contentPath, fileExtensions, exclude);
  } catch (error) {
    throw new IndexingError(
      `Failed to scan ${contentPath} for source files. The existing index was left unchanged.`,
      'build',
      [],
      { cause: toError(error) }
    );
  }

  files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));

  if (files.length === 0 && !allowEmptyIndex) {
    throw new IndexingError(
      `No source files found in ${contentPath}. The existing index was left unchanged. ` +
        `Pass allowEmptyIndex: true to intentionally empty the index.`,
      'build'
    );
  }

  // Build phase: nothing below touches the database until every document is ready
  const documents: BuiltDocument[] = [];
  const failures: IndexFailure[] = [];
  const slugOwners = new Map<string, string>();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if (onProgress) {
      onProgress(i + 1, files.length, file.relativePath);
    }

    const outcome = await buildDocument(file, embeddingOptions);
    let failure: IndexFailure | undefined;

    if (outcome.ok) {
      // Two files can reduce to one slug, which the unique slug column would
      // otherwise reject mid-replacement. Files are processed in sorted path
      // order, so the first file to claim a slug keeps it.
      const owner = slugOwners.get(outcome.document.slug);

      if (owner === undefined) {
        slugOwners.set(outcome.document.slug, file.relativePath);
        documents.push(outcome.document);
      } else {
        failure = {
          file: file.relativePath,
          stage: 'parse',
          error: new Error(
            `Duplicate slug "${outcome.document.slug}": ${file.relativePath} collides with ${owner}`
          )
        };
      }
    } else {
      failure = {
        file: file.relativePath,
        stage: outcome.stage,
        error: outcome.error
      };
    }

    if (failure === undefined) {
      continue;
    }

    if (failurePolicy === 'abort') {
      throw new IndexingError(
        `Failed to ${failure.stage} ${file.relativePath}: ${failure.error.message}. ` +
          `The existing index was left unchanged. ` +
          `Pass failurePolicy: 'skip' to rebuild from the remaining files.`,
        'build',
        [failure],
        { cause: failure.error }
      );
    }

    console.error(`Skipping ${file.relativePath} (${failure.stage} failed):`, failure.error);
    failures.push(failure);
  }

  // Never trade a valid index for an empty one. This holds even under
  // allowEmptyIndex, which is about an empty source set, not a failed one.
  if (files.length > 0 && documents.length === 0) {
    throw new IndexingError(
      `All ${files.length} source file(s) in ${contentPath} failed to index. ` +
        `The existing index was left unchanged.`,
      'build',
      failures,
      { cause: failures[0].error }
    );
  }

  const success = documents.length;

  // Replace phase: a single transaction, all or nothing. `documents` is
  // consumed here, so read anything needed from it before this call.
  await replaceIndex(client, quotedTableName, documents, failures);

  return {
    success,
    failed: failures.length,
    total: files.length,
    replaced: true,
    partial: failures.length > 0,
    failures
  };
}

/**
 * Find all files matching extensions
 */
async function findFiles(
  dir: string,
  baseDir: string,
  extensions: string[],
  exclude: string[]
): Promise<ContentFile[]> {
  const files: ContentFile[] = [];
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
 * Read, parse, and embed a single file without touching database state
 */
async function buildDocument(
  file: ContentFile,
  embeddingOptions: EmbeddingOptions
): Promise<BuildOutcome> {
  let raw: string;
  try {
    raw = await readFile(file.fullPath, 'utf-8');
  } catch (error) {
    return { ok: false, stage: 'read', error: toError(error) };
  }

  let parsed: ParsedFile;
  try {
    parsed = parseFile(file, raw);
  } catch (error) {
    return { ok: false, stage: 'parse', error: toError(error) };
  }

  let embedding: number[];
  try {
    embedding = await generateEmbedding(parsed.embeddingText, {
      ...embeddingOptions,
      intent: embeddingOptions.intent ?? 'document'
    });
  } catch (error) {
    return { ok: false, stage: 'embed', error: toError(error) };
  }

  return {
    ok: true,
    document: {
      slug: parsed.slug,
      title: parsed.title,
      content: parsed.content,
      folder: file.folder,
      tags: parsed.tags,
      serializedTags: parsed.serializedTags,
      embedding,
      metadata: parsed.metadata
    }
  };
}

interface ParsedFile {
  slug: string;
  title: string;
  content: string;
  tags: string[];
  serializedTags: string;
  embeddingText: string;
  metadata: Record<string, any>;
}

/**
 * Parse frontmatter and derive the document fields used for embedding
 */
function parseFile(file: ContentFile, raw: string): ParsedFile {
  const { data: frontMatter, content: markdown } = matter(raw);

  // Generate slug from relative path
  const slug = file.relativePath
    .replace(/\.(md|markdown)$/, '')
    .replace(/\\/g, '/');

  // Extract metadata
  const title = resolveTitle(file, frontMatter.title);

  const tags = Array.isArray(frontMatter.tags) ? frontMatter.tags : [];

  // Serialized here rather than at bind time so that unserializable tags, such
  // as the self-referencing array a YAML anchor can produce, fail this file at
  // the parse stage instead of escaping the classified region
  const serializedTags = JSON.stringify(tags);

  const embeddingText = prepareTextForEmbedding({
    title,
    description: frontMatter.description,
    content: markdown,
    tags
  });

  return {
    slug,
    title,
    content: markdown,
    tags,
    serializedTags,
    embeddingText,
    metadata: frontMatter
  };
}

/**
 * Resolve the document title from frontmatter.
 *
 * Only values that can be stored in a TEXT column are accepted. A structured
 * title such as a YAML list is a content defect, so it fails the file at the
 * parse stage where `failurePolicy` governs it, instead of failing the whole
 * replacement transaction with an unattributable bind error.
 */
function resolveTitle(file: ContentFile, rawTitle: unknown): string {
  if (!rawTitle) {
    return fallbackTitle(file);
  }

  if (typeof rawTitle === 'string') {
    return rawTitle;
  }

  if (typeof rawTitle === 'number' || typeof rawTitle === 'bigint' || typeof rawTitle === 'boolean') {
    return String(rawTitle);
  }

  if (rawTitle instanceof Date) {
    return rawTitle.toISOString();
  }

  throw new Error(
    `Unsupported frontmatter title of type ${describeType(rawTitle)}: expected a string`
  );
}

/**
 * Derive a title from the file name
 */
function fallbackTitle(file: ContentFile): string {
  return file.relativePath
    .split('/').pop()
    ?.replace(/\.(md|markdown)$/, '')
    .replace(/-/g, ' ') || 'Untitled';
}

function describeType(value: unknown): string {
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Replace the whole table in one write transaction.
 *
 * `batch()` wraps its statements in a transaction and rolls the whole group
 * back if any statement fails, so the table either holds the new document set
 * or is left exactly as it was. Unlike `transaction()`, it also works with
 * in-memory clients, which drop their connection when a transaction is opened.
 *
 * `documents` is consumed: each document is released as its statement is built,
 * so the embedding arrays are collectable instead of being held alongside the
 * statements. Peak memory still covers the whole corpus, and the batch is a
 * single request for remote clients.
 */
async function replaceIndex(
  client: Client,
  quotedTableName: string,
  documents: Array<BuiltDocument | undefined>,
  failures: IndexFailure[]
): Promise<void> {
  const statements: InStatement[] = [`DELETE FROM ${quotedTableName}`];

  try {
    for (let i = 0; i < documents.length; i++) {
      const document = documents[i];

      if (document !== undefined) {
        statements.push(createInsertStatement(document, quotedTableName));
        documents[i] = undefined;
      }
    }
  } finally {
    // The array is owned by this function, so it is emptied even if statement
    // building throws part way through
    documents.length = 0;
  }

  try {
    await client.batch(statements, 'write');
  } catch (error) {
    throw new IndexingError(
      `Failed to replace the contents of ${quotedTableName}. The transaction was rolled back ` +
        `and the existing index was left unchanged.`,
      'replace',
      failures,
      { cause: toError(error) }
    );
  }
}

/**
 * Build the insert statement for one document
 */
function createInsertStatement(
  document: BuiltDocument,
  quotedTableName: string
): InStatement {
  return {
    sql: `INSERT INTO ${quotedTableName}
          (slug, title, content, folder, tags, embedding, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, vector(?), datetime('now'), datetime('now'))`,
    args: [
      document.slug,
      document.title,
      document.content,
      document.folder,
      document.serializedTags,
      JSON.stringify(document.embedding)
    ]
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Create the articles table if it doesn't exist
 */
export async function createTable(
  client: Client,
  tableName: string = 'articles',
  dimensions: number = 384
): Promise<void> {
  const quotedTableName = quoteSqlIdentifier(tableName, 'tableName');
  const vectorDimensions = normalizeVectorDimensions(dimensions);
  const quotedEmbeddingIndexName = quoteSqlIdentifier(`${tableName}_embedding_idx`, 'embedding index name');
  const quotedFolderIndexName = quoteSqlIdentifier(`${tableName}_folder_idx`, 'folder index name');
  const quotedSlugIndexName = quoteSqlIdentifier(`${tableName}_slug_idx`, 'slug index name');

  await client.execute(`
    CREATE TABLE IF NOT EXISTS ${quotedTableName} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT 'root',
      tags TEXT DEFAULT '[]',
      embedding F32_BLOB(${vectorDimensions}),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS ${quotedEmbeddingIndexName}
    ON ${quotedTableName}(libsql_vector_idx(embedding))
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS ${quotedFolderIndexName}
    ON ${quotedTableName}(folder)
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS ${quotedSlugIndexName}
    ON ${quotedTableName}(slug)
  `);
}
