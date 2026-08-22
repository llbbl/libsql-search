# Troubleshooting

Use the page that matches the failure mode:

- [Sharp native module issues](./TROUBLESHOOTING-SHARP.md)

Common operational checks:

- verify you called `createTable()` before indexing or searching
- verify the table dimension matches the embedding dimension in your code
- verify the same provider is used for indexing and querying
- verify hosted providers have `GEMINI_API_KEY` or `OPENAI_API_KEY` available
