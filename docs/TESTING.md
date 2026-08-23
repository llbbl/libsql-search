# Testing Guidance

Routine unit tests and CI should not make live embedding-provider calls and should not require real provider credentials.

## Repository Policy

- no live provider keys in unit tests or CI
- no routine network calls to hosted embedding providers in CI
- validate option handling and response parsing with mocks first
- assert failures happen before network calls when configuration is invalid

The current test suite follows that pattern in `tests/embeddings.test.ts` and [`tests/huggingface-transformers.mock.ts`](../tests/huggingface-transformers.mock.ts).

## Local Provider Mocks

The local provider should use a lightweight Transformers.js mock instead of downloading the real model during routine tests.

```ts
import {
  huggingFaceTransformersMock,
  resetHuggingFaceTransformersMock,
} from "./huggingface-transformers.mock.js";

beforeEach(() => {
  resetHuggingFaceTransformersMock();
});
```

The repository source file is `huggingface-transformers.mock.ts`. The example keeps the `.js` import suffix because this repo's ESM TypeScript source uses explicit `.js` relative imports that resolve after compilation.

Test the contract you care about:

- the library requests `Xenova/all-MiniLM-L6-v2`
- the call uses `pooling: "mean"` and `normalize: true`
- non-`384` local dimensions fail before runtime loading

## HTTP Provider Mocks

Cloudflare, Mistral, OpenAI, and `openai-compatible` should use `fetch` mocks.

```ts
import { vi } from "vitest";

const fetchMock = vi.fn().mockResolvedValue({
  ok: true,
  headers: new Headers(),
  json: async () => ({
    data: [
      { index: 0, embedding: [1, 2] },
      { index: 1, embedding: [3, 4] },
    ],
  }),
});

vi.stubGlobal("fetch", fetchMock);
```

Useful assertions:

- request body includes the expected `model`
- OpenAI includes `dimensions`
- Mistral and `openai-compatible` include `encoding_format: "float"`
- `openai-compatible` chunking honors `batchSize`
- Cloudflare and Mistral reorder indexed responses correctly
- invalid config fails before `fetch` is called

## Gemini SDK Mocks

Gemini uses the `@google/genai` SDK, so routine tests should mock the SDK client rather than calling Google.

```ts
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    readonly models = {
      embedContent: vi.fn(async () => ({
        embeddings: [{ values: [1, 2, 3] }],
      })),
    };
  },
}));
```

Useful assertions:

- the adapter sends `gemini-embedding-2`
- document intent formats text as `title: none | text: ...`
- query intent formats text as `task: search result | query: ...`
- explicit dimensions are forwarded as `outputDimensionality`
- invalid dimensions fail before SDK work

## Environment Cleanup

Tests that touch provider credentials should save and restore environment variables so one case cannot leak into another:

```ts
let originalOpenAIKey: string | undefined;

beforeEach(() => {
  originalOpenAIKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (originalOpenAIKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalOpenAIKey;
  }
});
```

Apply the same pattern to `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN`.

## Validation-before-network Coverage

Prefer tests that prove bad inputs fail locally:

- unknown provider
- missing provider credentials
- blank credentials where trimming is expected
- invalid local dimensions
- invalid Gemini dimensions
- invalid `openai-compatible` `baseUrl`
- invalid `openai-compatible` `batchSize`
- OpenAI batches above `2048`

These checks keep CI fast and prove the library rejects bad inputs before it ships them to a provider.

## Optional Live Smoke Tests

If you want live provider smoke coverage, keep it outside routine CI:

- run it only when a developer explicitly opts in
- use dedicated throwaway credentials and test content
- isolate it from unit-test jobs
- expect provider cost and external data transfer

This repository does not require or expect live provider smoke tests for normal pull-request validation.
