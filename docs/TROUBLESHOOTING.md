# Troubleshooting

Use the page that matches the failure mode:

- [Sharp native module issues](./TROUBLESHOOTING-SHARP.md)

Common operational checks:

- verify you called `createTable()` before indexing or searching
- verify the table dimension matches the embedding dimension in your code
- verify the same provider is used for indexing and querying
- verify hosted providers have `CLOUDFLARE_ACCOUNT_ID` and
  `CLOUDFLARE_API_TOKEN`, `MISTRAL_API_KEY`, `GEMINI_API_KEY`, or
  `OPENAI_API_KEY` available as required by the selected provider
- after upgrading an existing Gemini index, fully re-embed with
  `gemini-embedding-2`; for 3072-dimensional Gemini indexes, recreate the table
  or use a new table name before rebuilding
