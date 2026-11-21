# Dashboard environment variables

The Next.js dashboard reads public configuration from `ui/.env.example`.
Run commands from `ui/` or use the paths below; a local setup is:

```bash
cd ui
cp .env.example .env.local
npm install
npm run dev
```

## Precedence

The effective value is selected in this order, from highest to lowest:

1. An existing shell or deployment-platform environment variable
2. `ui/.env.local`
3. `ui/.env.development.local` or `ui/.env.production.local`
4. `ui/.env.development` or `ui/.env.production`
5. `ui/.env`
6. The dashboard built-in fallback

Next.js environment loading rules determine which file is loaded for each
mode. Explicit component props, where a component supports one, override the
dashboard environment for that component. A shell or platform value wins over
a file value with the same name.

## Variable reference

| Variable | Required | Default or boundary behavior |
|---|---:|---|
| `NEXT_PUBLIC_STELLAR_NETWORK` | No | `testnet`; only `mainnet` selects mainnet |
| `NEXT_PUBLIC_TESTNET_HORIZON_URL` | No | `https://horizon-testnet.stellar.org` |
| `NEXT_PUBLIC_TESTNET_SOROBAN_RPC_URL` | No | `https://soroban-testnet.stellar.org` |
| `NEXT_PUBLIC_MAINNET_HORIZON_URL` | No | `https://horizon.stellar.org` |
| `NEXT_PUBLIC_MAINNET_SOROBAN_RPC_URL` | No | `https://soroban.stellar.org` |
| `NEXT_PUBLIC_TESTNET_NETWORK_PASSPHRASE` | No | `Test SDF Network ; September 2015` |
| `NEXT_PUBLIC_MAINNET_NETWORK_PASSPHRASE` | No | `Public Global Stellar Network ; September 2015` |
| `NEXT_PUBLIC_YIELD_ENGINE_CONTRACT_ID` | For yield operations | Empty/unconfigured |
| `NEXT_PUBLIC_REWARD_DISTRIBUTOR_CONTRACT_ID` | For reward operations | Empty/unconfigured |
| `NEXT_PUBLIC_REBALANCE_ENGINE_CONTRACT_ID` | For rebalancing operations | Empty/unconfigured |
| `NEXT_PUBLIC_STRATEGY_REGISTRY_CONTRACT_ID` | For strategy operations | Empty/unconfigured |
| `NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID` | For governance operations | Empty/unconfigured |
| `NEXT_PUBLIC_VOTING_ESCROW_CONTRACT_ID` | For voting escrow operations | Empty/unconfigured |
| `NEXT_PUBLIC_STAKING_CONTRACT_ID` | For staking operations | Empty/unconfigured |
| `NEXT_PUBLIC_FEE_DISTRIBUTOR_CONTRACT_ID` | For fee distribution operations | Empty/unconfigured |

All values are strings. Blank or whitespace-only values are treated as unset.
Unknown network values are treated as `testnet`, including a misspelled
`mainnet`. Endpoint overrides apply only to their matching network. Contract
IDs do not fall back to public placeholders.

## Build and runtime behavior

`NEXT_PUBLIC_*` values are public and are inlined into the browser bundle at
build time. They cannot be used for secrets. Never add `BOT_PRIVATE_KEY`, a
seed phrase, an API secret, or an admin key to this configuration. UI
transactions are intended to be signed through Freighter.

Rebuild or redeploy after changing a dashboard variable. Restarting
`next dev` is required to reload a changed environment file. Changing a browser
value without a rebuild does not change an already deployed bundle.

## Failure behavior

- Missing contract IDs remain empty and are reported together as unconfigured
  roles rather than replaced with placeholder addresses.
- Deployment-platform variables can be overridden by neither local files nor
  built-in defaults, as long as they exist in the build environment.
- A network-specific override is ignored when it belongs to a network other
  than the active one.
- Private/server-only variables are not available to dashboard browser code.

For deployed contract IDs, use the output from
`soroban contract deploy` and set the matching `NEXT_PUBLIC_*_CONTRACT_ID`
value before building the dashboard.
