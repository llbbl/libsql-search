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
}
```

- `provider` defaults to `"local"`
- `dimensions` defaults to `768`
- `maxLength` defaults to `8000`
- `apiKey` is optional in code, but required for hosted providers unless the
  matching environment variable is available

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
- use the same dimension count in `createTable()`

## Dimension Guidelines

- `768` is the easiest cross-provider target in the current implementation
- local embeddings are padded from 384 to your target size
- Gemini stays at 768
- OpenAI can be used at 1536 or 3072, or another supported OpenAI dimension
  value you explicitly set

If you switch provider or dimensions for an existing table, recreate the table
or rebuild the index into a separate table so stored vectors stay consistent.
