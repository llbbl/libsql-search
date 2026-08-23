const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 100;

/**
 * Multiplier applied to `limit` when deriving the default candidate count.
 *
 * The vector index is approximate, so the default search over-fetches
 * candidates and re-ranks them exactly. Four candidates per requested result
 * recovers most of the recall an ANN probe loses without materially changing
 * the cost of the join.
 */
export const DEFAULT_SEARCH_CANDIDATE_MULTIPLIER = 4;

/**
 * Floor for the default candidate count. Small limits would otherwise probe
 * the index too shallowly for the exact re-rank to have anything to work with.
 */
export const MIN_SEARCH_CANDIDATES = 32;

/**
 * Ceiling for an explicit `candidates` value. Mirrors {@link MAX_SEARCH_LIMIT},
 * scaled by an order of magnitude, so the widest legal probe still stays well
 * short of a full table scan.
 */
export const MAX_SEARCH_CANDIDATES = MAX_SEARCH_LIMIT * 10;

export function validateSqlIdentifier(identifier: string, name: string = 'identifier'): string {
  if (typeof identifier !== 'string' || !SQL_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(
      `Invalid SQL ${name}: expected an ASCII identifier matching ${SQL_IDENTIFIER_PATTERN.toString()}`
    );
  }

  return identifier;
}

export function quoteSqlIdentifier(identifier: string, name?: string): string {
  const validated = validateSqlIdentifier(identifier, name);
  return `"${validated.replace(/"/g, '""')}"`;
}

export function normalizeSearchLimit(limit: unknown = DEFAULT_SEARCH_LIMIT): number {
  if (
    typeof limit !== 'number' ||
    !Number.isFinite(limit) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_SEARCH_LIMIT
  ) {
    throw new Error(`Invalid search limit: expected an integer from 1 to ${MAX_SEARCH_LIMIT}`);
  }

  return limit;
}

/**
 * Default number of index candidates fetched for a given result limit.
 */
export function defaultSearchCandidates(limit: number): number {
  return Math.min(
    Math.max(limit * DEFAULT_SEARCH_CANDIDATE_MULTIPLIER, MIN_SEARCH_CANDIDATES),
    MAX_SEARCH_CANDIDATES
  );
}

/**
 * Validate the number of approximate-nearest-neighbor candidates to fetch.
 *
 * `limit` must already be normalized. Fewer candidates than results requested
 * is always a mistake, so it is rejected rather than silently clamped: the
 * caller would otherwise get a short result set with no indication why.
 */
export function normalizeSearchCandidates(candidates: unknown, limit: number): number {
  if (candidates === undefined) {
    return defaultSearchCandidates(limit);
  }

  if (
    typeof candidates !== 'number' ||
    !Number.isFinite(candidates) ||
    !Number.isInteger(candidates) ||
    candidates < limit ||
    candidates > MAX_SEARCH_CANDIDATES
  ) {
    throw new Error(
      `Invalid search candidates: expected an integer from the search limit (${limit}) ` +
        `to ${MAX_SEARCH_CANDIDATES}`
    );
  }

  return candidates;
}

export function normalizeVectorDimensions(dimensions: unknown): number {
  if (
    typeof dimensions !== 'number' ||
    !Number.isFinite(dimensions) ||
    !Number.isInteger(dimensions) ||
    dimensions < 1
  ) {
    throw new Error('Invalid vector dimensions: expected a positive integer');
  }

  return dimensions;
}
