import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateEmbedding,
  padEmbedding,
  prepareTextForEmbedding,
  type EmbeddingOptions
} from '../src/embeddings.js';

describe('embeddings', () => {
  let originalOpenAIKey: string | undefined;

  beforeEach(() => {
    originalOpenAIKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
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
});
