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
- `padEmbedding`
- `prepareTextForEmbedding`

It also exports these types:

- `EmbeddingProvider`
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
