/**
 * Deposit amount validation.
 *
 * The vault's `deposit` entrypoint takes base-unit amounts as `bigint`, so the
 * deposit form only accepts whole, positive token base units. Validating here —
 * rather than letting `BigInt()` throw inside the transaction — lets the review
 * step explain what is wrong before anything is signed.
 */

export interface ParsedDepositAmount {
  ok: boolean;
  /** Parsed amount; `0n` when `ok` is false. */
  value: bigint;
  error?: string;
}

/** Parse one deposit amount entered in the UI. */
export function parseDepositAmount(raw: string, label: string): ParsedDepositAmount {
  const trimmed = raw.trim();

  if (!trimmed) {
    return { ok: false, value: 0n, error: `Enter a ${label} amount.` };
  }

  // Decimals would silently truncate, and exponents/hex are not base units.
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      value: 0n,
      error: `${label} must be a whole number of base units (decimals are not supported).`,
    };
  }

  const value = BigInt(trimmed);
  if (value <= 0n) {
    return { ok: false, value: 0n, error: `${label} must be greater than zero.` };
  }

  return { ok: true, value };
}

export interface DepositAmountValidation {
  ok: boolean;
  amountA: bigint;
  amountB: bigint;
  errors: string[];
}

/** Validate both sides of a two-token deposit. */
export function validateDepositAmounts(rawA: string, rawB: string): DepositAmountValidation {
  const a = parseDepositAmount(rawA, 'Token A');
  const b = parseDepositAmount(rawB, 'Token B');
  const errors = [a.error, b.error].filter((error): error is string => Boolean(error));

  return {
    ok: errors.length === 0,
    amountA: a.value,
    amountB: b.value,
    errors,
  };
}
