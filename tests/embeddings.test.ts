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
  requestOptions: [] as unknown[],
  embedContent: vi.fn(async (text: string, _options?: unknown) => ({
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
        embedContent: (text: string, options?: unknown) => {
          geminiMock.requestOptions.push(options);
          return geminiMock.embedContent(text, options);
        }
      };
    }
  }
}));

describe('embeddings', () => {
  let originalOpenAIKey: string | undefined;
  let originalMistralKey: string | undefined;
  let originalCloudflareAccountId: string | undefined;
  let originalCloudflareApiToken: string | undefined;

  beforeEach(() => {
    originalOpenAIKey = process.env.OPENAI_API_KEY;
    originalMistralKey = process.env.MISTRAL_API_KEY;
    originalCloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    originalCloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.OPENAI_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    geminiMock.keys = [];
    geminiMock.modelRequests = [];
    geminiMock.requestOptions = [];
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

    it('returns empty batches without provider setup or network work', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      await expect(generateEmbeddings([], {
        provider: 'openai'
      })).resolves.toEqual([]);

      await expect(generateEmbeddings([], {
        provider: 'cloudflare'
      })).resolves.toEqual([]);

      await expect(generateEmbeddings([], {
        provider: 'mistral'
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

    it('passes AbortSignal to Gemini request options', async () => {
      await generateEmbedding('test', {
        provider: 'gemini',
        apiKey: 'gemini-signal-key'
      });

      expect(geminiMock.requestOptions).toHaveLength(1);
      expect(geminiMock.requestOptions[0]).toEqual({
        signal: expect.any(AbortSignal)
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
        embedding: {
          values: new Array(768).fill(1)
        }
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(geminiMock.embedContent).toHaveBeenCalledTimes(1);
      expect(geminiMock.embedContent).toHaveBeenCalledWith(
        'first',
        { signal: expect.any(AbortSignal) }
      );
      expect(geminiMock.requestOptions).toHaveLength(1);
      expect(geminiMock.requestOptions[0]).toEqual({
        signal: expect.any(AbortSignal)
      });
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
    });
  });
});
