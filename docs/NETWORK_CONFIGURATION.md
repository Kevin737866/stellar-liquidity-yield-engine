# Network Configuration Reference

This reference is for operators deploying or running the SDK, UI, and off-chain bots.

## Networks

| Setting | Testnet | Mainnet |
|---|---|---|
| Soroban RPC | `https://soroban-testnet.stellar.org` | `https://soroban.stellar.org` |
| Horizon | `https://horizon-testnet.stellar.org` | `https://horizon.stellar.org` |
| Passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |

Public endpoints are defaults. A private, regional, or managed endpoint may be substituted, but it must serve the selected network passphrase.

## SDK / bot environment

Copy the root `.env.example` to `.env`. The SDK reads canonical `*_CONTRACT_ID` variables:

| Role | Variable |
|---|---|
| Yield engine | `YIELD_ENGINE_CONTRACT_ID` |
| Reward distributor | `REWARD_DISTRIBUTOR_CONTRACT_ID` |
| Rebalance engine | `REBALANCE_ENGINE_CONTRACT_ID` |
| Strategy registry | `STRATEGY_REGISTRY_CONTRACT_ID` |

Endpoint variables:

- `STELLAR_NETWORK=testnet|mainnet` (operator convention; SDK callers select testnet/mainnet explicitly)
- `SOROBAN_RPC_URL` and `HORIZON_URL` for testnet
- `MAINNET_SOROBAN_RPC_URL` and `MAINNET_HORIZON_URL` for mainnet
- `TESTNET_NETWORK_PASSPHRASE` or `MAINNET_NETWORK_PASSPHRASE` for a private network override

For backward compatibility, the SDK also accepts `YIELD_ENGINE_ADDRESS`, `REWARD_DISTRIBUTOR_ADDRESS`, `REBALANCE_ENGINE_ADDRESS`, and `STRATEGY_REGISTRY_ADDRESS`. Canonical `_CONTRACT_ID` variables take precedence. Empty or whitespace-only values are treated as unconfigured.

## UI environment

Copy `ui/.env.example` to `ui/.env.local`. All browser variables must use the `NEXT_PUBLIC_` prefix and are public in the built bundle:

- `NEXT_PUBLIC_STELLAR_NETWORK=testnet|mainnet`
- `NEXT_PUBLIC_TESTNET_SOROBAN_RPC_URL`
- `NEXT_PUBLIC_TESTNET_HORIZON_URL`
- `NEXT_PUBLIC_MAINNET_SOROBAN_RPC_URL`
- `NEXT_PUBLIC_MAINNET_HORIZON_URL`
- `NEXT_PUBLIC_TESTNET_NETWORK_PASSPHRASE`
- `NEXT_PUBLIC_MAINNET_NETWORK_PASSPHRASE`
- `NEXT_PUBLIC_*_CONTRACT_ID` variables from `ui/.env.example`

Next.js inlines these values at build time. Restart and rebuild the UI after changing them. Never put private keys or seed phrases in `NEXT_PUBLIC_*` variables.

## Boundary and failure behavior

- Unset network variables default to testnet for UI and SDK convenience.
- Unset endpoints fall back to the matching public endpoint.
- Unset contract IDs remain empty. SDK/UI diagnostics report missing roles instead of inventing placeholder contracts.
- Whitespace-only values are unconfigured.
- A canonical contract variable overrides its legacy `_ADDRESS` alias.
- Custom endpoints must match the active network. The SDK/UI does not silently switch networks or passphrases.
- Mainnet private keys, identities, and contract deployments must be kept separate from testnet configuration.

## Operator startup checklist

1. Deploy the contracts and record each returned contract ID.
2. Choose testnet or mainnet and use the matching passphrase and endpoint pair.
3. Set canonical contract IDs in `.env` or `ui/.env.local`.
4. Run configuration diagnostics or restart the UI so environment values are rebuilt.
5. Verify one read-only contract call before enabling keeper transactions.
6. Verify a testnet write, then approve and execute a limited mainnet canary transaction.

Keep private signing material outside the UI bundle and only use it in server-side bots or wallet signers.
