import { Address, SorobanRpc } from "stellar-sdk";
import { RebalancerClient } from "../rebalancer";
import { StrategyRegistryClient } from "../strategyRegistryClient";
import { VaultClient } from "../vaultClient";
import type { NetworkConfig } from "../types";
import { createContractRpcServer, withRpcTimeout } from "./rpcTimeout";

const contractId = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

describe("Soroban RPC timeouts", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("preserves the original server when no timeout is configured", () => {
    const server = new SorobanRpc.Server("https://rpc.example.com");

    expect(withRpcTimeout(server)).toBe(server);
  });

  it("rejects invalid timeout values", () => {
    const server = new SorobanRpc.Server("https://rpc.example.com");

    for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => withRpcTimeout(server, timeoutMs, "yieldEngine")).toThrow(
        "rpcTimeoutMs.yieldEngine must be an integer within [1, 2147483647] milliseconds",
      );
    }

    expect(() => withRpcTimeout(server, 1, "yieldEngine")).not.toThrow();
    expect(() =>
      withRpcTimeout(server, 2_147_483_647, "yieldEngine"),
    ).not.toThrow();
  });

  it("uses each client's corresponding contract timeout", () => {
    const config: NetworkConfig = {
      network: "testnet",
      horizonUrl: "https://horizon.example.com",
      sorobanRpcUrl: "https://rpc.example.com",
      contracts: {
        yieldEngine: contractId,
        rewardDistributor: contractId,
        rebalanceEngine: contractId,
        strategyRegistry: contractId,
      },
      rpcTimeoutMs: {
        yieldEngine: 0,
        rebalanceEngine: 0,
        strategyRegistry: 0,
      },
    };

    expect(
      () =>
        new VaultClient(
          new Address(contractId),
          config,
        ),
    ).toThrow("rpcTimeoutMs.yieldEngine");
    expect(() => new RebalancerClient(config)).toThrow(
      "rpcTimeoutMs.rebalanceEngine",
    );
    expect(() => new StrategyRegistryClient(config)).toThrow(
      "rpcTimeoutMs.strategyRegistry",
    );
  });

  it("uses the timeout configured for the requested contract", async () => {
    jest.useFakeTimers();

    const config = {
      sorobanRpcUrl: "https://rpc.example.com",
      rpcTimeoutMs: {
        yieldEngine: 100,
        rebalanceEngine: 200,
      },
    };
    const vaultServer = createContractRpcServer(config, "yieldEngine");
    const rebalanceServer = createContractRpcServer(config, "rebalanceEngine");
    const vaultRequest = new Promise<never>(() => undefined);
    const rebalanceRequest = new Promise<never>(() => undefined);

    Object.defineProperty(vaultServer, "getHealth", {
      configurable: true,
      value: jest.fn().mockReturnValue(vaultRequest),
    });
    Object.defineProperty(rebalanceServer, "getHealth", {
      configurable: true,
      value: jest.fn().mockReturnValue(rebalanceRequest),
    });

    const vaultResult = expect(vaultServer.getHealth()).rejects.toThrow(
      "timed out after 100ms",
    );
    const rebalanceResult = expect(rebalanceServer.getHealth()).rejects.toThrow(
      "timed out after 200ms",
    );

    await jest.advanceTimersByTimeAsync(100);
    await vaultResult;
    await jest.advanceTimersByTimeAsync(100);
    await rebalanceResult;
  });

  it("resolves successful RPC calls before their timeout", async () => {
    jest.useFakeTimers();
    const server = new SorobanRpc.Server("https://rpc.example.com");
    Object.defineProperty(server, "getHealth", {
      configurable: true,
      value: jest.fn().mockResolvedValue({ status: "healthy" }),
    });

    const timedServer = withRpcTimeout(server, 100);

    await expect(timedServer.getHealth()).resolves.toEqual({
      status: "healthy",
    });
    expect(jest.getTimerCount()).toBe(0);
  });
});
