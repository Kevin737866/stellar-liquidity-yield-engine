import { SorobanRpc } from "stellar-sdk";
import type {
  NetworkConfig,
  NetworkContractName,
} from "../types";

const MAX_RPC_TIMEOUT_MS = 2_147_483_647;

/**
 * Apply a per-request timeout to Soroban RPC methods. Stellar SDK 12 exposes
 * a timeout option in its types but does not apply it to HTTP requests.
 */
export function withRpcTimeout(
  server: SorobanRpc.Server,
  timeoutMs?: number,
  contractName?: NetworkContractName,
): SorobanRpc.Server {
  if (timeoutMs === undefined) {
    return server;
  }

  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_RPC_TIMEOUT_MS
  ) {
    const option = contractName
      ? `rpcTimeoutMs.${contractName}`
      : "RPC timeout";
    throw new RangeError(
      `${option} must be an integer within [1, ${MAX_RPC_TIMEOUT_MS}] milliseconds`,
    );
  }

  return new Proxy(server, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (typeof method !== "function") {
        return method;
      }

      return (...args: unknown[]) => {
        const request: unknown = Reflect.apply(method, target, args);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Soroban RPC request timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        });

        return Promise.race([Promise.resolve(request), timeout]).finally(() => {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
        });
      };
    },
  });
}

export function createContractRpcServer(
  config: Pick<NetworkConfig, "sorobanRpcUrl" | "rpcTimeoutMs">,
  contractName: NetworkContractName,
): SorobanRpc.Server {
  return withRpcTimeout(
    new SorobanRpc.Server(config.sorobanRpcUrl),
    config.rpcTimeoutMs?.[contractName],
    contractName,
  );
}
