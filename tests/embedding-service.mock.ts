import { vi } from 'vitest';
import type { EmbeddingOptions } from '../src/embeddings.js';

export const TEST_EMBEDDING_DIMENSIONS = 384;

export const TEST_EMBEDDING_OPTIONS = Object.freeze({
  provider: 'openai-compatible' as const,
  baseUrl: 'https://embeddings.example.test/v1',
  model: 'test-embedding-model',
  dimensions: TEST_EMBEDDING_DIMENSIONS
}) satisfies EmbeddingOptions;

function deterministicVector(text: string): number[] {
  const lower = text.toLowerCase();
  const vector = new Array(TEST_EMBEDDING_DIMENSIONS).fill(0);

  vector[0] = 0.01;

  if (lower.includes('static') || lower.includes('astro')) {
    vector[1] += 2;
  }

  if (lower.includes('react')) {
    vector[2] += 2;
  }

  if (lower.includes('typescript')) {
    vector[3] += 3;
  }

  if (lower.includes('programming')) {
    vector[4] += 1;
  }

  if (lower.includes('python')) {
    vector[5] += 2;
  }

  if (lower.includes('javascript')) {
    vector[6] += 1;
  }

  if (lower.includes('article') || lower.includes('content')) {
    vector[7] += 1;
  }

  return vector;
}

interface EmbeddingRequestBody {
  input: string[];
}

export const embeddingServiceMock = {
  texts: [] as string[],
  queuedVectors: [] as number[][],
  fetch: vi.fn()
};

export function resetEmbeddingServiceMock(): void {
  embeddingServiceMock.texts = [];
  embeddingServiceMock.queuedVectors = [];
  embeddingServiceMock.fetch.mockReset();
  embeddingServiceMock.fetch.mockImplementation(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as EmbeddingRequestBody;
    embeddingServiceMock.texts.push(...body.input);

    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        data: body.input.map((text, index) => ({
          index,
          embedding: embeddingServiceMock.queuedVectors.shift() ?? deterministicVector(text)
        }))
      })
    };
  });
  vi.stubGlobal('fetch', embeddingServiceMock.fetch);
}
