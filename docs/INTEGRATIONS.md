# Integration Examples

These examples show the current exported API wired into common server-side flows. Start with the shared provider flow, then adapt the framework snippets to your app.

## Shared Provider Flow

Use one provider preset, one dimension count, and one table name per embedding space.

```ts
import { createClient } from "@libsql/client";
import { createTable, indexContent, search } from "libsql-search";

const client = createClient({
  url: process.env.TURSO_DB_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const providerConfig = {
  tableName: "articles_openai_1536",
  dimensions: 1536,
  embeddingOptions: {
    provider: "openai" as const,
    apiKey: process.env.OPENAI_API_KEY,
    dimensions: 1536,
  },
};

await createTable(client, providerConfig.tableName, providerConfig.dimensions);

await indexContent({
  client,
  contentPath: "./content",
  tableName: providerConfig.tableName,
  embeddingOptions: {
    ...providerConfig.embeddingOptions,
    intent: "document",
  },
});

const results = await search({
  client,
  tableName: providerConfig.tableName,
  query: "deployment checklist",
  limit: 5,
  embeddingOptions: {
    ...providerConfig.embeddingOptions,
    intent: "query",
  },
});
```

## Provider Presets

These presets keep credentials out of the source file while making dimensions and table names explicit. Hosted presets send content to external providers and may incur provider charges when you run indexing or search.

```ts
const providerPresets = {
  local: {
    tableName: "articles_local_384",
    dimensions: 384,
    embeddingOptions: {
      provider: "local" as const,
    },
  },
  cloudflare: {
    tableName: "articles_cf_bgem3_1024",
    dimensions: 1024,
    embeddingOptions: {
      provider: "cloudflare" as const,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      dimensions: 1024,
    },
  },
  mistral: {
    tableName: "articles_mistral_1024",
    dimensions: 1024,
    embeddingOptions: {
      provider: "mistral" as const,
      apiKey: process.env.MISTRAL_API_KEY,
      dimensions: 1024,
    },
  },
  gemini: {
    tableName: "articles_gemini_3072",
    dimensions: 3072,
    embeddingOptions: {
      provider: "gemini" as const,
      apiKey: process.env.GEMINI_API_KEY,
      dimensions: 3072,
    },
  },
  openai: {
    tableName: "articles_openai_1536",
    dimensions: 1536,
    embeddingOptions: {
      provider: "openai" as const,
      apiKey: process.env.OPENAI_API_KEY,
      dimensions: 1536,
    },
  },
  openaiCompatible: {
    tableName: "articles_tei_1024",
    dimensions: 1024,
    embeddingOptions: {
      provider: "openai-compatible" as const,
      baseUrl: process.env.EMBEDDING_BASE_URL,
      model: process.env.EMBEDDING_MODEL,
      dimensions: 1024,
      apiKey: process.env.EMBEDDING_API_KEY,
      batchSize: 32,
    },
  },
} as const;
```

Pick one preset and use its `tableName` and `dimensions` all the way through `createTable()`, `indexContent()`, and `search()`. Do not point two providers or two dimension counts at the same table.

## Astro Search Endpoint

```ts
import type { APIRoute } from "astro";
import { createClient } from "@libsql/client";
import { search } from "libsql-search";

export const prerender = false;

const client = createClient({
  url: import.meta.env.TURSO_DB_URL,
  authToken: import.meta.env.TURSO_AUTH_TOKEN,
});

export const POST: APIRoute = async ({ request }) => {
  const { query, limit = 10 } = await request.json();

  const results = await search({
    client,
    query,
    limit,
    tableName: "articles_local_384",
    embeddingOptions: {
      provider: "local",
      intent: "query",
    },
  });

  return new Response(JSON.stringify({ results }), {
    headers: { "Content-Type": "application/json" },
  });
};
```

## Astro Static Paths

```ts
import { createClient } from "@libsql/client";
import { getAllArticles, getArticleBySlug } from "libsql-search";

const client = createClient({
  url: import.meta.env.TURSO_DB_URL,
  authToken: import.meta.env.TURSO_AUTH_TOKEN,
});

export async function getStaticPaths() {
  const articles = await getAllArticles(client, "articles_local_384");

  return articles.map((article) => ({
    params: { slug: article.slug },
  }));
}

const article = await getArticleBySlug(client, "guides/getting-started", "articles_local_384");
```

## Next.js Route Handler

```ts
import { createClient } from "@libsql/client";
import { search } from "libsql-search";
import { NextRequest } from "next/server";

const client = createClient({
  url: process.env.TURSO_DB_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

export async function POST(request: NextRequest) {
  const { query, limit = 10 } = await request.json();

  const results = await search({
    client,
    query,
    limit,
    tableName: "articles_local_384",
    embeddingOptions: {
      provider: "local",
      intent: "query",
    },
  });

  return Response.json({ results });
}
```

## Next.js Static Params

```tsx
import { createClient } from "@libsql/client";
import { getAllArticles, getArticleBySlug } from "libsql-search";

const client = createClient({
  url: process.env.TURSO_DB_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

export async function generateStaticParams() {
  const articles = await getAllArticles(client, "articles_local_384");

  return articles.map((article) => ({
    slug: article.slug,
  }));
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = await getArticleBySlug(client, slug, "articles_local_384");

  return <article>{article?.title}</article>;
}
```

## Build-Time Index Script

```ts
import { createClient } from "@libsql/client";
import { createTable, indexContent } from "libsql-search";

const client = createClient({
  url: process.env.TURSO_DB_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const providerPresets = {
  local: {
    tableName: "articles_local_384",
    dimensions: 384,
    embeddingOptions: {
      provider: "local" as const,
    },
  },
  cloudflare: {
    tableName: "articles_cf_bgem3_1024",
    dimensions: 1024,
    embeddingOptions: {
      provider: "cloudflare" as const,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      dimensions: 1024,
    },
  },
  mistral: {
    tableName: "articles_mistral_1024",
    dimensions: 1024,
    embeddingOptions: {
      provider: "mistral" as const,
      apiKey: process.env.MISTRAL_API_KEY,
      dimensions: 1024,
    },
  },
  gemini: {
    tableName: "articles_gemini_3072",
    dimensions: 3072,
    embeddingOptions: {
      provider: "gemini" as const,
      apiKey: process.env.GEMINI_API_KEY,
      dimensions: 3072,
    },
  },
  openai: {
    tableName: "articles_openai_1536",
    dimensions: 1536,
    embeddingOptions: {
      provider: "openai" as const,
      apiKey: process.env.OPENAI_API_KEY,
      dimensions: 1536,
    },
  },
  "openai-compatible": {
    tableName: "articles_tei_1024",
    dimensions: 1024,
    embeddingOptions: {
      provider: "openai-compatible" as const,
      baseUrl: process.env.EMBEDDING_BASE_URL,
      model: process.env.EMBEDDING_MODEL,
      dimensions: 1024,
      apiKey: process.env.EMBEDDING_API_KEY,
      batchSize: 32,
    },
  },
} as const;

const provider = process.env.EMBEDDING_PROVIDER ?? "local";

if (!(provider in providerPresets)) {
  throw new Error(
    `Unknown EMBEDDING_PROVIDER: ${provider}. Expected one of ${Object.keys(providerPresets).join(", ")}`
  );
}

const preset = providerPresets[provider as keyof typeof providerPresets];

await createTable(client, preset.tableName, preset.dimensions);

await indexContent({
  client,
  contentPath: "./content",
  tableName: preset.tableName,
  embeddingOptions: {
    ...preset.embeddingOptions,
    intent: "document",
  },
});
```

## CI-safe Provider Coverage

Keep routine CI on mocks only:

```ts
import { vi } from "vitest";
import { generateEmbeddings } from "libsql-search";

vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
  ok: true,
  headers: new Headers(),
  json: async () => ({
    data: [
      { index: 0, embedding: [1, 2] },
      { index: 1, embedding: [3, 4] },
    ],
  }),
}));

await generateEmbeddings(["doc one", "doc two"], {
  provider: "openai-compatible",
  baseUrl: "https://tei.example.internal/v1",
  model: "tei-model",
  dimensions: 2,
});
```

The repository test suite should not require real provider credentials. See [Testing guidance](./TESTING.md) for local model mocks, Gemini SDK mocks, and validation-before-network assertions.
