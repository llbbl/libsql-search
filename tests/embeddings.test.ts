import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createEmbeddingProvider,
  generateEmbedding,
  generateEmbeddings,
  getEmbeddingProviderMetadata,
  padEmbedding,
  prepareTextForEmbedding,
  validateEmbeddingBatch,
  type EmbeddingOptions
} from '../src/embeddings.js';

const geminiMock = vi.hoisted(() => ({
  keys: [] as string[],
  modelRequests: [] as Array<{ key: string; model: string }>,
  embedContent: vi.fn(async (text: string) => ({
    embedding: {
      values: new Array(768).fill(text.length)
    }
  }))
}));

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: class {
    readonly key: string;

    constructor(key: string) {
      this.key = key;
      geminiMock.keys.push(key);
    }

    getGenerativeModel(config: { model: string }) {
      geminiMock.modelRequests.push({ key: this.key, model: config.model });

      return {
        embedContent: geminiMock.embedContent
      };
    }
  }
}));

describe('embeddings', () => {
  let originalOpenAIKey: string | undefined;

  beforeEach(() => {
    originalOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    geminiMock.keys = [];
    geminiMock.modelRequests = [];
    geminiMock.embedContent.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
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
    it('should generate local embeddings with correct dimensions', async () => {
      const text = 'This is a test sentence for embedding generation';
      const embedding = await generateEmbedding(text, {
        provider: 'local',
        dimensions: 768
      });

      expect(embedding).toBeInstanceOf(Array);
      expect(embedding.length).toBe(768);
      expect(embedding.every(n => typeof n === 'number')).toBe(true);
    }, 30000); // Longer timeout for model loading

    it('should truncate long text to maxLength', async () => {
      const longText = 'a'.repeat(10000);
      const embedding = await generateEmbedding(longText, {
        provider: 'local',
        maxLength: 100
      });

      expect(embedding).toBeInstanceOf(Array);
    }, 30000);

    it('should throw error for unknown provider', async () => {
      await expect(
        generateEmbedding('test', { provider: 'unknown' as any })
      ).rejects.toThrow('Unknown embedding provider');
    });

    it('should throw error for Gemini without API key', async () => {
      await expect(
        generateEmbedding('test', { provider: 'gemini' })
      ).rejects.toThrow('GEMINI_API_KEY is required');
    });

    it('should throw error for OpenAI without API key', async () => {
      await expect(
        generateEmbedding('test', { provider: 'openai' })
      ).rejects.toThrow('OPENAI_API_KEY is required');
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
  });

  describe('provider contract', () => {
    it('exposes stable provider metadata without provider calls', () => {
      expect(getEmbeddingProviderMetadata({
        provider: 'local',
        dimensions: 512
      })).toEqual({
        name: 'local',
        model: 'Xenova/all-MiniLM-L6-v2',
        dimensions: 512,
        batch: { mode: 'sequential' }
      });

      expect(getEmbeddingProviderMetadata({
        provider: 'gemini'
      })).toEqual({
        name: 'gemini',
        model: 'text-embedding-004',
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

      expect(geminiMock.keys).toEqual([]);
    });

    it('returns empty batches without provider setup or network work', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbeddings([], {
        provider: 'openai'
      })).resolves.toEqual([]);

      expect(fetchMock).not.toHaveBeenCalled();
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

    it('enforces declared native batch limits before network work', async () => {
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
        apiKey: 'gemini-first'
      });
      await generateEmbedding('gemini two', {
        provider: 'gemini',
        apiKey: 'gemini-second'
      });

      expect(geminiMock.keys).toEqual(['gemini-first', 'gemini-second']);
      expect(geminiMock.modelRequests).toEqual([
        { key: 'gemini-first', model: 'text-embedding-004' },
        { key: 'gemini-second', model: 'text-embedding-004' }
      ]);
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

    it('times out even when a hosted provider SDK ignores AbortSignal', async () => {
      geminiMock.embedContent.mockImplementationOnce(() => new Promise(() => {}));

      await expect(generateEmbedding('test', {
        provider: 'gemini',
        apiKey: 'gemini-timeout-key',
        timeoutMs: 1
      })).rejects.toThrow('gemini embedding error: API request timed out after 1ms');
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
    });
  });
});
