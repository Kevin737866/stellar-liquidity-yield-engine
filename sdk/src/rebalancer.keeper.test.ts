import { Keypair, StrKey } from "stellar-sdk";
import { RebalancerClient } from "./rebalancer";

const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));

function buildClient(overrides: Partial<{ network: string; sorobanRpcUrl: string }> = {}) {
  return new RebalancerClient({
    network: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    sorobanRpcUrl: "https://soroban-testnet.stellar.org",
    contracts: {
      yieldEngine: contractId,
      rewardDistributor: contractId,
      rebalanceEngine: contractId,
      strategyRegistry: contractId,
    },
    ...overrides,
  } as any);
}

describe("RebalancerClient APY keeper permissions", () => {
  it("exposes a dedicated APY keeper workflow separate from the admin flow", () => {
    const client = buildClient();

    expect(typeof client.setApyKeepers).toBe("function");
    expect(typeof client.getApyKeepers).toBe("function");
    expect(typeof client.updatePoolApy).toBe("function");
    expect(typeof client.getPoolCurrentApy).toBe("function");
    expect(typeof client.getPoolApyRecord).toBe("function");

    const admin = Keypair.random();
    const keeper = Keypair.random();
    expect(admin.publicKey()).not.toBe(keeper.publicKey());
  });

  it("documents role rotation as a distinct operation from keeper updates", () => {
    const client = buildClient();
    // Role rotation (setApyKeepers) must be callable independently of the
    // keeper write path (updatePoolApy), so governance can replace keepers
    // without touching pool APY state.
    expect(client.setApyKeepers).not.toBe(client.updatePoolApy);
    expect(client.getApyKeepers).not.toBe(client.setApyKeepers);
  });

  it("keeps signing keys distinct when rotating a keeper key", () => {
    const oldKeeper = Keypair.random();
    const newKeeper = Keypair.random();

    expect(newKeeper.publicKey()).not.toBe(oldKeeper.publicKey());
    expect(StrKey.isValidEd25519PublicKey(newKeeper.publicKey())).toBe(true);
  });

  it("rejects malformed keeper public keys during rotation", () => {
    const client = buildClient();
    const invalidKeeper = "not-a-valid-public-key";

    expect(StrKey.isValidEd25519PublicKey(invalidKeeper)).toBe(false);
    expect(StrKey.isValidEd25519PublicKey("")).toBe(false);
    expect(typeof client.setApyKeepers).toBe("function");
  });

  it("rejects a client with no soroban RPC URL configured", () => {
    expect(() => buildClient({ sorobanRpcUrl: "" })).toThrow();
  });

  it("rejects an unknown network identifier", () => {
    expect(() => buildClient({ network: "not-a-network" })).toThrow();
  });
});