# Integration Examples

These examples show the current exported API wired into typical server-side
routes. They are intentionally small so you can adapt them to your app.

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
    embeddingOptions: {
      provider: "local",
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
  const articles = await getAllArticles(client);

  return articles.map((article) => ({
    params: { slug: article.slug },
  }));
}

const article = await getArticleBySlug(client, "guides/getting-started");
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
    embeddingOptions: {
      provider: "local",
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
  const articles = await getAllArticles(client);

  return articles.map((article) => ({
    slug: article.slug,
  }));
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const article = await getArticleBySlug(client, slug);

  return <article>{article?.title}</article>;
}
```

## Build-Time Index Script

A small script is usually enough to rebuild the index before a site build.

```ts
import { createClient } from "@libsql/client";
import { createTable, indexContent } from "libsql-search";

const client = createClient({
  url: process.env.TURSO_DB_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const embeddingProvider =
  process.env.EMBEDDING_PROVIDER as
    | "local"
    | "cloudflare"
    | "mistral"
    | "gemini"
    | "openai"
    | "openai-compatible"
    | undefined;

const dimensionsByProvider = {
  local: 384,
  cloudflare: 1024,
  mistral: 1024,
  gemini: 3072,
  openai: 1536,
} as const;

const embeddingDimensions =
  embeddingProvider === "openai-compatible"
    ? Number(process.env.EMBEDDING_DIMENSIONS)
    : dimensionsByProvider[embeddingProvider ?? "local"];

await createTable(client, "articles", embeddingDimensions);

await indexContent({
  client,
  contentPath: "./content",
  embeddingOptions: {
    provider: embeddingProvider,
    baseUrl: process.env.EMBEDDING_BASE_URL,
    model: process.env.EMBEDDING_MODEL,
    dimensions: embeddingDimensions,
  },
});
```

Pair this with your framework build command so indexed content and deployed code
stay in sync.

When you use `openai-compatible`, keep `EMBEDDING_BASE_URL` as trusted
server-side configuration, not user request input. Recreate the vector table or
rebuild into a separate table whenever the provider, endpoint, model, or
dimension count changes; stored vectors and query vectors must come from the
same embedding space.
