/**
 * Multi-provider embedding generation
 * Supports local Hugging Face Transformers, Gemini, OpenAI, Mistral,
 * Cloudflare Workers AI, and custom OpenAI-compatible endpoints
 */

export type EmbeddingProvider =
  | 'local'
  | 'gemini'
  | 'openai'
  | 'mistral'
  | 'cloudflare'
  | 'openai-compatible';
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
  accountId?: string;
  apiToken?: string;
  baseUrl?: string;
  model?: string;
  batchSize?: number;
  dimensions?: number;
  maxLength?: number;
  intent?: EmbeddingIntent;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface LocalEmbeddingOutput {
  data: ArrayLike<number>;
}

type LocalFeatureExtractionPipeline = (
  text: string,
  options: { pooling: 'mean'; normalize: true }
) => LocalEmbeddingOutput | Promise<LocalEmbeddingOutput>;

interface HuggingFaceTransformersModule {
  pipeline: (
    task: 'feature-extraction',
    model: string
  ) => Promise<LocalFeatureExtractionPipeline>;
}

interface LocalModelCacheEntry {
  promise: Promise<LocalFeatureExtractionPipeline>;
  settled: boolean;
  waiters: number;
}

interface RuntimeEnvironment {
  process?: { env?: Record<string, string | undefined> };
  Deno?: { env?: { get?: (name: string) => string | undefined } };
}

interface GeminiEmbeddingResult {
  embeddings?: Array<{
    values?: unknown;
  }>;
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

const OPENAI_DEFAULT_DIMENSIONS = 768;
const OPENAI_COMPATIBLE_DEFAULT_BATCH_SIZE = 32;
const LOCAL_DIMENSIONS = 384;
const DEFAULT_MAX_LENGTH = 8000;
const DEFAULT_TIMEOUT_MS = 30_000;
const LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';
const GEMINI_MODEL = 'gemini-embedding-2';
const GEMINI_DIMENSIONS = 3072;
const GEMINI_MIN_DIMENSIONS = 128;
const GEMINI_MAX_DIMENSIONS = 3072;
const OPENAI_SMALL_MODEL = 'text-embedding-3-small';
const OPENAI_LARGE_MODEL = 'text-embedding-3-large';
const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const MISTRAL_MODEL = 'mistral-embed';
const MISTRAL_EMBEDDINGS_URL = 'https://api.mistral.ai/v1/embeddings';
const MISTRAL_DIMENSIONS = 1024;
const CLOUDFLARE_MODEL = '@cf/baai/bge-m3';
const CLOUDFLARE_DIMENSIONS = 1024;

const localModelCacheByModel = new Map<string, LocalModelCacheEntry>();

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

function deletePendingLocalModelCache(modelName: string, entry: LocalModelCacheEntry): void {
  if (!entry.settled && entry.waiters === 0 && localModelCacheByModel.get(modelName) === entry) {
    localModelCacheByModel.delete(modelName);
  }
}

async function getLocalEmbeddingModel(
  modelName: string,
  signal: AbortSignal
): Promise<LocalFeatureExtractionPipeline> {
  const cached = localModelCacheByModel.get(modelName);
  if (cached) {
    cached.waiters++;
    try {
      return await waitForLocalEmbeddingModel(modelName, cached, signal);
    } finally {
      cached.waiters--;
      deletePendingLocalModelCache(modelName, cached);
    }
  }

  const modelPromise = (async () => {
    console.log(`Loading local embedding model (${modelName})...`);
    const { pipeline } = await import('@huggingface/transformers') as HuggingFaceTransformersModule;
    const model = await pipeline('feature-extraction', modelName);
    console.log('Local model loaded successfully');
    return model;
  })();

  const entry: LocalModelCacheEntry = {
    promise: modelPromise,
    settled: false,
    waiters: 1
  };
  localModelCacheByModel.set(modelName, entry);

  modelPromise
    .then(() => {
      entry.settled = true;
    })
    .catch(() => {
      localModelCacheByModel.delete(modelName);
    });

  try {
    return await waitForLocalEmbeddingModel(modelName, entry, signal);
  } finally {
    entry.waiters--;
    deletePendingLocalModelCache(modelName, entry);
  }
}

async function waitForLocalEmbeddingModel(
  modelName: string,
  entry: LocalModelCacheEntry,
  signal: AbortSignal
): Promise<LocalFeatureExtractionPipeline> {
  if (signal.aborted) {
    deletePendingLocalModelCache(modelName, entry);
    throw providerError('local', 'model inference was aborted');
  }

  let rejectAbort: (error: Error) => void = () => {};
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    rejectAbort(providerError('local', 'model inference was aborted'));
  };

  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await Promise.race([entry.promise, abortPromise]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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
    case 'mistral':
    case 'cloudflare':
    case 'openai-compatible':
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

function getOptionalTrimmedCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function getRequiredTrimmedString(value: string | undefined, optionName: string): string {
  const trimmed = getOptionalTrimmedCredential(value);
  if (!trimmed) {
    throw new Error(`Invalid ${optionName}: expected a non-empty string`);
  }

  return trimmed;
}

function hasOwnProperty(value: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function redactErrorText(value: unknown, exactSecrets: readonly string[] = []): string {
  let raw = value instanceof Error ? value.message : String(value);

  for (const secret of exactSecrets) {
    if (secret.length > 0) {
      raw = raw.split(secret).join('[redacted]');
    }
  }

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

function providerError(
  provider: EmbeddingProvider,
  message: string,
  cause?: unknown,
  exactSecrets: readonly string[] = []
): Error {
  const safeCause = cause === undefined ? '' : `: ${redactErrorText(cause, exactSecrets).trim()}`;
  return new Error(`${provider} embedding error: ${message}${safeCause}`);
}

function getResponseHeader(response: Response, name: string): string | undefined {
  return response.headers.get(name) ?? undefined;
}

function getSafeResponseHeader(response: Response, name: string): string | undefined {
  const value = getResponseHeader(response, name)?.trim();
  if (!value) {
    return undefined;
  }

  return value.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 128);
}

function createCloudflareEmbeddingsUrl(accountId: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1/embeddings`;
}

function formatGeminiEmbeddingContent(text: string, intent: EmbeddingIntent): string {
  return intent === 'query'
    ? `task: search result | query: ${text}`
    : `title: none | text: ${text}`;
}

function parseGeminiEmbeddingResult(result: GeminiEmbeddingResult): number[] {
  if (!Array.isArray(result.embeddings)) {
    throw new Error('Gemini response did not include an embeddings array');
  }

  if (result.embeddings.length !== 1) {
    throw new Error(`Gemini response included ${result.embeddings.length} embedding result(s) for one input`);
  }

  const values = result.embeddings[0]?.values;
  if (!Array.isArray(values)) {
    throw new Error('Gemini response did not include embedding values');
  }

  return values;
}

async function withTimeout<T>(
  provider: EmbeddingProvider,
  operation: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
  exactSecrets: readonly string[] = []
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

    throw providerError(provider, `${operation} failed`, error, exactSecrets);
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

function throwIfAborted(
  provider: EmbeddingProvider,
  operation: string,
  signal: AbortSignal
): void {
  if (signal.aborted) {
    throw providerError(provider, `${operation} was aborted`);
  }
}

async function embedSequentially(
  provider: EmbeddingProvider,
  operation: string,
  texts: string[],
  signal: AbortSignal,
  embedOne: (text: string, signal: AbortSignal) => Promise<number[]>
): Promise<number[][]> {
  const results: number[][] = [];

  for (const text of texts) {
    throwIfAborted(provider, operation, signal);
    const embedding = await embedOne(text, signal);
    throwIfAborted(provider, operation, signal);
    results.push(embedding);
  }

  return results;
}

function normalizeOpenAICompatibleEmbeddingsUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Invalid baseUrl: expected an absolute http or https URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Invalid baseUrl: expected an absolute http or https URL');
  }

  if (url.username || url.password) {
    throw new Error('Invalid baseUrl: URL credentials are not allowed');
  }

  if (url.search || url.hash) {
    throw new Error('Invalid baseUrl: query strings and fragments are not allowed');
  }

  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/embeddings') ? path : `${path}/embeddings`;
  return url.toString();
}

function createProviderMetadata(
  provider: EmbeddingProvider,
  dimensions: number,
  model?: string
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
        dimensions,
        batch: Object.freeze({ mode: 'sequential' as const })
      });
    case 'openai':
      return Object.freeze({
        name: 'openai' as const,
        model: getOpenAIModel(dimensions),
        dimensions,
        batch: Object.freeze({ mode: 'native' as const, maxSize: 2048 })
      });
    case 'mistral':
      return Object.freeze({
        name: 'mistral' as const,
        model: MISTRAL_MODEL,
        dimensions: MISTRAL_DIMENSIONS,
        batch: Object.freeze({ mode: 'native' as const })
      });
    case 'cloudflare':
      return Object.freeze({
        name: 'cloudflare' as const,
        model: CLOUDFLARE_MODEL,
        dimensions: CLOUDFLARE_DIMENSIONS,
        batch: Object.freeze({ mode: 'native' as const })
      });
    case 'openai-compatible':
      return Object.freeze({
        name: 'openai-compatible' as const,
        model: getRequiredTrimmedString(model, 'model'),
        dimensions,
        batch: Object.freeze({ mode: 'native' as const })
      });
  }
}

function getEffectiveDimensions(
  provider: EmbeddingProvider,
  dimensions: number | undefined
): number {
  if (provider === 'local') {
    if (dimensions !== undefined && dimensions !== LOCAL_DIMENSIONS) {
      throw providerError(
        'local',
        `${LOCAL_MODEL} returns ${LOCAL_DIMENSIONS} dimensions; received dimensions ${String(dimensions)}`
      );
    }

    return LOCAL_DIMENSIONS;
  }

  if (provider === 'gemini') {
    const effectiveDimensions = dimensions ?? GEMINI_DIMENSIONS;
    if (
      !Number.isInteger(effectiveDimensions)
      || effectiveDimensions < GEMINI_MIN_DIMENSIONS
      || effectiveDimensions > GEMINI_MAX_DIMENSIONS
    ) {
      throw providerError(
        'gemini',
        `${GEMINI_MODEL} supports dimensions from ${GEMINI_MIN_DIMENSIONS} to ${GEMINI_MAX_DIMENSIONS}; received dimensions ${String(dimensions)}`
      );
    }

    return effectiveDimensions;
  }

  if (provider === 'mistral') {
    if (dimensions !== undefined && dimensions !== MISTRAL_DIMENSIONS) {
      throw providerError(
        'mistral',
        `${MISTRAL_MODEL} returns ${MISTRAL_DIMENSIONS} dimensions; received dimensions ${dimensions}`
      );
    }

    return MISTRAL_DIMENSIONS;
  }

  if (provider === 'cloudflare') {
    if (dimensions !== undefined && dimensions !== CLOUDFLARE_DIMENSIONS) {
      throw providerError(
        'cloudflare',
        `@cf/baai/bge-m3 returns ${CLOUDFLARE_DIMENSIONS} dimensions; received dimensions ${dimensions}`
      );
    }

    return CLOUDFLARE_DIMENSIONS;
  }

  if (provider === 'openai-compatible') {
    if (dimensions === undefined) {
      throw new Error('Invalid dimensions: expected a positive integer');
    }

    return getPositiveInteger(dimensions, 'dimensions');
  }

  return getPositiveInteger(dimensions ?? OPENAI_DEFAULT_DIMENSIONS, 'dimensions');
}

function assertBatchSize(metadata: EmbeddingProviderMetadata, count: number): void {
  if (metadata.batch.maxSize !== undefined && count > metadata.batch.maxSize) {
    throw providerError(
      metadata.name,
      `batch size ${count} exceeds maximum ${metadata.batch.maxSize}`
    );
  }
}

function chunkTexts(texts: string[], batchSize: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < texts.length; index += batchSize) {
    chunks.push(texts.slice(index, index + batchSize));
  }

  return chunks;
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
      async (signal) => {
        const model = await getLocalEmbeddingModel(this.metadata.model, signal);
        return embedSequentially('local', 'model inference', texts, signal, async (text) => {
          const output = await model(text, {
            pooling: 'mean',
            normalize: true
          });
          return Array.from(output.data);
        });
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
      async (signal) => {
        const { GoogleGenAI } = await import('@google/genai');
        const client = new GoogleGenAI({ apiKey: this.#apiKey });
        return embedSequentially('gemini', 'API request', texts, signal, async (text, itemSignal) => {
          const result = await client.models.embedContent({
            model: this.metadata.model,
            contents: formatGeminiEmbeddingContent(text, intent),
            config: {
              outputDimensionality: this.metadata.dimensions,
              abortSignal: itemSignal
            }
          }) as GeminiEmbeddingResult;

          return parseGeminiEmbeddingResult(result);
        });
      },
      options.signal,
      [this.#apiKey]
    );

    return createEmbeddingBatchResult(
      this.metadata,
      intent,
      validateEmbeddingBatch(vectors, texts.length, this.metadata.dimensions, 'gemini')
    );
  }
}

interface OpenAICompatibleEmbeddingsRequest {
  responseLabel: string;
  endpoint: string;
  apiKey?: string;
  model: string;
  texts: string[];
  signal: AbortSignal;
  dimensions?: number;
  encodingFormat?: 'float';
  requireIndex?: boolean;
  redirect?: 'error';
  statusHeader?: {
    name: string;
    label: string;
  };
}

async function requestOpenAICompatibleEmbeddings(
  request: OpenAICompatibleEmbeddingsRequest
): Promise<EmbeddingBatchItem[]> {
  const body: Record<string, unknown> = {
    input: request.texts,
    model: request.model
  };

  if (request.dimensions !== undefined) {
    body.dimensions = request.dimensions;
  }

  if (request.encodingFormat !== undefined) {
    body.encoding_format = request.encodingFormat;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  };

  if (request.apiKey !== undefined) {
    headers.Authorization = `Bearer ${request.apiKey}`;
  }

  const response = await fetch(request.endpoint, {
    method: 'POST',
    headers,
    signal: request.signal,
    body: JSON.stringify(body),
    ...(request.redirect ? { redirect: request.redirect } : {})
  });

  if (!response.ok) {
    const statusHeader = request.statusHeader ?? { name: 'x-request-id', label: 'request' };
    const statusHeaderValue = getSafeResponseHeader(response, statusHeader.name);
    const context = statusHeaderValue
      ? ` status ${response.status}, ${statusHeader.label} ${statusHeaderValue}`
      : ` status ${response.status}`;
    throw new Error(context);
  }

  const data = await response.json() as OpenAIEmbeddingResponse;
  if (!Array.isArray(data.data)) {
    throw new Error(`${request.responseLabel} response did not include a data array`);
  }

  return data.data.map((item: unknown): EmbeddingBatchItem => {
    if (!isRecord(item)) {
      throw new Error(`${request.responseLabel} response item was not an object`);
    }

    const embedding = item.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error(`${request.responseLabel} response item did not include an embedding array`);
    }

    const parsed: EmbeddingBatchItemResult = { embedding };
    if (hasOwnProperty(item, 'index')) {
      parsed.index = item.index;
    } else if (request.requireIndex) {
      throw new Error(`${request.responseLabel} response item did not include an index`);
    }

    return parsed;
  });
}

interface OpenAICompatibleProviderProfile {
  provider: EmbeddingProvider;
  responseLabel: string;
  endpoint: string;
  apiKey?: string;
  model: string;
  dimensions: number;
  includeDimensions?: boolean;
  encodingFormat?: 'float';
  requireIndex?: boolean;
  redirect?: 'error';
  statusHeader?: {
    name: string;
    label: string;
  };
  batchSize?: number;
  exactSecrets?: readonly string[];
}

class OpenAICompatibleEmbeddingProvider implements EmbeddingProviderClient {
  readonly metadata: EmbeddingProviderMetadata;
  readonly #timeoutMs: number;
  readonly #profile: OpenAICompatibleProviderProfile;

  constructor(metadata: EmbeddingProviderMetadata, profile: OpenAICompatibleProviderProfile, timeoutMs: number) {
    this.metadata = metadata;
    this.#profile = profile;
    this.#timeoutMs = timeoutMs;
  }

  async embed(texts: string[], options: EmbeddingRequestOptions = {}): Promise<EmbeddingBatchResult> {
    const intent = resolveIntent(options.intent);
    if (texts.length === 0) {
      return createEmbeddingBatchResult(this.metadata, intent, []);
    }

    assertBatchSize(this.metadata, texts.length);
    const items = await withTimeout(
      this.#profile.provider,
      'API request',
      this.#timeoutMs,
      async (signal) => {
        const batches = this.#profile.batchSize === undefined
          ? [texts]
          : chunkTexts(texts, this.#profile.batchSize);
        const results: EmbeddingBatchItem[] = [];

        for (const batch of batches) {
          throwIfAborted(this.#profile.provider, 'API request', signal);
          const batchItems = await requestOpenAICompatibleEmbeddings({
            responseLabel: this.#profile.responseLabel,
            endpoint: this.#profile.endpoint,
            ...(this.#profile.apiKey !== undefined ? { apiKey: this.#profile.apiKey } : {}),
            model: this.#profile.model,
            texts: batch,
            signal,
            ...(this.#profile.includeDimensions ? { dimensions: this.#profile.dimensions } : {}),
            ...(this.#profile.encodingFormat ? { encodingFormat: this.#profile.encodingFormat } : {}),
            ...(this.#profile.requireIndex !== undefined ? { requireIndex: this.#profile.requireIndex } : {}),
            ...(this.#profile.redirect ? { redirect: this.#profile.redirect } : {}),
            ...(this.#profile.statusHeader ? { statusHeader: this.#profile.statusHeader } : {})
          });
          results.push(...validateEmbeddingBatch(
            batchItems,
            batch.length,
            this.metadata.dimensions,
            this.#profile.provider
          ));
          throwIfAborted(this.#profile.provider, 'API request', signal);
        }

        return results;
      },
      options.signal,
      this.#profile.exactSecrets ?? []
    );

    return createEmbeddingBatchResult(
      this.metadata,
      intent,
      validateEmbeddingBatch(items, texts.length, this.metadata.dimensions, this.#profile.provider)
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
      const key = getOptionalTrimmedCredential(
        options.apiKey ?? getEnvironmentVariable('GEMINI_API_KEY')
      );
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

      return new OpenAICompatibleEmbeddingProvider(metadata, {
        provider: 'openai',
        responseLabel: 'OpenAI',
        endpoint: OPENAI_EMBEDDINGS_URL,
        apiKey: key,
        model: metadata.model,
        dimensions: metadata.dimensions,
        includeDimensions: true,
        exactSecrets: [key]
      }, timeoutMs);
    }
    case 'mistral': {
      const key = getOptionalTrimmedCredential(
        options.apiKey ?? getEnvironmentVariable('MISTRAL_API_KEY')
      );
      if (!key) {
        throw new Error('MISTRAL_API_KEY is required for Mistral embeddings');
      }

      return new OpenAICompatibleEmbeddingProvider(metadata, {
        provider: 'mistral',
        responseLabel: 'Mistral',
        endpoint: MISTRAL_EMBEDDINGS_URL,
        apiKey: key,
        model: metadata.model,
        dimensions: metadata.dimensions,
        encodingFormat: 'float',
        requireIndex: true,
        exactSecrets: [key]
      }, timeoutMs);
    }
    case 'cloudflare': {
      const accountId = getOptionalTrimmedCredential(
        options.accountId ?? getEnvironmentVariable('CLOUDFLARE_ACCOUNT_ID')
      );
      const apiToken = getOptionalTrimmedCredential(
        options.apiToken ?? getEnvironmentVariable('CLOUDFLARE_API_TOKEN')
      );

      if (!accountId) {
        throw new Error('CLOUDFLARE_ACCOUNT_ID is required for Cloudflare embeddings');
      }

      if (!apiToken) {
        throw new Error('CLOUDFLARE_API_TOKEN is required for Cloudflare embeddings');
      }

      const endpoint = createCloudflareEmbeddingsUrl(accountId);
      return new OpenAICompatibleEmbeddingProvider(metadata, {
        provider: 'cloudflare',
        responseLabel: 'Cloudflare',
        endpoint,
        apiKey: apiToken,
        model: metadata.model,
        dimensions: metadata.dimensions,
        statusHeader: { name: 'cf-ray', label: 'cf-ray' },
        exactSecrets: [apiToken, accountId, encodeURIComponent(accountId), endpoint]
      }, timeoutMs);
    }
    case 'openai-compatible': {
      const baseUrl = getRequiredTrimmedString(options.baseUrl, 'baseUrl');
      const endpoint = normalizeOpenAICompatibleEmbeddingsUrl(baseUrl);
      const apiKey = getOptionalTrimmedCredential(options.apiKey);
      const batchSize = getPositiveInteger(
        options.batchSize ?? OPENAI_COMPATIBLE_DEFAULT_BATCH_SIZE,
        'batchSize'
      );

      return new OpenAICompatibleEmbeddingProvider(metadata, {
        provider: 'openai-compatible',
        responseLabel: 'OpenAI-compatible',
        endpoint,
        ...(apiKey ? { apiKey } : {}),
        model: metadata.model,
        dimensions: metadata.dimensions,
        includeDimensions: true,
        encodingFormat: 'float',
        requireIndex: true,
        redirect: 'error',
        batchSize,
        exactSecrets: [
          ...(apiKey ? [apiKey] : []),
          baseUrl,
          endpoint
        ]
      }, timeoutMs);
    }
  }
}

export function getEmbeddingProviderMetadata(options: EmbeddingOptions = {}): EmbeddingProviderMetadata {
  const provider = resolveProviderName(options.provider);
  if (provider === 'openai-compatible') {
    normalizeOpenAICompatibleEmbeddingsUrl(getRequiredTrimmedString(options.baseUrl, 'baseUrl'));
    if (options.batchSize !== undefined) {
      getPositiveInteger(options.batchSize, 'batchSize');
    }
  }

  return createProviderMetadata(provider, getEffectiveDimensions(provider, options.dimensions), options.model);
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
