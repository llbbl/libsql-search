const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 100;

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
