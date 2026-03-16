# Stellar Liquidity and Yield Optimization Engine

A comprehensive DeFi yield optimization platform built on Stellar's Soroban smart contracts, featuring auto-compounding vaults, intelligent rebalancing, and advanced risk management tools.

## 🚀 Features

### Core Functionality
- **Auto-compounding Yield Vaults**: Automatically harvest and reinvest rewards for maximum yield
- **Smart Rebalancing Engine**: Move liquidity between pools based on APY and impermanent loss metrics
- **Multi-token Reward Distribution**: Support for XLM, USDC, and native reward tokens
- **Plug-in Strategy System**: Customizable yield farming strategies with risk levels
- **Emergency Controls**: Pause functionality and admin controls for security

### Advanced Features
- **Impermanent Loss Calculation**: Real-time IL tracking and historical analysis
- **Risk Assessment**: Comprehensive risk scoring and scenario analysis
- **Performance Analytics**: Detailed metrics, Sharpe ratios, and drawdown analysis
- **Automated Bots**: Harvest and rebalancing bots with configurable parameters
- **React UI Components**: Modern interface for vault management and monitoring

## 📋 Architecture

```
stellar-liquidity-yield-engine/
├── src/                          # Soroban Contracts (Rust)
│   ├── lib.rs                   # Main contract exports
│   ├── yield_vault.rs           # Auto-compounding vault logic
│   ├── rebalance_engine.rs      # Smart liquidity rebalancing
│   ├── reward_distributor.rs    # Multi-token reward distribution
│   └── strategy_registry.rs     # Strategy management system
├── sdk/src/                     # TypeScript SDK
│   ├── vaultClient.ts           # Vault interaction client
│   ├── rebalancer.ts            # Rebalancing execution client
│   ├── yieldCalculator.ts       # Risk and yield calculations
│   ├── types.ts                 # TypeScript interfaces
│   └── index.ts                 # SDK exports
├── ui/src/components/           # React Components
│   ├── YieldVaultCard.tsx       # Vault display and controls
│   ├── RebalancePanel.tsx       # Rebalancing visualization
│   ├── ImpermanentLossChart.tsx # IL analysis charts
│   ├── StrategySelector.tsx     # Strategy selection interface
│   └── hooks/useYieldVault.ts   # React hooks for vault data
└── examples/                    # Example Scripts
    ├── auto-compound-setup.ts   # Auto-compounding configuration
    ├── cross-pool-rebalance.ts  # Cross-pool rebalancing
    ├── yield-harvest-bot.ts     # Automated harvesting bot
    └── risk-analysis.ts         # Risk analysis tools
```

## 🛠️ Installation

### Prerequisites
- Rust 1.70+ with Soroban CLI
- Node.js 18+
- TypeScript 5+
- Stellar SDK

### Build Contracts
```bash
# Install Rust and Soroban
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
cargo install soroban-cli

# Build contracts
cd src/
cargo build --target wasm32-unknown-unknown --release
```

### Install SDK
```bash
cd sdk/
npm install
npm run build
```

### Setup UI
```bash
cd ui/
npm install
npm run dev
```

## 🔧 Quick Start

### 1. Deploy Contracts

```bash
# Deploy to testnet
soroban contract deploy --wasm target/wasm32-unknown-unknown/release/stellar_liquidity_yield_engine.wasm --source YOUR_KEYPAIR --network testnet

# Initialize contracts
soroban contract invoke \
  --id CONTRACT_ID \
  --source YOUR_KEYPAIR \
  --network testnet \
  --function initialize \
  --arg ADMIN_ADDRESS \
  --arg STRATEGY_REGISTRY_ADDRESS \
  --arg REWARD_DISTRIBUTOR_ADDRESS
```

### 2. Create a Yield Vault

```typescript
import { VaultClient, TESTNET_CONFIG } from 'stellar-liquidity-yield-engine-sdk';

const vaultClient = new VaultClient('VAULT_ADDRESS', TESTNET_CONFIG);

// Initialize vault
await vaultClient.initialize(
  adminKeyPair,
  'USDC-XLM Vault',
  USDC_ADDRESS,
  XLM_ADDRESS,
  POOL_ADDRESS,
  STRATEGY_ID,
  100,  // 1% fee rate
  50,   // 0.5% harvest fee
  100   // 1% withdrawal fee
);
```

### 3. Deposit Liquidity

```typescript
// Deposit tokens
const result = await vaultClient.deposit(userKeyPair, {
  amountA: BigInt(1000000),  // 1 USDC
  amountB: BigInt(5000000),  // 5 XLM
  minShares: BigInt(950000)
});
```

### 4. Enable Auto-compounding

```typescript
// Configure auto-compounding
const autoCompoundManager = new AutoCompoundManager(vaultAddress, TESTNET_CONFIG);

// Start monitoring (every hour)
autoCompoundManager.startMonitoring(userKeyPair, 60);
```

## 📊 Vault Strategies

### Conservative Strategy
- **Risk Level**: Low (1/3)
- **Target APY**: 8-12%
- **Max IL Risk**: 10%
- **Suitable For**: Risk-averse users, stable assets

### Balanced Strategy
- **Risk Level**: Medium (2/3)
- **Target APY**: 12-20%
- **Max IL Risk**: 20%
- **Suitable For**: Balanced risk-return profile

### Aggressive Strategy
- **Risk Level**: High (3/3)
- **Target APY**: 20-35%
- **Max IL Risk**: 30%
- **Suitable For**: High risk tolerance, volatile assets

## 🔄 Rebalancing System

The rebalancing engine automatically optimizes liquidity allocation:

### Features
- **Multi-pool Analysis**: Monitor performance across all vault pools
- **APY Thresholds**: Rebalance when APY gaps exceed thresholds
- **IL Risk Assessment**: Consider impermanent loss in decisions
- **Gas Optimization**: Batch transactions for cost efficiency
- **Slippage Protection**: Maximum slippage tolerance settings

### Configuration
```typescript
const rebalancerClient = new RebalancerClient(TESTNET_CONFIG);

// Create rebalancing strategy
const strategyId = await rebalancerClient.createStrategy(
  adminKeyPair,
  'Dynamic Yield Optimization',
  2, // Balanced risk
  1000, // 10% minimum APY
  1500, // 15% max IL risk
  86400, // Rebalance every 24 hours
  allocations
);
```

## 💰 Reward Distribution

Multi-token reward system supporting:

- **XLM**: Native Stellar token
- **USDC**: Stablecoin rewards
- **Native Tokens**: Project-specific reward tokens
- **Merkle Distribution**: Efficient off-chain calculation
- **Claim Deadlines**: Time-limited reward claims
- **Fee Structure**: Performance and management fees

### Claiming Rewards
```typescript
const rewardClient = new RewardDistributorClient(TESTNET_CONFIG);

// Claim rewards
const claimed = await rewardClient.claimRewards(
  userKeyPair,
  userAddress,
  vaultAddress,
  rewards,
  merkleProof
);
```

## 📈 Risk Management

### Impermanent Loss Analysis
```typescript
import { YieldCalculator } from 'stellar-liquidity-yield-engine-sdk';

// Calculate current IL
const il = YieldCalculator.calculateImpermanentLoss(
  1.0,    // Initial price ratio
  1.5,    // Current price ratio
  30      // Days elapsed
);

console.log(`Current IL: ${il.ilPercent.toFixed(2)}%`);
```

### Risk Metrics
- **Value at Risk (VaR)**: 95% confidence level
- **Conditional VaR (CVaR)**: Expected loss beyond VaR
- **Maximum Drawdown**: Historical peak-to-trough loss
- **Sharpe Ratio**: Risk-adjusted return measure
- **Volatility Analysis**: Asset and portfolio volatility

### Scenario Analysis
```typescript
// Run Monte Carlo simulation
const simulation = YieldCalculator.simulateImpermanentLoss(
  1.0,    // Initial price ratio
  0.25,   // 25% volatility
  30,     // 30 days
  1000    // 1000 simulations
);

console.log(`Average IL: ${simulation.averageIl.toFixed(2)}%`);
console.log(`Worst case IL: ${simulation.worstCaseIl.toFixed(2)}%`);
```

## 🤖 Automated Bots

### Harvest Bot
Automated reward harvesting with intelligent timing:

```typescript
import { YieldHarvestBot } from './examples/yield-harvest-bot';

const bot = new YieldHarvestBot(BOT_CONFIG, BOT_KEYPAIR, TESTNET_CONFIG);

// Start bot
await bot.start();

// Force harvest specific vault
await bot.forceHarvest('VAULT_ADDRESS');
```

### Bot Configuration
- **Check Interval**: Monitoring frequency (15-60 minutes)
- **Reward Thresholds**: Minimum rewards for harvesting
- **Gas Price Limits**: Maximum acceptable gas costs
- **Cooldown Periods**: Minimum time between harvests
- **Performance Tracking**: Detailed harvest statistics

## 🎛️ React Components

### YieldVaultCard
Complete vault interface with deposit/withdraw functionality:

```tsx
import { YieldVaultCard } from '@/components/YieldVaultCard';

<YieldVaultCard
  vaultAddress="VAULT_ADDRESS"
  userAddress="USER_ADDRESS"
  network="testnet"
/>
```

### RebalancePanel
Visual rebalancing interface with strategy management:

```tsx
import { RebalancePanel } from '@/components/RebalancePanel';

<RebalancePanel network="testnet" />
```

### ImpermanentLossChart
Interactive IL analysis and visualization:

```tsx
import { ImpermanentLossChart } from '@/components/ImpermanentLossChart';

<ImpermanentLossChart
  initialPriceRatio={1.0}
  currentPriceRatio={1.5}
  timeElapsed={30}
/>
```

## 🔒 Security Features

### Contract Security
- **Emergency Pause**: Admin can pause all operations
- **Access Control**: Role-based permissions
- **Input Validation**: Comprehensive parameter checks
- **Reentrancy Protection**: Prevent recursive calls
- **Overflow Protection**: Safe arithmetic operations

### Risk Mitigation
- **Slippage Protection**: Maximum acceptable price impact
- **Position Limits**: Maximum exposure per vault
- **Time Locks**: Delays for sensitive operations
- **Multi-signature**: Enhanced admin security
- **Audit Trail**: Complete operation logging

## 📊 Performance Metrics

### Key Performance Indicators
- **APY**: Annual percentage yield after fees
- **TVL**: Total value locked across all vaults
- **Harvest Efficiency**: Rewards harvested per gas spent
- **IL Impact**: Average impermanent loss experienced
- **User Retention**: User engagement and retention rates

### Analytics Dashboard
Real-time monitoring of:
- Vault performance and rankings
- Strategy effectiveness
- Risk metrics and alerts
- Gas usage and optimization
- User activity patterns

## 🌐 Network Support

### Testnet
- **RPC**: `https://soroban-testnet.stellar.org`
- **Horizon**: `https://horizon-testnet.stellar.org`
- **Network Passphrase**: `Test SDF Network ; September 2015`

### Mainnet
- **RPC**: `https://soroban.stellar.org`
- **Horizon**: `https://horizon.stellar.org`
- **Network Passphrase**: `Public Global Stellar Network ; September 2015`

## 🔧 Configuration

### Environment Variables
```bash
# Network configuration
STELLAR_NETWORK=testnet
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
HORIZON_URL=https://horizon-testnet.stellar.org

# Contract addresses
YIELD_ENGINE_ADDRESS=...
REWARD_DISTRIBUTOR_ADDRESS=...
REBALANCE_ENGINE_ADDRESS=...
STRATEGY_REGISTRY_ADDRESS=...

# Bot configuration
BOT_PRIVATE_KEY=...
HARVEST_THRESHOLD=1000
CHECK_INTERVAL=300000
```

### Contract Deployment
```bash
# Deploy all contracts
./scripts/deploy.sh testnet

# Initialize with admin
./scripts/init.sh ADMIN_ADDRESS

# Verify deployment
./scripts/verify.sh
```

## 🧪 Testing

### Unit Tests
```bash
# Run contract tests
cd src/
cargo test

# Run SDK tests
cd sdk/
npm test

# Run component tests
cd ui/
npm test
```

### Integration Tests
```bash
# Run full integration suite
npm run test:integration

# Run performance benchmarks
npm run test:performance
```

## 📚 API Reference

### VaultClient
```typescript
class VaultClient {
  // Core operations
  deposit(keypair: any, params: DepositParams): Promise<TransactionResult>
  withdraw(keypair: any, params: WithdrawParams): Promise<TransactionResult>
  harvest(keypair: any): Promise<TransactionResult>
  
  // Queries
  getVaultInfo(): Promise<VaultInfo>
  getMetrics(): Promise<VaultMetrics>
  getUserPosition(address: Address): Promise<UserPosition>
  getAPY(): Promise<number>
  getTVL(): Promise<bigint>
  
  // Admin functions
  pause(keypair: any): Promise<TransactionResult>
  unpause(keypair: any): Promise<TransactionResult>
}
```

### RebalancerClient
```typescript
class RebalancerClient {
  // Strategy management
  createStrategy(keypair: any, ...params): Promise<number>
  updateStrategy(keypair: any, ...params): Promise<void>
  getStrategies(): Promise<RebalanceStrategy[]>
  
  // Rebalancing
  analyzeRebalanceOpportunities(strategyId: number): Promise<RebalanceProposal[]>
  executeRebalance(keypair: any, proposal: RebalanceProposal): Promise<boolean>
  
  // Analytics
  getHistory(limit: number): Promise<RebalanceHistory[]>
  calculateImpermanentLoss(poolId: Address, ...): Promise<number>
}
```

### YieldCalculator
```typescript
class YieldCalculator {
  // Impermanent loss
  static calculateImpermanentLoss(initialRatio: number, currentRatio: number, timeElapsed: number): ImpermanentLossData
  static simulateImpermanentLoss(initialRatio: number, volatility: number, timePeriod: number, simulations: number): SimulationResult
  
  // Yield calculations
  static projectApy(historicalApy: number[], marketConditions: MarketConditions, timeHorizon: number): ApyProjection
  static estimateFeeRevenue(tvl: bigint, ...): FeeRevenue
  
  // Risk metrics
  static calculateSharpeRatio(returns: number[], riskFreeRate: number): number
  static calculateMaxDrawdown(values: number[]): MaxDrawdownData
}
```

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Workflow
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Submit a pull request

### Code Standards
- Rust: `cargo fmt` and `cargo clippy`
- TypeScript: ESLint and Prettier
- React: Component testing with Jest
- Documentation: Updated README and API docs

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Documentation**: [docs.stellar-yield.com](https://docs.stellar-yield.com)
- **Discord**: [Stellar Yield Community](https://discord.gg/stellar-yield)
- **Issues**: [GitHub Issues](https://github.com/stellar-yield/engine/issues)
- **Email**: support@stellar-yield.com

## 🗺️ Roadmap

### Q1 2024
- [x] Core vault functionality
- [x] Auto-compounding system
- [x] Basic rebalancing engine
- [x] React UI components

### Q2 2024
- [ ] Advanced strategy system
- [ ] Cross-chain support
- [ ] Mobile app
- [ ] Governance features

### Q3 2024
- [ ] DeFi integrations
- [ ] Advanced analytics
- [ ] Insurance products
- [ ] Layer 2 optimization

### Q4 2024
- [ ] AI-powered optimization
- [ ] Social trading
- [ ] Enterprise features
- [ ] Regulatory compliance

## 📊 Performance Benchmarks

### Vault Operations
- **Deposit**: ~50,000 gas
- **Withdraw**: ~60,000 gas
- **Harvest**: ~45,000 gas
- **Rebalance**: ~80,000 gas

### SDK Performance
- **Vault Query**: <100ms
- **Strategy Analysis**: <500ms
- **Risk Calculation**: <200ms
- **Batch Operations**: <1s

### UI Metrics
- **Initial Load**: <2s
- **Transaction Response**: <500ms
- **Chart Rendering**: <300ms
- **Real-time Updates**: <100ms

## 🔍 Audits

### Security Audits
- **Smart Contracts**: [Audit Firm] - [Date]
- **SDK Security**: [Audit Firm] - [Date]
- **UI Security**: [Audit Firm] - [Date]

### Bug Bounty Program
- **Critical**: $10,000 USD
- **High**: $5,000 USD
- **Medium**: $1,000 USD
- **Low**: $500 USD

Submit reports to: security@stellar-yield.com

---

**Built with ❤️ for the Stellar ecosystem**
