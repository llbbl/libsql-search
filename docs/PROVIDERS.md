# Embedding Providers

Use this page to choose an embedding provider, confirm the table width it needs, and understand what crosses a network boundary.

`libsql-search` supports these provider values:

- `local`
- `cloudflare`
- `mistral`
- `gemini`
- `openai`
- `openai-compatible`

## Shared Behavior

All providers share the same `EmbeddingOptions` surface:

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

Shared defaults and rules:

- `provider` defaults to `local`
- `maxLength` defaults to `8000` code units
- `timeoutMs` defaults to `30000`
- `indexContent()` defaults to `intent: "document"`
- `search()` defaults to `intent: "query"`
- `getEmbeddingProviderMetadata()` reports the effective provider, model, dimensions, and batch mode without making a hosted call
- use one embedding space per table: if provider, dimensions, model selection, endpoint, or formatting contract changes, build a new table and reindex

Intent behavior is intentionally narrow today:

- only the current Gemini adapter changes the formatted payload for `"document"` versus `"query"`
- all other providers still carry `intent` metadata through the API, but they embed the same text string either way

The `model` option is only used by `openai-compatible`.

## Provider Matrix

| Provider | Literal | Upstream model used by this adapter | Dimensions | Credentials | Batching | Network and privacy boundary | Cost and table planning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Local | `local` | `Xenova/all-MiniLM-L6-v2` | Fixed `384` | None | Sequential in-process | No hosted API call. First use may download model artifacts and cache them locally. | No hosted API bill. Table must be `F32_BLOB(384)`. |
| Cloudflare Workers AI | `cloudflare` | `@cf/baai/bge-m3` | Fixed `1024` | `accountId` and `apiToken`, or `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` | Native batch in one request | Indexed and queried text is sent to Cloudflare. | Check Cloudflare pricing before large rebuilds. Table must be `F32_BLOB(1024)`. |
| Mistral | `mistral` | `mistral-embed` | Fixed `1024` | `apiKey`, or `MISTRAL_API_KEY` | Native batch in one request | Indexed and queried text is sent to Mistral. | Check Mistral pricing before rebuilds. Table must be `F32_BLOB(1024)`. |
| Gemini | `gemini` | `gemini-embedding-2` | Default `3072`; allowed integers `128-3072` | `apiKey`, or `GEMINI_API_KEY` | Sequential SDK request per input | Indexed and queried text is sent to Google. The adapter currently rewrites payload text by intent. | Check Gemini pricing before rebuilds. Table width must match the chosen dimension count exactly. |
| OpenAI | `openai` | `text-embedding-3-small` when `dimensions <= 1536`, otherwise `text-embedding-3-large` | Default `768`; any positive integer accepted locally and forwarded as `dimensions` | `apiKey`, or `OPENAI_API_KEY` | Native batch in one request, max `2048` inputs | Indexed and queried text is sent to OpenAI. | Check OpenAI pricing before rebuilds. Table width must match the chosen dimension count exactly. |
| OpenAI-compatible | `openai-compatible` | Your configured `model` | Required positive integer; no default | `baseUrl`, `model`, and `dimensions` are required. `apiKey` is optional and never falls back to env. | Metadata reports `native`; outbound requests are chunked sequentially at `batchSize`, default `32` | Boundary depends on the operator behind `baseUrl`. Treat `baseUrl` as a trusted server-side setting and review HTTPS, SSRF, logging, and retention controls yourself. | Table width must match the configured `dimensions`. Any endpoint or model change should use a new table plus full reindex. |

## Provider Notes

### Local

```ts
embeddingOptions: {
  provider: "local",
}
```

- fixed at `384` dimensions
- rejects any other `dimensions` value before loading the runtime
- uses `@huggingface/transformers` lazily and caches the local pipeline by model name

References:

- [Transformers.js in Node.js](https://huggingface.co/docs/transformers.js/en/tutorials/node)
- [Transformers.js environment and cache controls](https://huggingface.co/docs/transformers.js/en/api/env)

### Cloudflare Workers AI

```ts
embeddingOptions: {
  provider: "cloudflare",
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
}
```

- fixed at `1024` dimensions
- uses the account-scoped Workers AI embeddings endpoint
- blank credentials are treated as missing

References:

- [Cloudflare `@cf/baai/bge-m3`](https://developers.cloudflare.com/workers-ai/models/bge-m3/)
- [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

### Mistral

```ts
embeddingOptions: {
  provider: "mistral",
  apiKey: process.env.MISTRAL_API_KEY,
}
```

- fixed at `1024` dimensions
- sends `encoding_format: "float"`
- expects indexed upstream responses

References:

- [Mistral embeddings guide](https://docs.mistral.ai/studio/knowledge-rag/embeddings/text_embeddings)
- [Mistral embeddings API reference](https://docs.mistral.ai/api/endpoint/embeddings)
- [Mistral model overview for `mistral-embed`](https://docs.mistral.ai/models/mistral-embed-23-12)

### Gemini

```ts
embeddingOptions: {
  provider: "gemini",
  apiKey: process.env.GEMINI_API_KEY,
  dimensions: 3072,
}
```

- defaults to `3072` dimensions
- accepts only integer dimensions from `128` through `3072`
- currently formats document inputs as `title: none | text: ...`
- currently formats query inputs as `task: search result | query: ...`
- sends one SDK request per input, even when you call `generateEmbeddings()`

References:

- [Gemini embeddings guide](https://ai.google.dev/gemini-api/docs/embeddings)
- [Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing)

### OpenAI

```ts
embeddingOptions: {
  provider: "openai",
  apiKey: process.env.OPENAI_API_KEY,
  dimensions: 1536,
}
```

- defaults to `768` dimensions
- uses `text-embedding-3-small` through `1536`
- uses `text-embedding-3-large` above `1536`
- rejects batches above `2048` inputs before any network request

References:

- [OpenAI embeddings guide](https://developers.openai.com/api/docs/guides/embeddings)
- [OpenAI embeddings API reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create/)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data#default-usage-policies-by-endpoint)
- [OpenAI models overview](https://developers.openai.com/api/docs/models)
- [OpenAI API pricing](https://openai.com/api/pricing/)

### OpenAI-compatible

```ts
embeddingOptions: {
  provider: "openai-compatible",
  baseUrl: process.env.EMBEDDING_BASE_URL,
  model: process.env.EMBEDDING_MODEL,
  dimensions: Number(process.env.EMBEDDING_DIMENSIONS),
  apiKey: process.env.EMBEDDING_API_KEY,
  batchSize: 32,
}
```

- `baseUrl`, `model`, and `dimensions` are required
- `baseUrl` must be an absolute `http` or `https` URL without URL credentials, query strings, or fragments
- the library normalizes `baseUrl` to an `/embeddings` endpoint
- `batchSize` defaults to `32` and controls outbound chunking
- `apiKey` is optional and never falls back to `OPENAI_API_KEY`

References:

- [Text Embeddings Inference quick tour](https://huggingface.co/docs/text-embeddings-inference/quick_tour)
- [Text Embeddings Inference CLI arguments](https://huggingface.co/docs/text-embeddings-inference/cli_arguments)

## Next Steps

- [Integration examples](./INTEGRATIONS.md) for end-to-end configuration flows
- [Migration guide](./MIGRATIONS.md) before changing widths, models, or endpoints
- [Testing guide](./TESTING.md) for CI-safe provider coverage
