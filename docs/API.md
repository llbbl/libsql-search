# API Reference

## Exports

`libsql-search` exports:

- `createTable`
- `indexContent`
- `search`
- `getAllArticles`
- `getArticleBySlug`
- `getArticlesByFolder`
- `getFolders`
- `generateEmbedding`
- `generateEmbeddings`
- `createEmbeddingProvider`
- `getEmbeddingProviderMetadata`
- `validateEmbeddingBatch`
- `padEmbedding`
- `prepareTextForEmbedding`

It also exports these types:

- `EmbeddingProvider`
- `EmbeddingIntent`
- `EmbeddingBatchMode`
- `EmbeddingBatchBehavior`
- `EmbeddingProviderMetadata`
- `EmbeddingRequestOptions`
- `EmbeddingProviderClient`
- `EmbeddingBatchResult`
- `EmbeddingBatchItemResult`
- `EmbeddingBatchItem`
- `EmbeddingOptions`
- `IndexerOptions`
- `IndexedDocument`
- `SearchOptions`
- `SearchResult`

## `createTable(client, tableName?, dimensions?)`

Creates the table and supporting indexes used by search.

```ts
await createTable(client, "articles", 768);
```

Defaults:

- `tableName`: `"articles"`
- `dimensions`: `768`

`tableName` must be an ASCII SQLite identifier matching
`[A-Za-z_][A-Za-z0-9_]*`. Valid identifiers are quoted internally, so reserved
words such as `"select"` are safe to use. `dimensions` must be a positive
integer.

The created schema includes:

- `id` primary key
- `slug`
- `title`
- `content`
- `folder`
- `tags`
- `embedding`
- `created_at`
- `updated_at`

## `indexContent(options)`

Indexes Markdown files from a directory on disk.

```ts
interface IndexerOptions {
  client: Client;
  contentPath: string;
  embeddingOptions?: EmbeddingOptions;
  fileExtensions?: string[];
  exclude?: string[];
  tableName?: string;
  onProgress?: (current: number, total: number, file: string) => void;
}
```

Defaults:

- `fileExtensions`: [".md", ".markdown"]
- `exclude`: ["node_modules", ".git", "dist", "build"]
- `tableName`: `"articles"`

`tableName` follows the same identifier policy as `createTable()`.

Return shape:

```ts
{
  success: number;
  failed: number;
  total: number;
}
```

Behavior notes:

- `indexContent()` deletes existing rows in the target table before rebuilding
- frontmatter `title`, `description`, and `tags` are folded into the embedding
  text
- embeddings default to `intent: "document"` unless `embeddingOptions.intent`
  is set explicitly
- if a file has no frontmatter title, the filename becomes the title

## `search(options)`

Generates a query embedding and performs vector similarity search.

```ts
interface SearchOptions {
  client: Client;
  query: string;
  limit?: number;
  tableName?: string;
  embeddingOptions?: EmbeddingOptions;
}
```

Defaults:

- `limit`: `10`
- `tableName`: `"articles"`

`limit` must be an integer from `1` through `100`; invalid values are rejected
before query embedding generation. `tableName` follows the same identifier
policy as `createTable()`.

Result shape:

```ts
interface SearchResult {
  id: number;
  slug: string;
  title: string;
  content: string;
  folder: string;
  tags: string[];
  distance: number;
  created_at: string;
}
```

Lower `distance` values are better matches.

Search embeddings default to `intent: "query"` unless
`embeddingOptions.intent` is set explicitly.

## Article Retrieval Helpers

### `getAllArticles(client, tableName?)`

Returns all indexed articles ordered by title.

### `getArticleBySlug(client, slug, tableName?)`

Returns one article or `null`.

### `getArticlesByFolder(client, folder, tableName?)`

Returns articles in a specific folder.

### `getFolders(client, tableName?)`

Returns distinct folder names from the index.

All article retrieval helpers validate `tableName` before executing SQL.

## Embedding Helpers

### `generateEmbedding(text, options?)`

Generates an embedding for arbitrary text using the selected provider.

### `generateEmbeddings(texts, options?)`

Generates an ordered batch of embeddings. Empty batches return `[]` without
creating a hosted provider client or making a network request.

### `createEmbeddingProvider(options?)`

Creates a provider client with immutable metadata and an `embed(texts, options?)`
method. Provider clients return a rich `EmbeddingBatchResult`; the compatibility
helpers `generateEmbedding()` and `generateEmbeddings()` continue returning only
vectors.

```ts
const provider = createEmbeddingProvider({
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
  dimensions: 1536,
});

console.log(provider.metadata);
```

Provider metadata includes:

- `name`
- `model`
- `dimensions`
- `batch.mode`
- `batch.maxSize`, when the provider has a hard maximum

Hosted provider clients are scoped to their options. The library does not reuse
a Cloudflare, Mistral, Gemini, or OpenAI client created with different
credentials or configuration.

### `getEmbeddingProviderMetadata(options?)`

Returns the same metadata exposed by `createEmbeddingProvider(options).metadata`
without resolving hosted-provider credentials.

Provider batch metadata uses:

```ts
type EmbeddingBatchMode = "native" | "sequential";

interface EmbeddingBatchBehavior {
  mode: EmbeddingBatchMode;
  maxSize?: number;
}
```

`"native"` means the upstream provider accepts the batch in one request.
`"sequential"` means the library accepts an input batch but processes items one
at a time. If `maxSize` is present, the library enforces it before provider or
network work.

Provider clients return:

```ts
interface EmbeddingBatchResult {
  embeddings: number[][];
  provider: "local" | "cloudflare" | "mistral" | "gemini" | "openai";
  model: string;
  dimensions: number;
  intent: "document" | "query";
}
```

### `validateEmbeddingBatch(items, expectedCount, expectedDimensions, provider)`

Validates provider results before they are written to the database. It checks
cardinality, dimensions, finite numeric values, and indexed batch ordering.

`EmbeddingOptions` supports:

```ts
interface EmbeddingOptions {
  provider?: "local" | "cloudflare" | "mistral" | "gemini" | "openai";
  apiKey?: string;
  accountId?: string;
  apiToken?: string;
  dimensions?: number;
  maxLength?: number;
  intent?: "document" | "query";
  timeoutMs?: number;
  signal?: AbortSignal;
}
```

`apiKey` is used by Mistral, Gemini, and OpenAI. It falls back to
`MISTRAL_API_KEY`, `GEMINI_API_KEY`, or `OPENAI_API_KEY` for those providers.
Cloudflare uses `accountId` and `apiToken`, which fall back to
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`.

### `padEmbedding(embedding, targetDimensions)`

Pads or truncates an embedding array to the requested length.

### `prepareTextForEmbedding(fields)`

Combines title, description, tags, and content into the text sent to the
embedding model.

```ts
const text = prepareTextForEmbedding({
  title: "My Article",
  description: "How semantic search works",
  tags: ["search", "turso"],
  content: "# Content",
});
```
