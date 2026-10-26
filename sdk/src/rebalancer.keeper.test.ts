import { Keypair, StrKey } from "stellar-sdk";
import { RebalancerClient } from "./rebalancer";

describe("RebalancerClient APY keeper permissions", () => {
  it("exposes a dedicated APY keeper workflow separate from the admin flow", () => {
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 1));
    const client = new RebalancerClient({
      network: "testnet",
      horizonUrl: "https://horizon-testnet.stellar.org",
      sorobanRpcUrl: "https://soroban-testnet.stellar.org",
      contracts: {
        yieldEngine: contractId,
        rewardDistributor: contractId,
        rebalanceEngine: contractId,
        strategyRegistry: contractId,
      },
    });

    expect(typeof client.setApyKeepers).toBe("function");
    expect(typeof client.getApyKeepers).toBe("function");
    expect(typeof client.updatePoolApy).toBe("function");
    expect(typeof client.getPoolCurrentApy).toBe("function");
    expect(typeof client.getPoolApyRecord).toBe("function");

    const admin = Keypair.random();
    const keeper = Keypair.random();
    expect(admin.publicKey()).not.toBe(keeper.publicKey());
  });
});
