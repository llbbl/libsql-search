# libsql-search

Semantic search for static sites using libSQL/Turso with multi-provider embeddings.

Add AI-powered vector search to your Astro, Next.js, or any static site with minimal configuration. Index markdown content, generate embeddings locally or via API, and provide lightning-fast semantic search to your users.

## Features

- 🔍 **Semantic Search** - Find content by meaning, not just keywords
- 🌐 **Multi-Provider Embeddings** - Choose local (Xenova), Gemini, or OpenAI
- ⚡ **Edge-Ready** - Works with Turso's global edge database
- 📝 **Markdown Support** - Built-in gray-matter parsing
- 🎯 **Type-Safe** - Full TypeScript support
- 🆓 **Free Tier Friendly** - Local embeddings require no API keys

## Installation

**npm:**
```bash
npm install libsql-search @libsql/client
```

**pnpm:**
```bash
pnpm add libsql-search @libsql/client
```

**JSR:**
```bash
deno add @llbbl/libsql-search
```

## Quick Start

### 1. Set Up Your Database

```typescript
import { createClient } from '@libsql/client';
import { createTable } from 'libsql-search';

const client = createClient({
  url: 'libsql://your-db.turso.io',
  authToken: 'your-auth-token'
});

// Create the articles table with vector index
await createTable(client, 'articles', 768);
```

### 2. Index Your Content

```typescript
import { indexContent } from 'libsql-search';

const result = await indexContent({
  client,
  contentPath: './content',
  embeddingOptions: {
    provider: 'local', // or 'gemini', 'openai'
    dimensions: 768
  },
  onProgress: (current, total, file) => {
    console.log(`[${current}/${total}] Indexing: ${file}`);
  }
});

console.log(`Indexed ${result.success}/${result.total} documents`);
```

### 3. Search Your Content

```typescript
import { search } from 'libsql-search';

const results = await search({
  client,
  query: 'how to deploy astro',
  limit: 5,
  embeddingOptions: {
    provider: 'local'
  }
});

results.forEach(result => {
  console.log(`${result.title} (${result.distance})`);
});
```

## Embedding Providers

### Local (Xenova/Transformers.js)

**Free, no API key required**. Runs `all-MiniLM-L6-v2` in Node.js using ONNX.

```typescript
embeddingOptions: {
  provider: 'local',
  dimensions: 768  // 384 native, padded to 768
}
```

**Pros:**
- ✅ No API costs
- ✅ No rate limits
- ✅ Works offline
- ✅ Privacy-friendly

**Cons:**
- ⚠️ First run downloads model (~50MB)
- ⚠️ Slower than API-based options
- ⚠️ Lower quality than large models

### Google Gemini

**Free tier: 1,500 requests/day**. Uses `text-embedding-004` model.

```typescript
embeddingOptions: {
  provider: 'gemini',
  apiKey: process.env.GEMINI_API_KEY,
  dimensions: 768  // native
}
```

**Pros:**
- ✅ Generous free tier
- ✅ High quality embeddings
- ✅ Fast

**Cons:**
- ⚠️ Requires API key
- ⚠️ Rate limited

### OpenAI

**Paid only**. Uses `text-embedding-3-small` or `text-embedding-3-large`.

```typescript
embeddingOptions: {
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY,
  dimensions: 1536  // or 3072 for large
}
```

**Pros:**
- ✅ Highest quality
- ✅ Very fast
- ✅ Configurable dimensions

**Cons:**
- ⚠️ Costs money ($0.02 per 1M tokens)
- ⚠️ Requires API key

## API Reference

### Indexing

#### `indexContent(options)`

Index markdown files from a directory.

```typescript
interface IndexerOptions {
  client: Client;                    // libSQL client
  contentPath: string;               // Path to content directory
  embeddingOptions?: EmbeddingOptions;
  fileExtensions?: string[];         // Default: ['.md', '.markdown']
  exclude?: string[];                // Default: ['node_modules', '.git']
  tableName?: string;                // Default: 'articles'
  onProgress?: (current, total, file) => void;
}
```

#### `createTable(client, tableName?, dimensions?)`

Create the articles table with vector index.

### Searching

#### `search(options)`

Perform semantic search.

```typescript
interface SearchOptions {
  client: Client;
  query: string;
  limit?: number;                    // Default: 10
  tableName?: string;                // Default: 'articles'
  embeddingOptions?: EmbeddingOptions;
}
```

Returns `SearchResult[]`:

```typescript
interface SearchResult {
  id: number;
  slug: string;
  title: string;
  content: string;
  folder: string;
  tags: string[];
  distance: number;  // Lower is better
  created_at: string;
}
```

#### `getAllArticles(client, tableName?)`

Get all articles (useful for building static pages).

#### `getArticleBySlug(client, slug, tableName?)`

Get a single article by slug.

#### `getArticlesByFolder(client, folder, tableName?)`

Get all articles in a folder.

#### `getFolders(client, tableName?)`

Get all unique folders.

### Embeddings

#### `generateEmbedding(text, options?)`

Generate embeddings for arbitrary text.

```typescript
interface EmbeddingOptions {
  provider?: 'local' | 'gemini' | 'openai';
  apiKey?: string;
  dimensions?: number;
  maxLength?: number;  // Default: 8000
}
```

#### `prepareTextForEmbedding(fields)`

Combine multiple fields into embedding text.

```typescript
const text = prepareTextForEmbedding({
  title: 'My Article',
  description: 'A description',
  content: '# Content here',
  tags: ['astro', 'turso']
});
```

## Framework Integration

### Astro

**Search API Endpoint** (`src/pages/api/search.json.ts`):

```typescript
import type { APIRoute } from 'astro';
import { createClient } from '@libsql/client';
import { search } from 'libsql-search';

export const prerender = false;

const client = createClient({
  url: import.meta.env.TURSO_DB_URL,
  authToken: import.meta.env.TURSO_AUTH_TOKEN
});

export const POST: APIRoute = async ({ request }) => {
  const { query, limit = 10 } = await request.json();

  const results = await search({
    client,
    query,
    limit,
    embeddingOptions: { provider: 'local' }
  });

  return new Response(JSON.stringify({ results }), {
    headers: { 'Content-Type': 'application/json' }
  });
};
```

**Static Page Generation** (`src/pages/[...slug].astro`):

```astro
---
import { createClient } from '@libsql/client';
import { getAllArticles, getArticleBySlug } from 'libsql-search';

export const prerender = true;

const client = createClient({
  url: import.meta.env.TURSO_DB_URL,
  authToken: import.meta.env.TURSO_AUTH_TOKEN
});

export async function getStaticPaths() {
  const articles = await getAllArticles(client);
  return articles.map(article => ({
    params: { slug: article.slug }
  }));
}

const { slug } = Astro.params;
const article = await getArticleBySlug(client, slug);
---

<article>
  <h1>{article.title}</h1>
  <div set:html={article.content} />
</article>
```

### Next.js

**API Route** (`app/api/search/route.ts`):

```typescript
import { createClient } from '@libsql/client';
import { search } from 'libsql-search';
import { NextRequest } from 'next/server';

const client = createClient({
  url: process.env.TURSO_DB_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!
});

export async function POST(request: NextRequest) {
  const { query, limit = 10 } = await request.json();

  const results = await search({
    client,
    query,
    limit,
    embeddingOptions: { provider: 'local' }
  });

  return Response.json({ results });
}
```

**Static Generation** (`app/[slug]/page.tsx`):

```typescript
import { createClient } from '@libsql/client';
import { getAllArticles, getArticleBySlug } from 'libsql-search';

const client = createClient({
  url: process.env.TURSO_DB_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!
});

export async function generateStaticParams() {
  const articles = await getAllArticles(client);
  return articles.map(article => ({
    slug: article.slug
  }));
}

export default async function Page({ params }: { params: { slug: string } }) {
  const article = await getArticleBySlug(client, params.slug);

  return (
    <article>
      <h1>{article.title}</h1>
      <div dangerouslySetInnerHTML={{ __html: article.content }} />
    </article>
  );
}
```

## Best Practices

### Embedding Dimensions

- Use **768 dimensions** for best compatibility
- Local model outputs 384, automatically padded to 768
- Gemini outputs 768 natively
- OpenAI supports custom dimensions

### Index Updates

Create a script to re-index content:

```json
{
  "scripts": {
    "index": "node scripts/index.js",
    "build": "npm run index && astro build"
  }
}
```

### Search Quality

Improve search results:

1. **Include relevant fields** in embedding text (title, description, tags)
2. **Truncate long content** to avoid noise
3. **Use the same provider** for indexing and search
4. **Experiment with distance thresholds** (lower is better)

### Performance

- **Cache the embedding model** (done automatically)
- **Use edge databases** (Turso) for low latency
- **Implement search debouncing** in the UI
- **Limit result count** to 5-10 for best UX

## Examples

See the `/examples` directory for complete implementations:

- [Astro Documentation Site](./examples/astro-docs)
- [Next.js Blog](./examples/nextjs-blog)
- [CLI Indexer](./examples/cli-indexer)

## CLI Usage

For a standalone indexing script:

```javascript
// scripts/index.js
import { createClient } from '@libsql/client';
import { createTable, indexContent } from 'libsql-search';

const client = createClient({
  url: process.env.TURSO_DB_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

await createTable(client);

const result = await indexContent({
  client,
  contentPath: './content',
  embeddingOptions: {
    provider: process.env.EMBEDDING_PROVIDER || 'local'
  },
  onProgress: (current, total, file) => {
    console.log(`[${current}/${total}] ${file}`);
  }
});

console.log(`✅ Indexed ${result.success} documents`);
```

Run with:
```bash
node --env-file=.env scripts/index.js
```

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR on [GitHub](https://github.com/llbbl/libsql-search).

## Related Projects

- [Turso](https://turso.tech) - Edge SQLite database
- [libSQL](https://github.com/tursodatabase/libsql) - Open source SQLite fork
- [Astro](https://astro.build) - Static site framework
- [Transformers.js](https://huggingface.co/docs/transformers.js) - ML models in JavaScript

## Support

- [Documentation](https://github.com/llbbl/libsql-search)
- [Issues](https://github.com/llbbl/libsql-search/issues)
- [Discussions](https://github.com/llbbl/libsql-search/discussions)
