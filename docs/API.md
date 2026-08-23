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

## Navigation

- [Provider matrix and credential rules](./PROVIDERS.md)
- [Migration and reindexing guide](./MIGRATIONS.md)
- [Indexing and operational behavior](./INDEXING.md)
- [Testing guidance](./TESTING.md)

## `createTable(client, tableName?, dimensions?)`

Creates the search table and supporting indexes.

```ts
await createTable(client);
```

Defaults:

- `tableName`: `"articles"`
- `dimensions`: `384`

`tableName` must be an ASCII SQLite identifier matching `[A-Za-z_][A-Za-z0-9_]*`. Valid identifiers are quoted internally, so reserved words such as `"select"` are safe to use. `dimensions` must be a positive integer.

The created schema includes:

- `id` primary key
- `slug`
- `title`
- `content`
- `folder`
- `tags`
- `embedding F32_BLOB(dimensions)`
- `created_at`
- `updated_at`

`createTable()` uses `CREATE TABLE IF NOT EXISTS`, so it does not resize an existing vector column. See [Migration and reindexing guide](./MIGRATIONS.md) before changing widths or providers.

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
- rebuilds are not transactional
- frontmatter `title`, `description`, and `tags` are folded into the embedding text
- embeddings default to `intent: "document"` unless `embeddingOptions.intent` is set explicitly
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

`limit` must be an integer from `1` through `100`; invalid values are rejected before query embedding generation.

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

Search embeddings default to `intent: "query"` unless `embeddingOptions.intent` is set explicitly.

## Article Retrieval Helpers

### `getAllArticles(client, tableName?)`

Returns all indexed articles ordered by title.

### `getArticleBySlug(client, slug, tableName?)`

Returns one article or `null`.

### `getArticlesByFolder(client, folder, tableName?)`

Returns articles in a specific folder.

### `getFolders(client, tableName?)`

Returns distinct folder names from the index.

All retrieval helpers validate `tableName` before executing SQL.

## Embedding Helpers

### `EmbeddingOptions`

```ts
interface EmbeddingOptions {
  provider?:
    | "local"
    | "cloudflare"
    | "mistral"
    | "gemini"
    | "openai"
    | "openai-compatible";
  apiKey?: string;
  accountId?: string;
  apiToken?: string;
  baseUrl?: string;
  model?: string;
  batchSize?: number;
  dimensions?: number;
  maxLength?: number;
  intent?: "document" | "query";
  timeoutMs?: number;
  signal?: AbortSignal;
}
```

Important option rules:

- `provider` defaults to `local`
- `maxLength` defaults to `8000`
- `timeoutMs` defaults to `30000`
- `model` is only used by `openai-compatible`
- `baseUrl`, `model`, and `dimensions` are required for `openai-compatible`
- `batchSize` only applies to `openai-compatible` and defaults to `32`
- `openai-compatible` never reads `OPENAI_API_KEY`
- only the Gemini adapter currently changes payload formatting by `intent`

Dimension rules:

- local: fixed `384`
- Cloudflare: fixed `1024`
- Mistral: fixed `1024`
- Gemini: default `3072`, allowed integer range `128-3072`
- OpenAI: default `768`; `text-embedding-3-small` through `1536`, `text-embedding-3-large` above `1536`
- OpenAI-compatible: required positive integer, no default

See [Provider matrix and credential rules](./PROVIDERS.md) for the canonical provider table.

### `generateEmbedding(text, options?)`

Generates one embedding vector.

```ts
const embedding = await generateEmbedding("deploy docs", {
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
  dimensions: 1536,
});
```

### `generateEmbeddings(texts, options?)`

Generates an ordered batch of embeddings.

- empty batches return `[]` without loading the local model or making a hosted call
- OpenAI batches above `2048` inputs are rejected before network work
- `openai-compatible` batches are chunked sequentially according to `batchSize`

### `createEmbeddingProvider(options?)`

Creates a provider client with immutable metadata and an `embed(texts, options?)` method.

```ts
const provider = createEmbeddingProvider({
  provider: "openai-compatible",
  baseUrl: "https://tei.example.internal/v1",
  model: "bge-large-en-v1.5",
  dimensions: 1024,
  batchSize: 32,
});

console.log(provider.metadata);
```

Provider clients return a rich `EmbeddingBatchResult`; the compatibility helpers `generateEmbedding()` and `generateEmbeddings()` return only vectors.

Hosted provider clients are scoped to their current options. The library does not reuse a Cloudflare, Mistral, Gemini, or OpenAI client across different credential sets or configurations.

### `getEmbeddingProviderMetadata(options?)`

Returns the same metadata exposed by `createEmbeddingProvider(options).metadata` without resolving hosted-provider credentials.

Metadata shape:

```ts
interface EmbeddingProviderMetadata {
  name:
    | "local"
    | "cloudflare"
    | "mistral"
    | "gemini"
    | "openai"
    | "openai-compatible";
  model: string;
  dimensions: number;
  batch: {
    mode: "native" | "sequential";
    maxSize?: number;
  };
}
```

Batch interpretation:

- `"native"` means the provider accepts a batch request upstream
- `"sequential"` means the library accepts a batch but processes items one-by-one
- `batch.maxSize` is a hard client-side limit when present

`openai-compatible` metadata reports `batch.mode: "native"` because the remote endpoint is expected to accept batch inputs, even though the library may split large arrays into sequential outbound chunks at `batchSize`.

### `EmbeddingBatchResult`

```ts
interface EmbeddingBatchResult {
  embeddings: number[][];
  provider:
    | "local"
    | "cloudflare"
    | "mistral"
    | "gemini"
    | "openai"
    | "openai-compatible";
  model: string;
  dimensions: number;
  intent: "document" | "query";
}
```

### `validateEmbeddingBatch(items, expectedCount, expectedDimensions, provider)`

Validates provider responses before they reach the database:

- result count must match the requested input count
- vectors must match the effective dimensions
- values must be finite numbers
- indexed provider responses are reordered and checked for contiguous indices

### `padEmbedding(embedding, targetDimensions)`

Pads or truncates a vector to the target width. This is exported for compatibility and migration workflows, but the current local provider uses its native `384` dimensions rather than padding by default.

### `prepareTextForEmbedding(fields)`

Builds the text that is embedded from title, description, content, and tags.
