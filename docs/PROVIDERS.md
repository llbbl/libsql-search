# Embedding Providers

`libsql-search` currently supports five embedding providers:

- `local`
- `cloudflare`
- `mistral`
- `gemini`
- `openai`

Use the same provider and dimensions for both indexing and querying. A mismatch
between stored vectors and query vectors will break search quality or fail at
query time.

## Shared Options

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

- `provider` defaults to `"local"`
- `dimensions` defaults to `768` for the library's default local provider.
  Provider-specific defaults can differ; Gemini defaults to `3072`.
- `maxLength` defaults to `8000`
- `intent` can be `"document"` or `"query"`; indexing defaults to
  `"document"` and search defaults to `"query"` unless explicitly set
- `timeoutMs` defaults to `30000`
- `apiKey` is used by Mistral, Gemini, and OpenAI and falls back to
  `MISTRAL_API_KEY`, `GEMINI_API_KEY`, or `OPENAI_API_KEY`
- `accountId` and `apiToken` are used by Cloudflare and fall back to
  `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`

## Provider Contract

Each provider exposes immutable metadata:

```ts
interface EmbeddingProviderMetadata {
  name: "local" | "cloudflare" | "mistral" | "gemini" | "openai";
  model: string;
  dimensions: number;
  batch: {
    mode: "native" | "sequential";
    maxSize?: number;
  };
}
```

Use `getEmbeddingProviderMetadata(options)` or
`createEmbeddingProvider(options).metadata` to inspect the effective model,
dimensions, and batch behavior. Metadata inspection does not require hosted
provider credentials.

Batch modes:

- `"native"` means the upstream provider accepts the batch in one request
- `"sequential"` means the library accepts a batch and processes items one at a
  time
- when `maxSize` is present, it is a hard maximum enforced before provider or
  network work

`generateEmbeddings(texts, options)` returns vectors in the same order as the
input texts. Provider responses are validated before database writes:

- result count must match input count
- each vector must match the provider's effective dimensions
- every vector value must be a finite number
- indexed batch responses must contain unique contiguous indices and are
  reordered before being returned

Empty batches return `[]` without loading a local model, creating hosted clients,
or making network calls.

Lower-level provider clients return an `EmbeddingBatchResult` with the validated
vectors plus provider, model, dimensions, and intent. The compatibility helpers
`generateEmbedding()` and `generateEmbeddings()` return only arrays.

Cloudflare, Mistral, Gemini, and OpenAI clients are scoped to their current
options. They are not cached globally across different credentials or
configurations. The local Xenova model can be cached by model name.

Hosted provider failures are reported with bounded provider/status/request-id
context and without raw upstream bodies, credentials, Authorization headers, or
full URLs with query strings.

## Local

Provider value: `local`

The local provider loads `Xenova/all-MiniLM-L6-v2` through
`@xenova/transformers`.

```ts
embeddingOptions: {
  provider: "local",
  dimensions: 768,
}
```

Notes:

- the model emits 384 dimensions and `libsql-search` pads or truncates to your
  requested size
- metadata reports the requested output dimensions
- batch metadata is `{ mode: "sequential" }`
- the first run downloads the model and can take longer on a fresh machine
- no API key is required
- this remains the default provider for backward compatibility and offline use

## Cloudflare Workers AI

Provider value: `cloudflare`

Cloudflare is the recommended hosted provider for low-cost Markdown search.
It uses Workers AI `@cf/baai/bge-m3` through Cloudflare's OpenAI-compatible
embeddings endpoint.

```ts
embeddingOptions: {
  provider: "cloudflare",
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
}
```

Behavior:

- if `accountId` is omitted, the library reads `CLOUDFLARE_ACCOUNT_ID`
- if `apiToken` is omitted, the library reads `CLOUDFLARE_API_TOKEN`
- blank Cloudflare credentials are treated as missing
- `@cf/baai/bge-m3` returns 1024 dimensions
- metadata reports `@cf/baai/bge-m3` and 1024 dimensions without requiring
  credentials
- batch metadata is `{ mode: "native" }`
- response items are reordered by provider-supplied index before being returned
- Cloudflare does not accept custom dimensions in this provider; use
  `createTable(client, "articles", 1024)` for Cloudflare-backed indexes

## Mistral

Provider value: `mistral`

Mistral uses the hosted `mistral-embed` model through
`https://api.mistral.ai/v1/embeddings`.

```ts
embeddingOptions: {
  provider: "mistral",
  apiKey: process.env.MISTRAL_API_KEY,
}
```

Behavior:

- if `apiKey` is omitted, the library reads `MISTRAL_API_KEY`
- blank Mistral credentials are treated as missing
- `mistral-embed` returns 1024 dimensions
- metadata reports `mistral-embed` and 1024 dimensions without requiring
  credentials
- batch metadata is `{ mode: "native" }`
- request bodies send `encoding_format: "float"`
- response items are reordered by provider-supplied index before being returned
- Mistral does not accept custom dimensions in this provider; use
  `createTable(client, "articles", 1024)` for Mistral-backed indexes

## Gemini

Provider value: `gemini`

Gemini uses Google `gemini-embedding-2` through `@google/genai`.

```ts
embeddingOptions: {
  provider: "gemini",
  apiKey: process.env.GEMINI_API_KEY,
  dimensions: 3072,
}
```

Behavior:

- if `apiKey` is omitted, the library reads `GEMINI_API_KEY`
- blank Gemini credentials are treated as missing
- Gemini defaults to 3072 dimensions
- explicit Gemini dimensions must be integers from 128 through 3072
- 768, 1536, and 3072 are recommended practical sizes
- metadata reports `gemini-embedding-2` and the effective dimensions
- batch metadata is `{ mode: "sequential" }`
- the library sends one SDK request per input and verifies one vector per input
- document inputs are formatted as `title: none | text: ...`
- query inputs are formatted as `task: search result | query: ...`
- the current implementation does not expose custom model selection

## OpenAI

Provider value: `openai`

OpenAI uses `text-embedding-3-small` when `dimensions <= 1536` and
`text-embedding-3-large` when `dimensions > 1536`.

```ts
embeddingOptions: {
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
  dimensions: 1536,
}
```

Behavior:

- if `apiKey` is omitted, the library reads `OPENAI_API_KEY`
- the request sends the `dimensions` value to the OpenAI embeddings API
- metadata reports `text-embedding-3-small` when `dimensions <= 1536` and
  `text-embedding-3-large` when `dimensions > 1536`
- batch metadata is `{ mode: "native", maxSize: 2048 }`
- use the same dimension count in `createTable()`

## Dimension Guidelines

- `local` defaults to `768`
- `cloudflare` is fixed at `1024`
- `mistral` is fixed at `1024`
- local embeddings are padded from 384 to your target size
- Gemini defaults to `3072` and accepts explicit dimensions from `128` through
  `3072`; use `768`, `1536`, or `3072` unless you have a specific reason
- OpenAI can be used at 1536 or 3072, or another supported OpenAI dimension
  value you explicitly set

If you switch provider or dimensions for an existing table, recreate the table
or rebuild the index into a separate table so stored vectors stay consistent.

Existing Gemini indexes created with `text-embedding-004` must be fully
re-embedded for `gemini-embedding-2`, even if you keep `dimensions: 768`,
because both the model and query/document input formatting changed. If you move
to the new 3072-dimensional default, create a new table or recreate the vector
table first; `indexContent()` clears rows but does not change the `F32_BLOB`
width. A separate table is safer because rebuilds are not transactional.
