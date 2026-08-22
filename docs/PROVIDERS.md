# Embedding Providers

`libsql-search` currently supports three embedding providers:

- `local`
- `gemini`
- `openai`

Use the same provider and dimensions for both indexing and querying. A mismatch
between stored vectors and query vectors will break search quality or fail at
query time.

## Shared Options

```ts
interface EmbeddingOptions {
  provider?: "local" | "gemini" | "openai";
  apiKey?: string;
  dimensions?: number;
  maxLength?: number;
  intent?: "document" | "query";
  timeoutMs?: number;
  signal?: AbortSignal;
}
```

- `provider` defaults to `"local"`
- `dimensions` defaults to `768`
- `maxLength` defaults to `8000`
- `intent` can be `"document"` or `"query"`; indexing defaults to
  `"document"` and search defaults to `"query"` unless explicitly set
- `timeoutMs` defaults to `30000`
- `apiKey` is optional in code, but required for hosted providers unless the
  matching environment variable is available

## Provider Contract

Each provider exposes immutable metadata:

```ts
interface EmbeddingProviderMetadata {
  name: "local" | "gemini" | "openai";
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

Gemini and OpenAI clients are scoped to their current options. They are not
cached globally across different credentials or configurations. The local Xenova
model can be cached by model name.

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

## Gemini

Provider value: `gemini`

Gemini uses Google `text-embedding-004`.

```ts
embeddingOptions: {
  provider: "gemini",
  apiKey: process.env.GEMINI_API_KEY,
}
```

Behavior:

- if `apiKey` is omitted, the library reads `GEMINI_API_KEY`
- Gemini returns 768 dimensions natively
- metadata reports `text-embedding-004` and 768 dimensions
- batch metadata is `{ mode: "sequential" }`
- the current implementation does not expose model selection

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

- `768` is the easiest cross-provider target in the current implementation
- local embeddings are padded from 384 to your target size
- Gemini stays at 768
- OpenAI can be used at 1536 or 3072, or another supported OpenAI dimension
  value you explicitly set

If you switch provider or dimensions for an existing table, recreate the table
or rebuild the index into a separate table so stored vectors stay consistent.
