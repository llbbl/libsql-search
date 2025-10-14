# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**libsql-search** is a TypeScript library that enables semantic search for static sites using libSQL/Turso with multi-provider embeddings. It supports local embeddings (Xenova/Transformers.js), Google Gemini, and OpenAI for generating vector embeddings.

## Key Commands

### Build and Development
```bash
# Build the library (TypeScript compilation)
pnpm build

# Watch mode for development
pnpm dev

# Pre-publish build
pnpm run prepublishOnly
```

### Publishing
- **npm**: Published as `libsql-search`
- **JSR**: Published as `@llbbl/libsql-search`

## Architecture

### Core Modules

The library consists of 3 main modules:

1. **embeddings.ts** - Multi-provider embedding generation
   - Local embeddings using Xenova/Transformers.js (`all-MiniLM-L6-v2` model, 384 dims → padded to 768)
   - Google Gemini embeddings (`text-embedding-004`, 768 dims native)
   - OpenAI embeddings (`text-embedding-3-small/large`, configurable dims)
   - Provider caching for performance
   - Text preparation utilities

2. **indexer.ts** - Content indexing pipeline
   - Recursive directory scanning for markdown files
   - Gray-matter frontmatter parsing
   - Batch embedding generation
   - libSQL database insertion with vector storage
   - Table creation with vector indexes

3. **search.ts** - Vector search and retrieval
   - Semantic search using `vector_distance_cos()`
   - CRUD operations for articles (getAll, getBySlug, getByFolder, getFolders)
   - Tag and folder-based filtering

### Data Flow

```
Markdown Files → Indexer → Generate Embeddings → Store in libSQL
                                                         ↓
User Query → Generate Query Embedding → Vector Search → Ranked Results
```

### Database Schema

The `articles` table (default name) has:
- `slug` (unique) - derived from file path
- `title` - from frontmatter or filename
- `content` - markdown body
- `folder` - directory structure
- `tags` - JSON array from frontmatter
- `embedding` - F32_BLOB vector (768 dims default)
- `created_at`, `updated_at` - timestamps

Indexes:
- Vector index on `embedding` for similarity search
- Standard indexes on `folder` and `slug`

### Embedding Dimensions

- **768 dimensions** is the standard across providers
- Local model outputs 384, padded to 768 via `padEmbedding()`
- Gemini natively outputs 768
- OpenAI supports custom dimensions (1536 for small, 3072 for large)

### TypeScript Configuration

- Target: ES2022
- Module: ES2022
- Output: `./dist` directory
- Source: `./src` directory
- Strict mode enabled
- Generates `.d.ts` declaration files

## Implementation Notes

### Provider Caching
Each embedding provider is cached in `providerCache` to avoid reloading models/clients on every request. The local Xenova model (~50MB) is downloaded on first use.

### Embedding Text Preparation
Use `prepareTextForEmbedding()` to combine frontmatter fields (title, description, tags) with content. This improves search quality by weighting metadata.

### Vector Search
libSQL's `vector_distance_cos()` returns cosine distance (lower = more similar). Results are ordered by ascending distance.

### File Processing
- Markdown files are discovered recursively
- Excludes: `node_modules`, `.git`, `dist`, `build`
- Default extensions: `.md`, `.markdown`
- Slugs are generated from relative file paths
- Frontmatter is parsed with gray-matter

### Database Operations
- `createTable()` must be called before indexing
- `indexContent()` clears existing data with `DELETE FROM ${tableName}` before re-indexing
- All vector operations use `vector()` function for insertion and `vector_distance_cos()` for search