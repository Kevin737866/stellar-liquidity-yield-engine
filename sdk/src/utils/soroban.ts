import {
  Address,
  SorobanRpc,
  nativeToScVal,
  scValToNative,
  xdr,
} from 'stellar-sdk';

/**
 * Typed helpers around the Soroban RPC API surface.
 *
 * `stellar-sdk` requires every contract argument to be an `xdr.ScVal` and
 * splits simulation/transaction responses into success and error variants.
 * These helpers keep that narrowing in one place instead of scattering casts
 * through the clients.
 */

export function toAddress(value: Address | string): Address {
  return value instanceof Address ? value : new Address(value);
}

export function addressArg(value: Address | string): xdr.ScVal {
  return toAddress(value).toScVal();
}

export function u32Arg(value: number | bigint): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: 'u32' });
}

export function u64Arg(value: number | bigint): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: 'u64' });
}

export function i128Arg(value: number | bigint): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: 'i128' });
}

export function symbolArg(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: 'symbol' });
}

export function stringArg(value: string): xdr.ScVal {
  return nativeToScVal(value, { type: 'string' });
}

export function boolArg(value: boolean): xdr.ScVal {
  return nativeToScVal(value, { type: 'bool' });
}

export function vecArg(items: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec(items);
}

/** Encode a contract struct as a map keyed by field-name symbols. */
export function structArg(fields: Array<[string, xdr.ScVal]>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    fields.map(
      ([name, val]) =>
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol(name),
          val,
        }),
    ),
  );
}

/**
 * Return the invocation result of a successful simulation.
 *
 * Throws for failed simulations and for restore preambles, which the caller
 * must resolve before the invocation can produce a value.
 */
export function simulationReturnValue(
  response: SorobanRpc.Api.SimulateTransactionResponse,
): xdr.ScVal {
  if (SorobanRpc.Api.isSimulationError(response)) {
    throw new Error(`Simulation failed: ${response.error}`);
  }
  if (SorobanRpc.Api.isSimulationRestore(response)) {
    throw new Error('Simulation requires restoring archived ledger entries');
  }
  if (!response.result) {
    throw new Error('Simulation returned no result');
  }
  return response.result.retval;
}

/** Return the invocation result of a successful simulation as native JS. */
export function simulationNative<T = unknown>(
  response: SorobanRpc.Api.SimulateTransactionResponse,
): T {
  return scValToNative(simulationReturnValue(response)) as T;
}

/** Return the invoked contract's return value once a transaction succeeds. */
export function confirmedReturnValue(
  response: SorobanRpc.Api.GetTransactionResponse,
): xdr.ScVal {
  if (response.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction did not succeed: ${response.status}`);
  }
  return (response as SorobanRpc.Api.GetSuccessfulTransactionResponse)
    .returnValue!;
}

/** Human-readable error text for a rejected transaction submission. */
export function submissionError(
  response: SorobanRpc.Api.SendTransactionResponse,
): string | undefined {
  if (response.status !== 'ERROR') {
    return undefined;
  }
  return response.errorResult
    ? response.errorResult.toXDR('base64')
    : 'Transaction submission failed';
}
