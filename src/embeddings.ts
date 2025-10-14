/**
 * Multi-provider embedding generation
 * Supports local (Xenova), Gemini, and OpenAI
 */

import { pipeline } from '@xenova/transformers';

export type EmbeddingProvider = 'local' | 'gemini' | 'openai';

export interface EmbeddingOptions {
  provider?: EmbeddingProvider;
  apiKey?: string;
  dimensions?: number;
  maxLength?: number;
}

interface ProviderCache {
  local?: any;
  gemini?: any;
  openai?: any;
}

const providerCache: ProviderCache = {};

/**
 * Generate embeddings using the specified provider
 */
export async function generateEmbedding(
  text: string,
  options: EmbeddingOptions = {}
): Promise<number[]> {
  const {
    provider = 'local',
    apiKey,
    dimensions = 768,
    maxLength = 8000
  } = options;

  const truncated = text.substring(0, maxLength);

  switch (provider) {
    case 'local':
      return generateLocalEmbedding(truncated, dimensions);
    case 'gemini':
      return generateGeminiEmbedding(truncated, apiKey);
    case 'openai':
      return generateOpenAIEmbedding(truncated, apiKey, dimensions);
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}

/**
 * Generate embeddings using local model (Xenova/all-MiniLM-L6-v2)
 * Returns 384 dimensions, padded to target dimensions
 */
async function generateLocalEmbedding(
  text: string,
  targetDimensions: number
): Promise<number[]> {
  if (!providerCache.local) {
    console.log('Loading local embedding model (Xenova/all-MiniLM-L6-v2)...');
    providerCache.local = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    console.log('Local model loaded successfully');
  }

  const output = await providerCache.local(text, {
    pooling: 'mean',
    normalize: true
  });

  const embedding = Array.from(output.data) as number[];
  return padEmbedding(embedding, targetDimensions);
}

/**
 * Generate embeddings using Google Gemini API
 * Returns 768 dimensions natively
 */
async function generateGeminiEmbedding(
  text: string,
  apiKey?: string
): Promise<number[]> {
  const key = apiKey || process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('GEMINI_API_KEY is required for Gemini embeddings');
  }

  if (!providerCache.gemini) {
    // Dynamic import to keep it optional
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(key);
    providerCache.gemini = genAI.getGenerativeModel({ model: 'text-embedding-004' });
  }

  const result = await providerCache.gemini.embedContent(text);
  return result.embedding.values;
}

/**
 * Generate embeddings using OpenAI API
 * Supports text-embedding-3-small (1536 dims) and text-embedding-3-large (3072 dims)
 */
async function generateOpenAIEmbedding(
  text: string,
  apiKey?: string,
  dimensions: number = 1536
): Promise<number[]> {
  const key = apiKey || process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY is required for OpenAI embeddings');
  }

  const model = dimensions <= 1536 ? 'text-embedding-3-small' : 'text-embedding-3-large';

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      input: text,
      model,
      dimensions
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${error}`);
  }

  const data = await response.json() as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

/**
 * Pad or truncate embedding to target dimensions
 */
export function padEmbedding(
  embedding: number[],
  targetDimensions: number
): number[] {
  if (embedding.length === targetDimensions) {
    return embedding;
  }

  if (embedding.length > targetDimensions) {
    return embedding.slice(0, targetDimensions);
  }

  const padded = new Array(targetDimensions).fill(0);
  padded.splice(0, embedding.length, ...embedding);
  return padded;
}

/**
 * Prepare text for embedding by combining multiple fields
 */
export function prepareTextForEmbedding(fields: {
  title?: string;
  description?: string;
  content?: string;
  tags?: string[];
  [key: string]: any;
}): string {
  const parts: string[] = [];

  if (fields.title) parts.push(fields.title);
  if (fields.description) parts.push(fields.description);
  if (fields.tags && fields.tags.length > 0) {
    parts.push(`Tags: ${fields.tags.join(', ')}`);
  }
  if (fields.content) parts.push(fields.content);

  return parts.filter(Boolean).join('\n\n');
}
