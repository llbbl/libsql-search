import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EmbeddingOptions } from '../src/embeddings.js';
import {
  LOCAL_TEST_DIMENSIONS,
  huggingFaceTransformersMock,
  resetHuggingFaceTransformersMock
} from './huggingface-transformers.mock.js';

type EmbeddingsModule = typeof import('../src/embeddings.js');

let createEmbeddingProvider: EmbeddingsModule['createEmbeddingProvider'];
let generateEmbedding: EmbeddingsModule['generateEmbedding'];
let generateEmbeddings: EmbeddingsModule['generateEmbeddings'];
let getEmbeddingProviderMetadata: EmbeddingsModule['getEmbeddingProviderMetadata'];
let padEmbedding: EmbeddingsModule['padEmbedding'];
let prepareTextForEmbedding: EmbeddingsModule['prepareTextForEmbedding'];
let validateEmbeddingBatch: EmbeddingsModule['validateEmbeddingBatch'];

const geminiMock = vi.hoisted(() => ({
  keys: [] as string[],
  requests: [] as unknown[],
  embedContent: vi.fn(async (request: { contents: string; config?: { outputDimensionality?: number } }) => ({
    embeddings: [{
      values: new Array(request.config?.outputDimensionality ?? 3072).fill(request.contents.length)
    }]
  }))
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    readonly models: {
      embedContent: (request: unknown) => Promise<unknown>;
    };

    constructor(options: { apiKey?: string }) {
      geminiMock.keys.push(options.apiKey ?? '');
      this.models = {
        embedContent: (request: unknown) => {
          geminiMock.requests.push(request);
          return geminiMock.embedContent(request as { contents: string; config?: { outputDimensionality?: number } });
        }
      };
    }
  }
}));

interface GeminiMockRequest {
  model: string;
  contents: string;
  config?: {
    outputDimensionality?: number;
    abortSignal?: AbortSignal;
  };
}

function getGeminiRequests(): GeminiMockRequest[] {
  return geminiMock.requests as GeminiMockRequest[];
}

describe('embeddings', () => {
  let originalOpenAIKey: string | undefined;
  let originalGeminiKey: string | undefined;
  let originalMistralKey: string | undefined;
  let originalCloudflareAccountId: string | undefined;
  let originalCloudflareApiToken: string | undefined;

  beforeEach(async () => {
    originalOpenAIKey = process.env.OPENAI_API_KEY;
    originalGeminiKey = process.env.GEMINI_API_KEY;
    originalMistralKey = process.env.MISTRAL_API_KEY;
    originalCloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    originalCloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    vi.resetModules();
    resetHuggingFaceTransformersMock();
    ({
      createEmbeddingProvider,
      generateEmbedding,
      generateEmbeddings,
      getEmbeddingProviderMetadata,
      padEmbedding,
      prepareTextForEmbedding,
      validateEmbeddingBatch
    } = await import('../src/embeddings.js'));
    geminiMock.keys = [];
    geminiMock.requests = [];
    geminiMock.embedContent.mockReset();
    geminiMock.embedContent.mockImplementation(async (request: { contents: string; config?: { outputDimensionality?: number } }) => ({
      embeddings: [{
        values: new Array(request.config?.outputDimensionality ?? 3072).fill(request.contents.length)
      }]
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
    if (originalGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalGeminiKey;
    }
    if (originalMistralKey === undefined) {
      delete process.env.MISTRAL_API_KEY;
    } else {
      process.env.MISTRAL_API_KEY = originalMistralKey;
    }
    if (originalCloudflareAccountId === undefined) {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
    } else {
      process.env.CLOUDFLARE_ACCOUNT_ID = originalCloudflareAccountId;
    }
    if (originalCloudflareApiToken === undefined) {
      delete process.env.CLOUDFLARE_API_TOKEN;
    } else {
      process.env.CLOUDFLARE_API_TOKEN = originalCloudflareApiToken;
    }
  });

  describe('padEmbedding', () => {
    it('should pad embedding to target dimensions', () => {
      const embedding = [1, 2, 3];
      const padded = padEmbedding(embedding, 5);

      expect(padded).toHaveLength(5);
      expect(padded).toEqual([1, 2, 3, 0, 0]);
    });

    it('should truncate embedding if larger than target', () => {
      const embedding = [1, 2, 3, 4, 5];
      const truncated = padEmbedding(embedding, 3);

      expect(truncated).toHaveLength(3);
      expect(truncated).toEqual([1, 2, 3]);
    });

    it('should return same embedding if already at target dimensions', () => {
      const embedding = [1, 2, 3];
      const result = padEmbedding(embedding, 3);

      expect(result).toHaveLength(3);
      expect(result).toEqual([1, 2, 3]);
    });
  });

  describe('prepareTextForEmbedding', () => {
    it('should combine title, description, and content', () => {
      const text = prepareTextForEmbedding({
        title: 'My Title',
        description: 'My Description',
        content: 'My Content'
      });

      expect(text).toBe('My Title\n\nMy Description\n\nMy Content');
    });

    it('should include tags in the text', () => {
      const text = prepareTextForEmbedding({
        title: 'My Title',
        tags: ['tag1', 'tag2']
      });

      expect(text).toContain('Tags: tag1, tag2');
    });

    it('should handle missing fields', () => {
      const text = prepareTextForEmbedding({
        title: 'My Title'
      });

      expect(text).toBe('My Title');
    });

    it('should handle empty tags array', () => {
      const text = prepareTextForEmbedding({
        title: 'My Title',
        tags: []
      });

      expect(text).toBe('My Title');
    });
  });

  describe('generateEmbedding', () => {
    it('should generate local embeddings with native dimensions', async () => {
      const text = 'This is a test sentence for embedding generation';
      const embedding = await generateEmbedding(text, {
        provider: 'local'
      });

      expect(embedding).toBeInstanceOf(Array);
      expect(embedding.length).toBe(LOCAL_TEST_DIMENSIONS);
      expect(embedding.every(n => typeof n === 'number')).toBe(true);
      expect(huggingFaceTransformersMock.pipeline).toHaveBeenCalledWith(
        'feature-extraction',
        'Xenova/all-MiniLM-L6-v2'
      );
      expect(huggingFaceTransformersMock.calls[0]).toEqual({
        text,
        options: {
          pooling: 'mean',
          normalize: true
        }
      });
    });

    it('should truncate long text to maxLength', async () => {
      const longText = 'a'.repeat(10000);
      const embedding = await generateEmbedding(longText, {
        provider: 'local',
        maxLength: 100
      });

      expect(embedding).toBeInstanceOf(Array);
      expect(huggingFaceTransformersMock.calls[0]?.text).toHaveLength(100);
    });

    it('should throw error for unknown provider', async () => {
      await expect(
        generateEmbedding('test', { provider: 'unknown' as any })
      ).rejects.toThrow('Unknown embedding provider');
    });

    it('should throw error for Gemini without API key', async () => {
      await expect(
        generateEmbedding('test', { provider: 'gemini' })
      ).rejects.toThrow('GEMINI_API_KEY is required');

      await expect(
        generateEmbedding('test', {
          provider: 'gemini',
          apiKey: '   '
        })
      ).rejects.toThrow('GEMINI_API_KEY is required');
    });

    it('should throw error for OpenAI without API key', async () => {
      await expect(
        generateEmbedding('test', { provider: 'openai' })
      ).rejects.toThrow('OPENAI_API_KEY is required');
    });

    it('should throw error for Mistral without API key', async () => {
      await expect(
        generateEmbedding('test', { provider: 'mistral' })
      ).rejects.toThrow('MISTRAL_API_KEY is required');

      await expect(
        generateEmbedding('test', {
          provider: 'mistral',
          apiKey: '   '
        })
      ).rejects.toThrow('MISTRAL_API_KEY is required');
    });

    it('should throw error for Cloudflare without credentials', async () => {
      await expect(
        generateEmbedding('test', { provider: 'cloudflare' })
      ).rejects.toThrow('CLOUDFLARE_ACCOUNT_ID is required');

      await expect(
        generateEmbedding('test', {
          provider: 'cloudflare',
          accountId: '   '
        })
      ).rejects.toThrow('CLOUDFLARE_ACCOUNT_ID is required');

      await expect(
        generateEmbedding('test', {
          provider: 'cloudflare',
          accountId: 'account-id',
          apiToken: '   '
        })
      ).rejects.toThrow('CLOUDFLARE_API_TOKEN is required');
    });

    it('should use Deno env fallback for OpenAI API key', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [1, 2, 3] }] })
      });

      vi.stubGlobal('fetch', fetchMock);
      vi.stubGlobal('Deno', {
        env: {
          get: vi.fn((name: string) => name === 'OPENAI_API_KEY' ? 'deno-key' : undefined)
        }
      });

      const embedding = await generateEmbedding('test', {
        provider: 'openai',
        dimensions: 3
      });

      expect(embedding).toEqual([1, 2, 3]);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer deno-key'
          })
        })
      );
    });

    it('should keep missing OpenAI key error when Deno env access is denied', async () => {
      const fetchMock = vi.fn();

      vi.stubGlobal('fetch', fetchMock);
      vi.stubGlobal('Deno', {
        env: {
          get: vi.fn(() => {
            throw new Error('Requires env access');
          })
        }
      });

      await expect(
        generateEmbedding('test', { provider: 'openai' })
      ).rejects.toThrow('OPENAI_API_KEY is required');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('should use Node env fallback for Gemini API key after trimming it', async () => {
      process.env.GEMINI_API_KEY = '  node-gemini-key  ';

      const embedding = await generateEmbedding('test', {
        provider: 'gemini',
        dimensions: 128
      });

      expect(embedding).toHaveLength(128);
      expect(geminiMock.keys).toEqual(['node-gemini-key']);
    });

    it('should use Deno env fallback for Gemini API key', async () => {
      vi.stubGlobal('Deno', {
        env: {
          get: vi.fn((name: string) => name === 'GEMINI_API_KEY' ? 'deno-gemini-key' : undefined)
        }
      });

      const embedding = await generateEmbedding('test', {
        provider: 'gemini',
        dimensions: 128
      });

      expect(embedding).toHaveLength(128);
      expect(geminiMock.keys).toEqual(['deno-gemini-key']);
    });

    it('should use Node env fallback for Mistral API key after trimming it', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ data: [{ index: 0, embedding: new Array(1024).fill(1) }] })
      });

      process.env.MISTRAL_API_KEY = '  node-mistral-key  ';
      vi.stubGlobal('fetch', fetchMock);

      const embedding = await generateEmbedding('test', {
        provider: 'mistral'
      });

      expect(embedding).toHaveLength(1024);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.mistral.ai/v1/embeddings',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer node-mistral-key'
          })
        })
      );
    });

    it('should use Deno env fallback for Mistral API key', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ data: [{ index: 0, embedding: new Array(1024).fill(1) }] })
      });

      vi.stubGlobal('fetch', fetchMock);
      vi.stubGlobal('Deno', {
        env: {
          get: vi.fn((name: string) => name === 'MISTRAL_API_KEY' ? 'deno-mistral-key' : undefined)
        }
      });

      const embedding = await generateEmbedding('test', {
        provider: 'mistral'
      });

      expect(embedding).toHaveLength(1024);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.mistral.ai/v1/embeddings',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer deno-mistral-key'
          })
        })
      );
    });

    it('should use Deno env fallback for Cloudflare credentials', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          data: [{ index: 0, embedding: new Array(1024).fill(1) }]
        })
      });

      vi.stubGlobal('fetch', fetchMock);
      vi.stubGlobal('Deno', {
        env: {
          get: vi.fn((name: string) => {
            if (name === 'CLOUDFLARE_ACCOUNT_ID') {
              return 'deno-account';
            }

            return name === 'CLOUDFLARE_API_TOKEN' ? 'deno-token' : undefined;
          })
        }
      });

      const embedding = await generateEmbedding('test', {
        provider: 'cloudflare'
      });

      expect(embedding).toHaveLength(1024);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/deno-account/ai/v1/embeddings',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer deno-token'
          })
        })
      );
    });
  });

  describe('provider contract', () => {
    it('exposes stable provider metadata without provider calls', () => {
      expect(getEmbeddingProviderMetadata({
        provider: 'local'
      })).toEqual({
        name: 'local',
        model: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 384,
        batch: { mode: 'sequential' }
      });

      expect(getEmbeddingProviderMetadata({
        provider: 'local',
        dimensions: 384
      })).toEqual({
        name: 'local',
        model: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 384,
        batch: { mode: 'sequential' }
      });

      expect(getEmbeddingProviderMetadata({
        provider: 'gemini'
      })).toEqual({
        name: 'gemini',
        model: 'gemini-embedding-2',
        dimensions: 3072,
        batch: { mode: 'sequential' }
      });

      expect(getEmbeddingProviderMetadata({
        provider: 'gemini',
        dimensions: 768
      })).toEqual({
        name: 'gemini',
        model: 'gemini-embedding-2',
        dimensions: 768,
        batch: { mode: 'sequential' }
      });

      expect(getEmbeddingProviderMetadata({
        provider: 'openai',
        dimensions: 3072
      })).toEqual({
        name: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 3072,
        batch: { mode: 'native', maxSize: 2048 }
      });

      expect(getEmbeddingProviderMetadata({
        provider: 'cloudflare'
      })).toEqual({
        name: 'cloudflare',
        model: '@cf/baai/bge-m3',
        dimensions: 1024,
        batch: { mode: 'native' }
      });

      expect(getEmbeddingProviderMetadata({
        provider: 'mistral'
      })).toEqual({
        name: 'mistral',
        model: 'mistral-embed',
        dimensions: 1024,
        batch: { mode: 'native' }
      });

      expect(geminiMock.keys).toEqual([]);
    });

    it('returns immutable provider metadata', () => {
      const metadata = getEmbeddingProviderMetadata({ provider: 'local' });

      expect(Object.isFrozen(metadata)).toBe(true);
      expect(Object.isFrozen(metadata.batch)).toBe(true);
      expect(() => {
        (metadata as { dimensions: number }).dimensions = 768;
      }).toThrow(TypeError);
      expect(metadata.dimensions).toBe(384);
    });

    it('returns empty batches without provider setup or network work', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbeddings([], {
        provider: 'local'
      })).resolves.toEqual([]);

      await expect(generateEmbeddings([], {
        provider: 'openai'
      })).resolves.toEqual([]);

      await expect(generateEmbeddings([], {
        provider: 'cloudflare'
      })).resolves.toEqual([]);

      await expect(generateEmbeddings([], {
        provider: 'mistral'
      })).resolves.toEqual([]);

      await expect(generateEmbeddings([], {
        provider: 'gemini'
      })).resolves.toEqual([]);

      await expect(generateEmbeddings([], {
        provider: 'openai-compatible'
      })).resolves.toEqual([]);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(geminiMock.keys).toEqual([]);
      expect(huggingFaceTransformersMock.pipeline).not.toHaveBeenCalled();
    });

    it.each([768, 383, 385, 384.5, Number.NaN])('rejects invalid local dimensions %s before provider setup', async (dimensions) => {
      const expected = /Xenova\/all-MiniLM-L6-v2 returns 384 dimensions/;

      expect(() => getEmbeddingProviderMetadata({
        provider: 'local',
        dimensions
      })).toThrow(expected);

      await expect(generateEmbedding('test', {
        provider: 'local',
        dimensions
      })).rejects.toThrow(expected);

      expect(huggingFaceTransformersMock.pipeline).not.toHaveBeenCalled();
    });

    it('returns native local vectors exactly without zero padding', async () => {
      const vector = Array.from({ length: LOCAL_TEST_DIMENSIONS }, (_value, index) => index + 1);
      huggingFaceTransformersMock.queuedVectors = [vector];

      await expect(generateEmbedding('native vector', {
        provider: 'local'
      })).resolves.toEqual(vector);
    });

    it.each([
      {
        name: '383 dimensions',
        vector: new Array(383).fill(1),
        expected: /embedding 0 has 383 dimensions, expected 384/
      },
      {
        name: '385 dimensions',
        vector: new Array(385).fill(1),
        expected: /embedding 0 has 385 dimensions, expected 384/
      },
      {
        name: 'NaN value',
        vector: [Number.NaN, ...new Array(383).fill(1)],
        expected: /embedding 0 contains a non-finite value at dimension 0/
      },
      {
        name: 'Infinity value',
        vector: [Number.POSITIVE_INFINITY, ...new Array(383).fill(1)],
        expected: /embedding 0 contains a non-finite value at dimension 0/
      }
    ])('rejects local model output with $name', async ({ vector, expected }) => {
      huggingFaceTransformersMock.queuedVectors = [vector];

      await expect(generateEmbedding('bad vector', {
        provider: 'local'
      })).rejects.toThrow(expected);
    });

    it('preserves sequential local batch order', async () => {
      const first = new Array(LOCAL_TEST_DIMENSIONS).fill(1);
      const second = new Array(LOCAL_TEST_DIMENSIONS).fill(2);
      huggingFaceTransformersMock.queuedVectors = [first, second];

      await expect(generateEmbeddings(['first', 'second'], {
        provider: 'local'
      })).resolves.toEqual([first, second]);
      expect(huggingFaceTransformersMock.calls.map(call => call.text)).toEqual(['first', 'second']);
    });

    it('loads the local pipeline once for concurrent first calls', async () => {
      let resolvePipeline: (model: typeof huggingFaceTransformersMock.model) => void = () => {};
      huggingFaceTransformersMock.pipeline.mockImplementationOnce(async () =>
        new Promise<typeof huggingFaceTransformersMock.model>(resolve => {
          resolvePipeline = resolve;
        })
      );

      const first = generateEmbedding('first', { provider: 'local' });
      const second = generateEmbedding('second', { provider: 'local' });
      await vi.waitFor(() => {
        expect(huggingFaceTransformersMock.pipeline).toHaveBeenCalledTimes(1);
      });

      resolvePipeline(huggingFaceTransformersMock.model);
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(huggingFaceTransformersMock.pipeline).toHaveBeenCalledTimes(1);
    });

    it('evicts failed local pipeline loads so a later call can retry', async () => {
      huggingFaceTransformersMock.pipeline
        .mockRejectedValueOnce(new Error('download failed'))
        .mockResolvedValueOnce(huggingFaceTransformersMock.model);

      await expect(generateEmbedding('first', {
        provider: 'local'
      })).rejects.toThrow('download failed');

      await expect(generateEmbedding('second', {
        provider: 'local'
      })).resolves.toHaveLength(LOCAL_TEST_DIMENSIONS);
      expect(huggingFaceTransformersMock.pipeline).toHaveBeenCalledTimes(2);
    });

    it('aborts local inference before loading when the parent signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(generateEmbedding('test', {
        provider: 'local',
        signal: controller.signal
      })).rejects.toThrow('local embedding error: model inference was aborted');
      expect(huggingFaceTransformersMock.pipeline).not.toHaveBeenCalled();
    });

    it('times out local model loading when the runtime does not settle', async () => {
      vi.useFakeTimers();
      huggingFaceTransformersMock.pipeline.mockImplementationOnce(async () => new Promise(() => {}));

      const promise = generateEmbedding('test', {
        provider: 'local',
        timeoutMs: 10
      });
      const assertion = expect(promise).rejects.toThrow('local embedding error: model inference timed out after 10ms');
      await vi.advanceTimersByTimeAsync(10);

      await assertion;
      vi.useRealTimers();

      await expect(generateEmbedding('retry after timeout', {
        provider: 'local'
      })).resolves.toHaveLength(LOCAL_TEST_DIMENSIONS);
      expect(huggingFaceTransformersMock.pipeline).toHaveBeenCalledTimes(2);
    });

    it.each([128, 768, 1536, 3072])('accepts Gemini dimensions %i without credentials', (dimensions) => {
      expect(getEmbeddingProviderMetadata({
        provider: 'gemini',
        dimensions
      })).toEqual({
        name: 'gemini',
        model: 'gemini-embedding-2',
        dimensions,
        batch: { mode: 'sequential' }
      });

      expect(geminiMock.keys).toEqual([]);
    });

    it.each([127, 3073, 128.5, Number.NaN])('rejects invalid Gemini dimensions %s before SDK or credential work', async (dimensions) => {
      const expected = /gemini-embedding-2 supports dimensions from 128 to 3072/;

      expect(() => getEmbeddingProviderMetadata({
        provider: 'gemini',
        dimensions
      })).toThrow(expected);

      await expect(generateEmbedding('test', {
        provider: 'gemini',
        dimensions
      })).rejects.toThrow(expected);

      expect(geminiMock.keys).toEqual([]);
      expect(geminiMock.embedContent).not.toHaveBeenCalled();
    });

    it('exposes OpenAI-compatible metadata from explicit model and dimensions', () => {
      expect(getEmbeddingProviderMetadata({
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:8080/v1',
        model: 'tei-model',
        dimensions: 1024
      })).toEqual({
        name: 'openai-compatible',
        model: 'tei-model',
        dimensions: 1024,
        batch: { mode: 'native' }
      });
    });

    it.each([
      {
        name: 'baseUrl',
        options: { provider: 'openai-compatible', model: 'tei-model', dimensions: 1024 },
        expected: /Invalid baseUrl: expected a non-empty string/
      },
      {
        name: 'model',
        options: { provider: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', dimensions: 1024 },
        expected: /Invalid model: expected a non-empty string/
      },
      {
        name: 'dimensions',
        options: { provider: 'openai-compatible', baseUrl: 'http://localhost:8080/v1', model: 'tei-model' },
        expected: /Invalid dimensions: expected a positive integer/
      },
      {
        name: 'batchSize',
        options: {
          provider: 'openai-compatible',
          baseUrl: 'http://localhost:8080/v1',
          model: 'tei-model',
          dimensions: 1024,
          batchSize: 0
        },
        expected: /Invalid batchSize: expected a positive integer/
      }
    ])('rejects missing or invalid OpenAI-compatible $name before network work', async ({ options, expected }) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      expect(() => getEmbeddingProviderMetadata(options as EmbeddingOptions)).toThrow(expected);
      await expect(generateEmbedding('test', options as EmbeddingOptions)).rejects.toThrow(expected);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
      'localhost:8080/v1',
      'ftp://localhost:8080/v1',
      'http://user:pass@localhost:8080/v1',
      'http://localhost:8080/v1?api_key=secret',
      'http://localhost:8080/v1#fragment'
    ])('rejects unsafe OpenAI-compatible baseUrl without echoing it: %s', async (baseUrl) => {
      const options: EmbeddingOptions = {
        provider: 'openai-compatible',
        baseUrl,
        model: 'tei-model',
        dimensions: 1024
      };

      let message = '';
      try {
        getEmbeddingProviderMetadata(options);
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(/Invalid baseUrl/);
      expect(message).not.toContain(baseUrl);
      await expect(generateEmbedding('test', options)).rejects.toThrow(/Invalid baseUrl/);
    });

    it.each([
      ['http://localhost:8080/v1', 'http://localhost:8080/v1/embeddings'],
      ['http://localhost:8080/v1/', 'http://localhost:8080/v1/embeddings'],
      ['http://localhost:8080/v1/embeddings', 'http://localhost:8080/v1/embeddings']
    ])('normalizes OpenAI-compatible base URL %s', async (baseUrl, expectedUrl) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ data: [{ index: 0, embedding: [1, 2] }] })
      });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbedding('test', {
        provider: 'openai-compatible',
        baseUrl,
        apiKey: '  custom-key  ',
        model: 'tei-model',
        dimensions: 2
      })).resolves.toEqual([1, 2]);

      expect(fetchMock).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({
          method: 'POST',
          redirect: 'error',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer custom-key'
          })
        })
      );

      const request = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(request.body as string)).toEqual({
        input: ['test'],
        model: 'tei-model',
        dimensions: 2,
        encoding_format: 'float'
      });
    });

    it('omits OpenAI-compatible Authorization when apiKey is absent or blank and never reads OPENAI_API_KEY', async () => {
      process.env.OPENAI_API_KEY = 'env-openai-key';
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ data: [{ index: 0, embedding: [1, 2] }] })
      });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbedding('test', {
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:8080/v1',
        apiKey: '   ',
        model: 'tei-model',
        dimensions: 2
      })).resolves.toEqual([1, 2]);

      const request = fetchMock.mock.calls[0][1] as RequestInit;
      expect(request.headers).toEqual({
        'Content-Type': 'application/json'
      });
    });

    it('chunks OpenAI-compatible batches sequentially and preserves global input order', async () => {
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { input: string[] };
        return {
          ok: true,
          headers: new Headers(),
          json: async () => ({
            data: body.input
              .map((text, index) => ({ index, embedding: [Number(text)] }))
              .reverse()
          })
        };
      });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbeddings(['1', '2', '3', '4', '5'], {
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:8080/v1',
        model: 'tei-model',
        dimensions: 1,
        batchSize: 2
      })).resolves.toEqual([[1], [2], [3], [4], [5]]);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(fetchMock.mock.calls.map(call =>
        JSON.parse((call[1] as RequestInit).body as string).input
      )).toEqual([
        ['1', '2'],
        ['3', '4'],
        ['5']
      ]);
    });

    it.each([
      {
        name: 'missing top-level data',
        data: undefined,
        expected: /OpenAI-compatible response did not include a data array/
      },
      {
        name: 'wrong cardinality',
        data: [{ index: 0, embedding: [1, 2] }],
        expected: /expected 2 embedding result\(s\), received 1/
      },
      {
        name: 'missing index',
        data: [{ index: 0, embedding: [1, 2] }, { embedding: [3, 4] }],
        expected: /OpenAI-compatible response item did not include an index/
      },
      {
        name: 'duplicate index',
        data: [{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [3, 4] }],
        expected: /duplicate embedding index 0/
      },
      {
        name: 'noninteger index',
        data: [{ index: 0, embedding: [1, 2] }, { index: 0.5, embedding: [3, 4] }],
        expected: /invalid embedding index 0.5/
      },
      {
        name: 'negative index',
        data: [{ index: 0, embedding: [1, 2] }, { index: -1, embedding: [3, 4] }],
        expected: /invalid embedding index -1/
      },
      {
        name: 'out-of-range index',
        data: [{ index: 0, embedding: [1, 2] }, { index: 2, embedding: [3, 4] }],
        expected: /invalid embedding index 2/
      },
      {
        name: 'wrong dimensions',
        data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3] }],
        expected: /embedding 1 has 1 dimensions, expected 2/
      },
      {
        name: 'non-finite value',
        data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [Number.NaN, 4] }],
        expected: /embedding 1 contains a non-finite value at dimension 0/
      }
    ])('rejects invalid OpenAI-compatible $name responses', async ({ data, expected }) => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => data === undefined ? {} : { data }
      });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbeddings(['first', 'second'], {
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:8080/v1',
        model: 'tei-model',
        dimensions: 2
      })).rejects.toThrow(expected);
    });

    it('validates and reorders indexed batch results', () => {
      const vectors = validateEmbeddingBatch([
        { index: 1, embedding: [3, 4] },
        { index: 0, embedding: [1, 2] }
      ], 2, 2, 'openai');

      expect(vectors).toEqual([[1, 2], [3, 4]]);
    });

    it.each([
      {
        name: 'cardinality',
        items: [[1, 2]],
        expected: /expected 2 embedding result/
      },
      {
        name: 'dimensions',
        items: [[1, 2, 3], [4, 5, 6]],
        expected: /has 3 dimensions, expected 2/
      },
      {
        name: 'finite values',
        items: [[1, Number.NaN], [2, 3]],
        expected: /non-finite value/
      },
      {
        name: 'duplicate batch indices',
        items: [
          { index: 0, embedding: [1, 2] },
          { index: 0, embedding: [3, 4] }
        ],
        expected: /duplicate embedding index/
      },
      {
        name: 'partial batch indices',
        items: [
          { index: 0, embedding: [1, 2] },
          { embedding: [3, 4] }
        ],
        expected: /partially indexed embedding batch/
      },
      {
        name: 'malformed batch indices',
        items: [
          { index: '0', embedding: [1, 2] },
          { index: '1', embedding: [3, 4] }
        ],
        expected: /invalid embedding index 0/
      }
    ])('rejects invalid $name from provider results', ({ items, expected }) => {
      expect(() =>
        validateEmbeddingBatch(items as Parameters<typeof validateEmbeddingBatch>[0], 2, 2, 'openai')
      ).toThrow(expected);
    });

    it('uses OpenAI native batches and preserves provider order by index', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          data: [
            { index: 1, embedding: [3, 4] },
            { index: 0, embedding: [1, 2] }
          ]
        })
      });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbeddings(['first', 'second'], {
        provider: 'openai',
        apiKey: 'openai-key',
        dimensions: 2
      })).resolves.toEqual([[1, 2], [3, 4]]);

      const request = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(request.body as string)).toMatchObject({
        input: ['first', 'second'],
        model: 'text-embedding-3-small',
        dimensions: 2
      });
    });

    it('uses Cloudflare bge-m3 native batches and preserves provider order by index', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          data: [
            { index: 1, embedding: new Array(1024).fill(2) },
            { index: 0, embedding: new Array(1024).fill(1) }
          ]
        })
      });

      vi.stubGlobal('fetch', fetchMock);

      const embeddings = await generateEmbeddings(['first', 'second'], {
        provider: 'cloudflare',
        accountId: 'account/with/slash',
        apiToken: 'cloudflare-token'
      });

      expect(embeddings).toHaveLength(2);
      expect(embeddings[0]).toEqual(new Array(1024).fill(1));
      expect(embeddings[1]).toEqual(new Array(1024).fill(2));
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.cloudflare.com/client/v4/accounts/account%2Fwith%2Fslash/ai/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer cloudflare-token'
          })
        })
      );

      const request = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(request.body as string)).toEqual({
        model: '@cf/baai/bge-m3',
        input: ['first', 'second']
      });
    });

    it('uses Mistral native batches with the documented request shape and preserves provider order by index', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          data: [
            { index: 1, embedding: new Array(1024).fill(2) },
            { index: 0, embedding: new Array(1024).fill(1) }
          ]
        })
      });

      vi.stubGlobal('fetch', fetchMock);

      const embeddings = await generateEmbeddings(['first', 'second'], {
        provider: 'mistral',
        apiKey: 'mistral-key'
      });

      expect(embeddings).toHaveLength(2);
      expect(embeddings[0]).toEqual(new Array(1024).fill(1));
      expect(embeddings[1]).toEqual(new Array(1024).fill(2));
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.mistral.ai/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer mistral-key'
          })
        })
      );

      const request = fetchMock.mock.calls[0][1] as RequestInit;
      expect(JSON.parse(request.body as string)).toEqual({
        input: ['first', 'second'],
        model: 'mistral-embed',
        encoding_format: 'float'
      });
    });

    it('uses Gemini Embedding 2 request shape for document and query intents', async () => {
      await expect(generateEmbedding('markdown body', {
        provider: 'gemini',
        apiKey: 'gemini-key',
        dimensions: 768,
        intent: 'document'
      })).resolves.toHaveLength(768);

      await expect(generateEmbedding('deploy docs', {
        provider: 'gemini',
        apiKey: 'gemini-key',
        dimensions: 1536,
        intent: 'query'
      })).resolves.toHaveLength(1536);

      expect(getGeminiRequests()).toEqual([
        {
          model: 'gemini-embedding-2',
          contents: 'title: none | text: markdown body',
          config: {
            outputDimensionality: 768,
            abortSignal: expect.any(AbortSignal)
          }
        },
        {
          model: 'gemini-embedding-2',
          contents: 'task: search result | query: deploy docs',
          config: {
            outputDimensionality: 1536,
            abortSignal: expect.any(AbortSignal)
          }
        }
      ]);
    });

    it('uses one Gemini request per input and preserves input order', async () => {
      geminiMock.embedContent.mockImplementation(async (request: { contents: string; config?: { outputDimensionality?: number } }) => {
        const value = request.contents.includes('first') ? 1 : 2;
        return {
          embeddings: [{
            values: new Array(request.config?.outputDimensionality ?? 3072).fill(value)
          }]
        };
      });

      const embeddings = await generateEmbeddings(['first', 'second'], {
        provider: 'gemini',
        apiKey: 'gemini-key',
        dimensions: 128,
        intent: 'query'
      });

      expect(embeddings).toEqual([
        new Array(128).fill(1),
        new Array(128).fill(2)
      ]);
      expect(geminiMock.embedContent).toHaveBeenCalledTimes(2);
      expect(getGeminiRequests().map(request => request.contents)).toEqual([
        'task: search result | query: first',
        'task: search result | query: second'
      ]);
    });

    it.each([
      {
        name: 'missing embeddings array',
        response: {},
        expected: /Gemini response did not include an embeddings array/
      },
      {
        name: 'zero embeddings',
        response: { embeddings: [] },
        expected: /Gemini response included 0 embedding result/
      },
      {
        name: 'multiple embeddings',
        response: {
          embeddings: [
            { values: new Array(128).fill(1) },
            { values: new Array(128).fill(2) }
          ]
        },
        expected: /Gemini response included 2 embedding result/
      },
      {
        name: 'missing values array',
        response: { embeddings: [{}] },
        expected: /Gemini response did not include embedding values/
      },
      {
        name: 'wrong dimensions',
        response: { embeddings: [{ values: new Array(127).fill(1) }] },
        expected: /embedding 0 has 127 dimensions, expected 128/
      },
      {
        name: 'NaN value',
        response: { embeddings: [{ values: [Number.NaN, ...new Array(127).fill(1)] }] },
        expected: /embedding 0 contains a non-finite value at dimension 0/
      },
      {
        name: 'Infinity value',
        response: { embeddings: [{ values: [Number.POSITIVE_INFINITY, ...new Array(127).fill(1)] }] },
        expected: /embedding 0 contains a non-finite value at dimension 0/
      }
    ])('rejects Gemini $name without leaking credentials', async ({ response, expected }) => {
      const apiKey = 'secret-gemini-key';
      geminiMock.embedContent.mockResolvedValueOnce(response);

      let message = '';
      try {
        await generateEmbedding('test', {
          provider: 'gemini',
          apiKey,
          dimensions: 128
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(expected);
      expect(message).not.toContain(apiKey);
    });

    it('rejects Mistral responses when items do not include indices', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          data: [
            { embedding: new Array(1024).fill(1) },
            { embedding: new Array(1024).fill(2) }
          ]
        })
      });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbeddings(['first', 'second'], {
        provider: 'mistral',
        apiKey: 'mistral-key'
      })).rejects.toThrow(
        'mistral embedding error: API request failed: Mistral response item did not include an index'
      );
    });

    it('rejects malformed Mistral top-level and item responses', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers(),
          json: async () => ({ data: {} })
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers(),
          json: async () => ({ data: [{ index: 0, embedding: 'not-an-array' }] })
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers(),
          json: async () => ({ data: [null] })
        })
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers(),
          json: async () => ({ data: ['not-an-object'] })
        });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbedding('test', {
        provider: 'mistral',
        apiKey: 'mistral-key'
      })).rejects.toThrow(
        'mistral embedding error: API request failed: Mistral response did not include a data array'
      );

      await expect(generateEmbedding('test', {
        provider: 'mistral',
        apiKey: 'mistral-key'
      })).rejects.toThrow(
        'mistral embedding error: API request failed: Mistral response item did not include an embedding array'
      );

      await expect(generateEmbedding('test', {
        provider: 'mistral',
        apiKey: 'mistral-key'
      })).rejects.toThrow(
        'mistral embedding error: API request failed: Mistral response item was not an object'
      );

      await expect(generateEmbedding('test', {
        provider: 'mistral',
        apiKey: 'mistral-key'
      })).rejects.toThrow(
        'mistral embedding error: API request failed: Mistral response item was not an object'
      );
    });

    it.each([
      {
        name: 'cardinality mismatch',
        data: [{ index: 0, embedding: new Array(1024).fill(1) }],
        expected: /expected 2 embedding result\(s\), received 1/
      },
      {
        name: 'duplicate index',
        data: [
          { index: 0, embedding: new Array(1024).fill(1) },
          { index: 0, embedding: new Array(1024).fill(2) }
        ],
        expected: /duplicate embedding index 0/
      },
      {
        name: 'out-of-range index',
        data: [
          { index: 0, embedding: new Array(1024).fill(1) },
          { index: 2, embedding: new Array(1024).fill(2) }
        ],
        expected: /invalid embedding index 2/
      },
      {
        name: 'partial index',
        data: [
          { index: 0, embedding: new Array(1024).fill(1) },
          { embedding: new Array(1024).fill(2) }
        ],
        expected: /Mistral response item did not include an index/
      },
      {
        name: 'vector dimension mismatch',
        data: [
          { index: 0, embedding: new Array(1024).fill(1) },
          { index: 1, embedding: new Array(1023).fill(2) }
        ],
        expected: /embedding 1 has 1023 dimensions, expected 1024/
      },
      {
        name: 'NaN value',
        data: [
          { index: 0, embedding: new Array(1024).fill(1) },
          { index: 1, embedding: [Number.NaN, ...new Array(1023).fill(2)] }
        ],
        expected: /embedding 1 contains a non-finite value at dimension 0/
      },
      {
        name: 'Infinity value',
        data: [
          { index: 0, embedding: new Array(1024).fill(1) },
          { index: 1, embedding: [Number.POSITIVE_INFINITY, ...new Array(1023).fill(2)] }
        ],
        expected: /embedding 1 contains a non-finite value at dimension 0/
      }
    ])('rejects Mistral provider $name without leaking credentials', async ({ data, expected }) => {
      const apiKey = 'secret-mistral-key';
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ data })
      });

      vi.stubGlobal('fetch', fetchMock);

      let message = '';
      try {
        await generateEmbeddings(['first', 'second'], {
          provider: 'mistral',
          apiKey
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(expected);
      expect(message).not.toContain(apiKey);
    });

    it('rejects Mistral dimension overrides before credentials or network work', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      expect(() => getEmbeddingProviderMetadata({
        provider: 'mistral',
        dimensions: 768
      })).toThrow('mistral-embed returns 1024 dimensions; received dimensions 768');

      await expect(generateEmbedding('test', {
        provider: 'mistral',
        dimensions: 768
      })).rejects.toThrow('mistral-embed returns 1024 dimensions; received dimensions 768');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects invalid Cloudflare responses', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ data: [{ index: 0, embedding: 'not-an-array' }] })
      });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbedding('test', {
        provider: 'cloudflare',
        accountId: 'account-id',
        apiToken: 'cloudflare-token'
      })).rejects.toThrow(
        'cloudflare embedding error: API request failed: Cloudflare response item did not include an embedding array'
      );
    });

    it.each([
      {
        name: 'cardinality mismatch',
        data: [{ index: 0, embedding: new Array(1024).fill(1) }],
        expected: /expected 2 embedding result\(s\), received 1/
      },
      {
        name: 'vector dimension mismatch',
        data: [
          { index: 0, embedding: new Array(1024).fill(1) },
          { index: 1, embedding: new Array(1023).fill(2) }
        ],
        expected: /embedding 1 has 1023 dimensions, expected 1024/
      },
      {
        name: 'non-finite values',
        data: [
          { index: 0, embedding: new Array(1024).fill(1) },
          { index: 1, embedding: [Number.NaN, ...new Array(1023).fill(2)] }
        ],
        expected: /embedding 1 contains a non-finite value at dimension 0/
      }
    ])('rejects Cloudflare provider $name without leaking credentials', async ({ data, expected }) => {
      const accountId = 'secret-cloudflare-account';
      const apiToken = 'secret-cloudflare-token';
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ data })
      });

      vi.stubGlobal('fetch', fetchMock);

      let message = '';
      try {
        await generateEmbeddings(['first', 'second'], {
          provider: 'cloudflare',
          accountId,
          apiToken
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toMatch(expected);
      expect(message).not.toContain(accountId);
      expect(message).not.toContain(apiToken);
    });

    it('rejects Cloudflare dimension overrides before credentials or network work', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      expect(() => getEmbeddingProviderMetadata({
        provider: 'cloudflare',
        dimensions: 768
      })).toThrow('@cf/baai/bge-m3 returns 1024 dimensions; received dimensions 768');

      await expect(generateEmbedding('test', {
        provider: 'cloudflare',
        dimensions: 768
      })).rejects.toThrow('@cf/baai/bge-m3 returns 1024 dimensions; received dimensions 768');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects malformed OpenAI response indices before treating results as positional', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({
          data: [
            { index: '0', embedding: [1, 2] },
            { index: '1', embedding: [3, 4] }
          ]
        })
      });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbeddings(['first', 'second'], {
        provider: 'openai',
        apiKey: 'openai-key',
        dimensions: 2
      })).rejects.toThrow('openai embedding error: provider returned invalid embedding index 0');
    });

    it('enforces OpenAI declared native batch limits before network work', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbeddings(new Array(2049).fill('test'), {
        provider: 'openai',
        apiKey: 'openai-key',
        dimensions: 2
      })).rejects.toThrow('openai embedding error: batch size 2049 exceeds maximum 2048');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not reuse hosted provider credentials or dimensions across calls', async () => {
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { dimensions: number };

        return {
          ok: true,
          headers: new Headers(),
          json: async () => ({
            data: [
              {
                index: 0,
                embedding: new Array(body.dimensions).fill(body.dimensions)
              }
            ]
          })
        };
      });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbedding('one', {
        provider: 'openai',
        apiKey: 'first-key',
        dimensions: 2
      })).resolves.toEqual([2, 2]);

      await expect(generateEmbedding('two', {
        provider: 'openai',
        apiKey: 'second-key',
        dimensions: 3
      })).resolves.toEqual([3, 3, 3]);

      expect(fetchMock.mock.calls[0][1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: 'Bearer first-key' })
      });
      expect(fetchMock.mock.calls[1][1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: 'Bearer second-key' })
      });

      await generateEmbedding('gemini one', {
        provider: 'gemini',
        apiKey: 'gemini-first',
        dimensions: 128
      });
      await generateEmbedding('gemini two', {
        provider: 'gemini',
        apiKey: 'gemini-second',
        dimensions: 128
      });

      expect(geminiMock.keys).toEqual(['gemini-first', 'gemini-second']);
      expect(getGeminiRequests().map(request => request.model)).toEqual([
        'gemini-embedding-2',
        'gemini-embedding-2'
      ]);

      const mistralFetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers(),
        json: async () => ({ data: [{ index: 0, embedding: new Array(1024).fill(1) }] })
      });

      vi.stubGlobal('fetch', mistralFetchMock);

      await generateEmbedding('mistral one', {
        provider: 'mistral',
        apiKey: 'mistral-first'
      });
      await generateEmbedding('mistral two', {
        provider: 'mistral',
        apiKey: 'mistral-second'
      });

      expect(mistralFetchMock.mock.calls[0][1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: 'Bearer mistral-first' })
      });
      expect(mistralFetchMock.mock.calls[1][1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: 'Bearer mistral-second' })
      });
    });

    it('redacts hosted provider failures and keeps bounded context', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers({ 'x-request-id': 'req_123' }),
        text: async () => 'Authorization: Bearer should-not-appear api_key=secret'
      });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbedding('test', {
        provider: 'openai',
        apiKey: 'super-secret-key',
        dimensions: 2
      })).rejects.toThrow('openai embedding error: API request failed: status 401, request req_123');

      await expect(generateEmbedding('test', {
        provider: 'openai',
        apiKey: 'super-secret-key',
        dimensions: 2
      })).rejects.not.toThrow(/super-secret-key|should-not-appear|api_key=secret/);
    });

    it('redacts Cloudflare rate-limit failures and does not read raw response bodies', async () => {
      const responseText = vi.fn(async () => 'Authorization: Bearer should-not-appear token=secret');
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'cf-ray': 'abc123-SJC' }),
        text: responseText
      });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbedding('test', {
        provider: 'cloudflare',
        accountId: 'secret-account-id',
        apiToken: 'secret-api-token'
      })).rejects.toThrow('cloudflare embedding error: API request failed: status 429, cf-ray abc123-SJC');

      await expect(generateEmbedding('test', {
        provider: 'cloudflare',
        accountId: 'secret-account-id',
        apiToken: 'secret-api-token'
      })).rejects.not.toThrow(/secret-account-id|secret-api-token|should-not-appear|token=secret/);
      expect(responseText).not.toHaveBeenCalled();
    });

    it('redacts Mistral authentication and rate-limit failures without reading raw response bodies', async () => {
      const responseText = vi.fn(async () => 'Authorization: Bearer should-not-appear api_key=secret');
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
          headers: new Headers({ 'x-request-id': 'req_bad-auth' }),
          text: responseText
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: new Headers({ 'x-request-id': 'req_rate-limit' }),
          text: responseText
        });

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbedding('test', {
        provider: 'mistral',
        apiKey: 'secret-mistral-key'
      })).rejects.toThrow('mistral embedding error: API request failed: status 401, request req_bad-auth');

      await expect(generateEmbedding('test', {
        provider: 'mistral',
        apiKey: 'secret-mistral-key'
      })).rejects.toThrow('mistral embedding error: API request failed: status 429, request req_rate-limit');

      expect(responseText).not.toHaveBeenCalled();
    });

    it('redacts OpenAI-compatible failures without reading raw response bodies or leaking endpoint config', async () => {
      const responseText = vi.fn(async () => 'Authorization: Bearer should-not-appear api_key=secret');
      const fetchMock = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: new Headers({ 'x-request-id': ' req_custom/with spaces ' }),
        text: responseText
      });

      vi.stubGlobal('fetch', fetchMock);

      const baseUrl = 'https://embeddings.internal.example/v1';
      const apiKey = 'secret-compatible-key';

      await expect(generateEmbedding('test', {
        provider: 'openai-compatible',
        baseUrl,
        apiKey,
        model: 'tei-model',
        dimensions: 2
      })).rejects.toThrow('openai-compatible embedding error: API request failed: status 500, request req_customwithspaces');

      let message = '';
      try {
        await generateEmbedding('test', {
          provider: 'openai-compatible',
          baseUrl,
          apiKey,
          model: 'tei-model',
          dimensions: 2
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(responseText).not.toHaveBeenCalled();
      expect(message).not.toContain(baseUrl);
      expect(message).not.toContain(`${baseUrl}/embeddings`);
      expect(message).not.toContain(apiKey);
      expect(message).not.toContain('should-not-appear');
    });

    it('redacts the exact OpenAI credential from transport rejections', async () => {
      const secret = 'sk-literal-openai-secret';
      const fetchMock = vi.fn().mockRejectedValue(
        new Error(`transport failed for credential ${secret}`)
      );

      vi.stubGlobal('fetch', fetchMock);

      let message = '';
      try {
        await generateEmbedding('test', {
          provider: 'openai',
          apiKey: secret,
          dimensions: 2
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('openai embedding error: API request failed');
      expect(message).toContain('transport failed');
      expect(message).toContain('[redacted]');
      expect(message).not.toContain(secret);
    });

    it('redacts the exact Mistral credential from transport rejections', async () => {
      const secret = 'literal-mistral-secret';
      const fetchMock = vi.fn().mockRejectedValue(
        new Error(`transport failed for credential ${secret}`)
      );

      vi.stubGlobal('fetch', fetchMock);

      let message = '';
      try {
        await generateEmbedding('test', {
          provider: 'mistral',
          apiKey: secret
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('mistral embedding error: API request failed');
      expect(message).toContain('transport failed');
      expect(message).toContain('[redacted]');
      expect(message).not.toContain(secret);
    });

    it('redacts OpenAI-compatible credentials and endpoint from transport rejections', async () => {
      const secret = 'literal-compatible-secret';
      const baseUrl = 'https://private-embedding.example/v1';
      const fetchMock = vi.fn().mockRejectedValue(
        new Error(`transport failed for ${baseUrl}/embeddings with credential ${secret}`)
      );

      vi.stubGlobal('fetch', fetchMock);

      let message = '';
      try {
        await generateEmbedding('test', {
          provider: 'openai-compatible',
          baseUrl,
          apiKey: secret,
          model: 'tei-model',
          dimensions: 2
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('openai-compatible embedding error: API request failed');
      expect(message).toContain('transport failed');
      expect(message).toContain('[redacted]');
      expect(message).not.toContain(secret);
      expect(message).not.toContain(baseUrl);
      expect(message).not.toContain(`${baseUrl}/embeddings`);
    });

    it('redacts the exact Gemini credential from SDK rejections', async () => {
      const secret = 'literal-gemini-secret';
      geminiMock.embedContent.mockRejectedValueOnce(
        new Error(`SDK rejected credential ${secret}`)
      );

      let message = '';
      try {
        await generateEmbedding('test', {
          provider: 'gemini',
          apiKey: secret
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain('gemini embedding error: API request failed');
      expect(message).toContain('SDK rejected');
      expect(message).toContain('[redacted]');
      expect(message).not.toContain(secret);
    });

    it('passes AbortSignal to Gemini request config', async () => {
      await generateEmbedding('test', {
        provider: 'gemini',
        apiKey: 'gemini-signal-key',
        dimensions: 128
      });

      expect(getGeminiRequests()).toHaveLength(1);
      expect(getGeminiRequests()[0]?.config).toEqual({
        outputDimensionality: 128,
        abortSignal: expect.any(AbortSignal)
      });
    });

    it('times out hosted provider calls with a safe error', async () => {
      const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }));

      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbedding('test', {
        provider: 'openai',
        apiKey: 'timeout-key',
        dimensions: 2,
        timeoutMs: 1
      })).rejects.toThrow('openai embedding error: API request timed out after 1ms');
    });

    it('times out Cloudflare provider calls with a safe error deterministically', async () => {
      vi.useFakeTimers();
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const fetchMock = vi.fn((_url: string, _init: RequestInit) => {
        markStarted();
        return new Promise(() => {});
      });

      vi.stubGlobal('fetch', fetchMock);

      try {
        const embeddingPromise = generateEmbedding('test', {
          provider: 'cloudflare',
          accountId: 'timeout-account',
          apiToken: 'timeout-token',
          timeoutMs: 1000
        });

        await started;
        const rejection = expect(embeddingPromise).rejects.toThrow(
          'cloudflare embedding error: API request timed out after 1000ms'
        );

        await vi.advanceTimersByTimeAsync(1000);
        await rejection;
      } finally {
        vi.useRealTimers();
      }
    });

    it('times out Mistral provider calls with a safe error deterministically', async () => {
      vi.useFakeTimers();
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const fetchMock = vi.fn((_url: string, _init: RequestInit) => {
        markStarted();
        return new Promise(() => {});
      });

      vi.stubGlobal('fetch', fetchMock);

      try {
        const embeddingPromise = generateEmbedding('test', {
          provider: 'mistral',
          apiKey: 'timeout-key',
          timeoutMs: 1000
        });

        await started;
        const rejection = expect(embeddingPromise).rejects.toThrow(
          'mistral embedding error: API request timed out after 1000ms'
        );

        await vi.advanceTimersByTimeAsync(1000);
        await rejection;
      } finally {
        vi.useRealTimers();
      }
    });

    it('times out OpenAI-compatible calls with a safe error deterministically', async () => {
      vi.useFakeTimers();
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const fetchMock = vi.fn((_url: string, _init: RequestInit) => {
        markStarted();
        return new Promise(() => {});
      });

      vi.stubGlobal('fetch', fetchMock);

      try {
        const embeddingPromise = generateEmbedding('test', {
          provider: 'openai-compatible',
          baseUrl: 'http://localhost:8080/v1',
          model: 'tei-model',
          dimensions: 2,
          timeoutMs: 1000
        });

        await started;
        const rejection = expect(embeddingPromise).rejects.toThrow(
          'openai-compatible embedding error: API request timed out after 1000ms'
        );

        await vi.advanceTimersByTimeAsync(1000);
        await rejection;
      } finally {
        vi.useRealTimers();
      }
    });

    it('passes caller abort to Mistral requests', async () => {
      const controller = new AbortController();
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        markStarted();
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      });

      vi.stubGlobal('fetch', fetchMock);

      const embeddingPromise = generateEmbedding('test', {
        provider: 'mistral',
        apiKey: 'abort-key',
        signal: controller.signal
      });

      await started;
      controller.abort();

      await expect(embeddingPromise).rejects.toThrow('mistral embedding error: API request was aborted');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.mistral.ai/v1/embeddings',
        expect.objectContaining({
          signal: expect.any(AbortSignal)
        })
      );
    });

    it('passes caller abort to OpenAI-compatible requests', async () => {
      const controller = new AbortController();
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const fetchMock = vi.fn((_url: string, init: RequestInit) => {
        markStarted();
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      });

      vi.stubGlobal('fetch', fetchMock);

      const embeddingPromise = generateEmbedding('test', {
        provider: 'openai-compatible',
        baseUrl: 'http://localhost:8080/v1',
        model: 'tei-model',
        dimensions: 2,
        signal: controller.signal
      });

      await started;
      controller.abort();

      await expect(embeddingPromise).rejects.toThrow('openai-compatible embedding error: API request was aborted');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/v1/embeddings',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          redirect: 'error'
        })
      );
    });

    it('times out a signal-ignorant in-flight Gemini request deterministically', async () => {
      vi.useFakeTimers();
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      geminiMock.embedContent.mockImplementationOnce(() => {
        markStarted();
        return new Promise(() => {});
      });

      try {
        const embeddingPromise = generateEmbedding('test', {
          provider: 'gemini',
          apiKey: 'gemini-timeout-key',
          timeoutMs: 1000
        });

        await started;
        const rejection = expect(embeddingPromise).rejects.toThrow(
          'gemini embedding error: API request timed out after 1000ms'
        );

        await vi.advanceTimersByTimeAsync(1000);
        await rejection;
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not start later Gemini batch items after caller abort and late item resolution', async () => {
      const controller = new AbortController();
      let markStarted: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let resolveFirst: (value: unknown) => void = () => {};
      geminiMock.embedContent.mockImplementationOnce(() => {
        markStarted();
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      });

      const embeddingPromise = generateEmbeddings(['first', 'second'], {
        provider: 'gemini',
        apiKey: 'gemini-abort-key',
        timeoutMs: 30_000,
        signal: controller.signal
      });

      await started;
      expect(geminiMock.embedContent).toHaveBeenCalledTimes(1);
      controller.abort();

      await expect(embeddingPromise).rejects.toThrow('gemini embedding error: API request was aborted');

      resolveFirst({
        embeddings: [{
          values: new Array(3072).fill(1)
        }]
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(geminiMock.embedContent).toHaveBeenCalledTimes(1);
      expect(geminiMock.embedContent).toHaveBeenCalledWith({
        model: 'gemini-embedding-2',
        contents: 'title: none | text: first',
        config: {
          outputDimensionality: 3072,
          abortSignal: expect.any(AbortSignal)
        }
      });
      expect(getGeminiRequests()).toHaveLength(1);
    });

    it('returns provider batch result objects from provider clients', async () => {
      const provider = createEmbeddingProvider({
        provider: 'openai',
        apiKey: 'result-key',
        dimensions: 2
      });

      await expect(provider.embed([], { intent: 'query' })).resolves.toEqual({
        embeddings: [],
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 2,
        intent: 'query'
      });
    });

    it('creates provider clients with immutable metadata', () => {
      const provider = createEmbeddingProvider({
        provider: 'openai',
        apiKey: 'metadata-key',
        dimensions: 2
      });

      expect(provider.metadata).toEqual({
        name: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 2,
        batch: { mode: 'native', maxSize: 2048 }
      });
      expect(Object.isFrozen(provider.metadata)).toBe(true);
      expect(Object.isFrozen(provider.metadata.batch)).toBe(true);

      const cloudflareProvider = createEmbeddingProvider({
        provider: 'cloudflare',
        accountId: 'metadata-account',
        apiToken: 'metadata-token'
      });

      expect(cloudflareProvider.metadata).toEqual({
        name: 'cloudflare',
        model: '@cf/baai/bge-m3',
        dimensions: 1024,
        batch: { mode: 'native' }
      });
      expect(Object.isFrozen(cloudflareProvider.metadata)).toBe(true);
      expect(Object.isFrozen(cloudflareProvider.metadata.batch)).toBe(true);

      const mistralProvider = createEmbeddingProvider({
        provider: 'mistral',
        apiKey: 'metadata-key'
      });

      expect(mistralProvider.metadata).toEqual({
        name: 'mistral',
        model: 'mistral-embed',
        dimensions: 1024,
        batch: { mode: 'native' }
      });
      expect(Object.isFrozen(mistralProvider.metadata)).toBe(true);
      expect(Object.isFrozen(mistralProvider.metadata.batch)).toBe(true);

      const geminiProvider = createEmbeddingProvider({
        provider: 'gemini',
        apiKey: 'metadata-key',
        dimensions: 1536
      });

      expect(geminiProvider.metadata).toEqual({
        name: 'gemini',
        model: 'gemini-embedding-2',
        dimensions: 1536,
        batch: { mode: 'sequential' }
      });
      expect(Object.isFrozen(geminiProvider.metadata)).toBe(true);
      expect(Object.isFrozen(geminiProvider.metadata.batch)).toBe(true);
    });
  });
});
