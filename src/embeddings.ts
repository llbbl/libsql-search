/**
 * Multi-provider embedding generation
 * Supports local (Xenova), Gemini, and OpenAI
 */
import type { FeatureExtractionPipeline } from '@xenova/transformers';

export type EmbeddingProvider = 'local' | 'gemini' | 'openai';
export type EmbeddingIntent = 'document' | 'query';
export type EmbeddingBatchMode = 'native' | 'sequential';

export interface EmbeddingBatchBehavior {
  mode: EmbeddingBatchMode;
  maxSize?: number;
}

export interface EmbeddingProviderMetadata {
  name: EmbeddingProvider;
  model: string;
  dimensions: number;
  batch: EmbeddingBatchBehavior;
}

export interface EmbeddingRequestOptions {
  intent?: EmbeddingIntent;
  signal?: AbortSignal;
}

export interface EmbeddingProviderClient {
  readonly metadata: EmbeddingProviderMetadata;
  embed(texts: string[], options?: EmbeddingRequestOptions): Promise<EmbeddingBatchResult>;
}

export interface EmbeddingBatchResult {
  embeddings: number[][];
  provider: EmbeddingProvider;
  model: string;
  dimensions: number;
  intent: EmbeddingIntent;
}

export interface EmbeddingOptions {
  provider?: EmbeddingProvider;
  apiKey?: string;
  dimensions?: number;
  maxLength?: number;
  intent?: EmbeddingIntent;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface LocalModelCache {
  model?: FeatureExtractionPipeline;
}

interface RuntimeEnvironment {
  process?: { env?: Record<string, string | undefined> };
  Deno?: { env?: { get?: (name: string) => string | undefined } };
}

interface GeminiEmbeddingResult {
  embedding?: {
    values?: unknown;
  };
}

interface OpenAIEmbeddingResponse {
  data?: unknown;
}

interface OpenAIEmbeddingItem {
  embedding?: unknown;
  index?: unknown;
}

export interface EmbeddingBatchItemResult {
  embedding: number[];
  index?: unknown;
}

export type EmbeddingBatchItem = number[] | EmbeddingBatchItemResult;

const DEFAULT_DIMENSIONS = 768;
const DEFAULT_MAX_LENGTH = 8000;
const DEFAULT_TIMEOUT_MS = 30_000;
const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';
const GEMINI_MODEL = 'text-embedding-004';
const OPENAI_SMALL_MODEL = 'text-embedding-3-small';
const OPENAI_LARGE_MODEL = 'text-embedding-3-large';
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';

const localModelCacheByModel = new Map<string, LocalModelCache>();

function getEnvironmentVariable(name: string): string | undefined {
  const runtime = globalThis as typeof globalThis & RuntimeEnvironment;
  const nodeValue = runtime.process?.env?.[name];
  if (nodeValue) {
    return nodeValue;
  }

  try {
    return runtime.Deno?.env?.get?.(name);
  } catch {
    return undefined;
  }
}

async function getLocalEmbeddingModel(modelName: string): Promise<FeatureExtractionPipeline> {
  const cached = localModelCacheByModel.get(modelName);
  if (cached?.model) {
    return cached.model;
  }

  console.log(`Loading local embedding model (${modelName})...`);
  const { pipeline } = await import('@xenova/transformers');
  const model = await pipeline('feature-extraction', modelName);
  localModelCacheByModel.set(modelName, { model });
  console.log('Local model loaded successfully');

  return model;
}

function getPositiveInteger(value: number, optionName: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${optionName}: expected a positive integer`);
  }

  return value;
}

function getTimeoutMs(value: number | undefined): number {
  return getPositiveInteger(value ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
}

function resolveProviderName(provider: EmbeddingProvider | undefined): EmbeddingProvider {
  switch (provider ?? 'local') {
    case 'local':
    case 'gemini':
    case 'openai':
      return provider ?? 'local';
    default:
      throw new Error(`Unknown embedding provider: ${String(provider)}`);
  }
}

function resolveIntent(intent: EmbeddingIntent | undefined): EmbeddingIntent {
  switch (intent ?? 'document') {
    case 'document':
    case 'query':
      return intent ?? 'document';
    default:
      throw new Error(`Unknown embedding intent: ${String(intent)}`);
  }
}

function truncateTexts(texts: string[], maxLength: number): string[] {
  return texts.map(text => text.substring(0, maxLength));
}

function getOpenAIModel(dimensions: number): string {
  return dimensions <= 1536 ? OPENAI_SMALL_MODEL : OPENAI_LARGE_MODEL;
}

function hasOwnProperty(value: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function redactErrorText(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);

  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:api[_-]?key|key|token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*)[^\s,}]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s)]+/gi, match => {
      try {
        const url = new URL(match);
        return `${url.origin}${url.pathname}`;
      } catch {
        return '[redacted-url]';
      }
    })
    .slice(0, 300);
}

function providerError(provider: EmbeddingProvider, message: string, cause?: unknown): Error {
  const safeCause = cause === undefined ? '' : `: ${redactErrorText(cause).trim()}`;
  return new Error(`${provider} embedding error: ${message}${safeCause}`);
}

function getResponseHeader(response: Response, name: string): string | undefined {
  return response.headers.get(name) ?? undefined;
}

async function withTimeout<T>(
  provider: EmbeddingProvider,
  operation: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal
): Promise<T> {
  if (parentSignal?.aborted) {
    throw providerError(provider, `${operation} was aborted`);
  }

  const controller = new AbortController();
  let abortError: Error | undefined;
  let rejectAbort: (error: Error) => void = () => {};
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const abort = (error: Error): void => {
    if (abortError) {
      return;
    }

    abortError = error;
    controller.abort();
    rejectAbort(error);
  };
  const onParentAbort = (): void => abort(providerError(provider, `${operation} was aborted`));
  const timeout = setTimeout(() => {
    abort(providerError(provider, `${operation} timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  const operationPromise = Promise.resolve().then(() => run(controller.signal));
  operationPromise.catch(() => undefined);

  try {
    return await Promise.race([operationPromise, abortPromise]);
  } catch (error) {
    if (error === abortError) {
      throw error;
    }

    throw providerError(provider, `${operation} failed`, error);
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener('abort', onParentAbort);
  }
}

export function validateEmbeddingBatch(
  items: EmbeddingBatchItem[],
  expectedCount: number,
  expectedDimensions: number,
  provider: EmbeddingProvider
): number[][] {
  if (items.length !== expectedCount) {
    throw providerError(
      provider,
      `expected ${expectedCount} embedding result(s), received ${items.length}`
    );
  }

  const hasIndexedItems = items.some(item => !Array.isArray(item) && hasOwnProperty(item, 'index'));
  const ordered = hasIndexedItems
    ? reorderIndexedEmbeddings(items, expectedCount, provider)
    : items.map(item => Array.isArray(item) ? item : item.embedding);

  return ordered.map((embedding, itemIndex) =>
    validateEmbeddingVector(embedding, expectedDimensions, provider, itemIndex)
  );
}

function reorderIndexedEmbeddings(
  items: EmbeddingBatchItem[],
  expectedCount: number,
  provider: EmbeddingProvider
): number[][] {
  const ordered: number[][] = new Array(expectedCount);
  const seen = new Set<number>();

  for (const item of items) {
    if (Array.isArray(item) || !hasOwnProperty(item, 'index')) {
      throw providerError(provider, 'provider returned a partially indexed embedding batch');
    }

    if (typeof item.index !== 'number' || !Number.isInteger(item.index) || item.index < 0 || item.index >= expectedCount) {
      throw providerError(provider, `provider returned invalid embedding index ${String(item.index)}`);
    }

    if (seen.has(item.index)) {
      throw providerError(provider, `provider returned duplicate embedding index ${item.index}`);
    }

    seen.add(item.index);
    ordered[item.index] = item.embedding;
  }

  if (seen.size !== expectedCount) {
    throw providerError(provider, 'provider returned non-contiguous embedding indices');
  }

  return ordered;
}

function validateEmbeddingVector(
  embedding: number[],
  expectedDimensions: number,
  provider: EmbeddingProvider,
  itemIndex: number
): number[] {
  if (!Array.isArray(embedding)) {
    throw providerError(provider, `embedding ${itemIndex} is not an array`);
  }

  if (embedding.length !== expectedDimensions) {
    throw providerError(
      provider,
      `embedding ${itemIndex} has ${embedding.length} dimensions, expected ${expectedDimensions}`
    );
  }

  for (let i = 0; i < embedding.length; i++) {
    const value = embedding[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw providerError(provider, `embedding ${itemIndex} contains a non-finite value at dimension ${i}`);
    }
  }

  return embedding;
}

function createProviderMetadata(
  provider: EmbeddingProvider,
  dimensions: number
): EmbeddingProviderMetadata {
  switch (provider) {
    case 'local':
      return Object.freeze({
        name: 'local' as const,
        model: LOCAL_MODEL,
        dimensions,
        batch: Object.freeze({ mode: 'sequential' as const })
      });
    case 'gemini':
      return Object.freeze({
        name: 'gemini' as const,
        model: GEMINI_MODEL,
        dimensions: DEFAULT_DIMENSIONS,
        batch: Object.freeze({ mode: 'sequential' as const })
      });
    case 'openai':
      return Object.freeze({
        name: 'openai' as const,
        model: getOpenAIModel(dimensions),
        dimensions,
        batch: Object.freeze({ mode: 'native' as const, maxSize: 2048 })
      });
  }
}

function getEffectiveDimensions(
  provider: EmbeddingProvider,
  dimensions: number | undefined
): number {
  if (provider === 'gemini') {
    return DEFAULT_DIMENSIONS;
  }

  return getPositiveInteger(dimensions ?? DEFAULT_DIMENSIONS, 'dimensions');
}

function assertBatchSize(metadata: EmbeddingProviderMetadata, count: number): void {
  if (metadata.batch.maxSize !== undefined && count > metadata.batch.maxSize) {
    throw providerError(
      metadata.name,
      `batch size ${count} exceeds maximum ${metadata.batch.maxSize}`
    );
  }
}

function createEmbeddingBatchResult(
  metadata: EmbeddingProviderMetadata,
  intent: EmbeddingIntent,
  embeddings: number[][]
): EmbeddingBatchResult {
  return Object.freeze({
    embeddings,
    provider: metadata.name,
    model: metadata.model,
    dimensions: metadata.dimensions,
    intent
  });
}

class LocalEmbeddingProvider implements EmbeddingProviderClient {
  readonly metadata: EmbeddingProviderMetadata;
  readonly #timeoutMs: number;

  constructor(metadata: EmbeddingProviderMetadata, timeoutMs: number) {
    this.metadata = metadata;
    this.#timeoutMs = timeoutMs;
  }

  async embed(texts: string[], options: EmbeddingRequestOptions = {}): Promise<EmbeddingBatchResult> {
    const intent = resolveIntent(options.intent);
    if (texts.length === 0) {
      return createEmbeddingBatchResult(this.metadata, intent, []);
    }

    assertBatchSize(this.metadata, texts.length);
    const vectors = await withTimeout(
      'local',
      'model inference',
      this.#timeoutMs,
      async () => {
        const model = await getLocalEmbeddingModel(this.metadata.model);
        const results: number[][] = [];

        for (const text of texts) {
          const output = await model(text, {
            pooling: 'mean',
            normalize: true
          });
          const embedding = Array.from(output.data as ArrayLike<number>);
          results.push(padEmbedding(embedding, this.metadata.dimensions));
        }

        return results;
      },
      options.signal
    );

    return createEmbeddingBatchResult(
      this.metadata,
      intent,
      validateEmbeddingBatch(vectors, texts.length, this.metadata.dimensions, 'local')
    );
  }
}

class GeminiEmbeddingProvider implements EmbeddingProviderClient {
  readonly metadata: EmbeddingProviderMetadata;
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  constructor(metadata: EmbeddingProviderMetadata, apiKey: string, timeoutMs: number) {
    this.metadata = metadata;
    this.#apiKey = apiKey;
    this.#timeoutMs = timeoutMs;
  }

  async embed(texts: string[], options: EmbeddingRequestOptions = {}): Promise<EmbeddingBatchResult> {
    const intent = resolveIntent(options.intent);
    if (texts.length === 0) {
      return createEmbeddingBatchResult(this.metadata, intent, []);
    }

    assertBatchSize(this.metadata, texts.length);
    const vectors = await withTimeout(
      'gemini',
      'API request',
      this.#timeoutMs,
      async () => {
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(this.#apiKey);
        const model = genAI.getGenerativeModel({ model: this.metadata.model });
        const results: number[][] = [];

        for (const text of texts) {
          const result = await model.embedContent(text) as GeminiEmbeddingResult;
          const values = result.embedding?.values;
          if (!Array.isArray(values)) {
            throw new Error('Gemini response did not include embedding values');
          }

          results.push(values);
        }

        return results;
      },
      options.signal
    );

    return createEmbeddingBatchResult(
      this.metadata,
      intent,
      validateEmbeddingBatch(vectors, texts.length, this.metadata.dimensions, 'gemini')
    );
  }
}

class OpenAIEmbeddingProvider implements EmbeddingProviderClient {
  readonly metadata: EmbeddingProviderMetadata;
  readonly #apiKey: string;
  readonly #timeoutMs: number;

  constructor(metadata: EmbeddingProviderMetadata, apiKey: string, timeoutMs: number) {
    this.metadata = metadata;
    this.#apiKey = apiKey;
    this.#timeoutMs = timeoutMs;
  }

  async embed(texts: string[], options: EmbeddingRequestOptions = {}): Promise<EmbeddingBatchResult> {
    const intent = resolveIntent(options.intent);
    if (texts.length === 0) {
      return createEmbeddingBatchResult(this.metadata, intent, []);
    }

    assertBatchSize(this.metadata, texts.length);
    const items = await withTimeout(
      'openai',
      'API request',
      this.#timeoutMs,
      async (signal) => {
        const response = await fetch(OPENAI_EMBEDDINGS_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.#apiKey}`
          },
          signal,
          body: JSON.stringify({
            input: texts,
            model: this.metadata.model,
            dimensions: this.metadata.dimensions
          })
        });

        if (!response.ok) {
          const requestId = getResponseHeader(response, 'x-request-id');
          const context = requestId ? ` status ${response.status}, request ${requestId}` : ` status ${response.status}`;
          throw new Error(context);
        }

        const data = await response.json() as OpenAIEmbeddingResponse;
        if (!Array.isArray(data.data)) {
          throw new Error('OpenAI response did not include a data array');
        }

        return data.data.map((item: unknown): EmbeddingBatchItem => {
          const typed = item as OpenAIEmbeddingItem;
          const embedding = typed.embedding;
          if (!Array.isArray(embedding)) {
            throw new Error('OpenAI response item did not include an embedding array');
          }

          const parsed: EmbeddingBatchItemResult = { embedding };
          if (hasOwnProperty(typed, 'index')) {
            parsed.index = typed.index;
          }

          return parsed;
        });
      },
      options.signal
    );

    return createEmbeddingBatchResult(
      this.metadata,
      intent,
      validateEmbeddingBatch(items, texts.length, this.metadata.dimensions, 'openai')
    );
  }
}

export function createEmbeddingProvider(options: EmbeddingOptions = {}): EmbeddingProviderClient {
  const provider = resolveProviderName(options.provider);
  const metadata = getEmbeddingProviderMetadata(options);
  const timeoutMs = getTimeoutMs(options.timeoutMs);

  switch (provider) {
    case 'local':
      return new LocalEmbeddingProvider(metadata, timeoutMs);
    case 'gemini': {
      const key = options.apiKey || getEnvironmentVariable('GEMINI_API_KEY');
      if (!key) {
        throw new Error('GEMINI_API_KEY is required for Gemini embeddings');
      }

      return new GeminiEmbeddingProvider(metadata, key, timeoutMs);
    }
    case 'openai': {
      const key = options.apiKey || getEnvironmentVariable('OPENAI_API_KEY');
      if (!key) {
        throw new Error('OPENAI_API_KEY is required for OpenAI embeddings');
      }

      return new OpenAIEmbeddingProvider(metadata, key, timeoutMs);
    }
  }
}

export function getEmbeddingProviderMetadata(options: EmbeddingOptions = {}): EmbeddingProviderMetadata {
  const provider = resolveProviderName(options.provider);
  return createProviderMetadata(provider, getEffectiveDimensions(provider, options.dimensions));
}

/**
 * Generate embeddings using the specified provider.
 */
export async function generateEmbeddings(
  texts: string[],
  options: EmbeddingOptions = {}
): Promise<number[][]> {
  const maxLength = getPositiveInteger(options.maxLength ?? DEFAULT_MAX_LENGTH, 'maxLength');
  const intent = resolveIntent(options.intent);

  if (texts.length === 0) {
    return [];
  }

  const provider = createEmbeddingProvider(options);
  const result = await provider.embed(truncateTexts(texts, maxLength), {
    intent,
    ...(options.signal ? { signal: options.signal } : {})
  });
  return result.embeddings;
}

/**
 * Generate an embedding using the specified provider.
 */
export async function generateEmbedding(
  text: string,
  options: EmbeddingOptions = {}
): Promise<number[]> {
  const [embedding] = await generateEmbeddings([text], options);
  if (!embedding) {
    throw new Error('Embedding provider returned no embedding');
  }

  return embedding;
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
  [key: string]: unknown;
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
