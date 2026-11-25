export interface ParsedPriceRatios {
  values: number[];
  invalidEntries: string[];
}

export function parsePriceRatioList(input: string): ParsedPriceRatios {
  const entries = input
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const values: number[] = [];
  const invalidEntries: string[] = [];

  for (const entry of entries) {
    const value = Number(entry);
    if (Number.isFinite(value) && value > 0) {
      values.push(value);
    } else {
      invalidEntries.push(entry);
    }
  }

  return { values, invalidEntries };
}

export function formatIlPercent(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : 'Unavailable';
}

export function formatPriceRatio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : 'Unavailable';
}
