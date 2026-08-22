import { vi } from 'vitest';

export const LOCAL_TEST_DIMENSIONS = 384;

export interface LocalModelCall {
  text: string;
  options: {
    pooling?: string;
    normalize?: boolean;
  };
}

function deterministicVector(text: string): number[] {
  const lower = text.toLowerCase();
  const vector = new Array(LOCAL_TEST_DIMENSIONS).fill(0);

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

const huggingFaceTransformersMock = vi.hoisted(() => {
  const globalState = globalThis as typeof globalThis & {
    __LIBSQL_SEARCH_HF_TRANSFORMERS_MOCK__?: {
      calls: LocalModelCall[];
      queuedVectors: number[][];
      pipeline: ReturnType<typeof vi.fn>;
      model: ReturnType<typeof vi.fn>;
    };
  };

  if (globalState.__LIBSQL_SEARCH_HF_TRANSFORMERS_MOCK__) {
    return globalState.__LIBSQL_SEARCH_HF_TRANSFORMERS_MOCK__;
  }

  const state = {
    calls: [] as LocalModelCall[],
    queuedVectors: [] as number[][],
    pipeline: vi.fn(),
    model: vi.fn()
  };

  const createVector = (text: string): number[] => {
    const next = state.queuedVectors.shift();
    if (next) {
      return next;
    }

    const lower = text.toLowerCase();
    const vector = new Array(384).fill(0);

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
  };

  state.model.mockImplementation(async (text: string, options: LocalModelCall['options']) => {
    state.calls.push({ text, options });
    return {
      data: Float32Array.from(createVector(text))
    };
  });

  state.pipeline.mockResolvedValue(state.model);

  globalState.__LIBSQL_SEARCH_HF_TRANSFORMERS_MOCK__ = state;
  return state;
});

vi.mock('@huggingface/transformers', () => ({
  pipeline: huggingFaceTransformersMock.pipeline
}));

export { huggingFaceTransformersMock };

export function resetHuggingFaceTransformersMock(): void {
  huggingFaceTransformersMock.calls = [];
  huggingFaceTransformersMock.queuedVectors = [];
  huggingFaceTransformersMock.model.mockClear();
  huggingFaceTransformersMock.model.mockImplementation(async (text: string, options: LocalModelCall['options']) => {
    huggingFaceTransformersMock.calls.push({ text, options });
    const next = huggingFaceTransformersMock.queuedVectors.shift();
    return {
      data: Float32Array.from(next ?? deterministicVector(text))
    };
  });
  huggingFaceTransformersMock.pipeline.mockReset();
  huggingFaceTransformersMock.pipeline.mockResolvedValue(huggingFaceTransformersMock.model);
}
