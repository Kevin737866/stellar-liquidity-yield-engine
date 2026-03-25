/**
 * Governance Proposal Example
 * 
 * This example demonstrates how to create and execute governance proposals
 * for changing protocol parameters, adding new strategies, and contract upgrades.
 * 
 * Run with: npx ts-node examples/governance-proposal.ts
 */

import { 
  GovernanceSDK, 
  ProposalState, 
  CallData, 
  formatVotingPower,
  GOVERNANCE_CONSTANTS
} from '../sdk/src/governance';
import { Server, Keypair, Networks } from 'stellar-sdk';

// ===== Configuration =====
const CONFIG = {
  network: Networks.TESTNET,
  horizonUrl: 'https://horizon-testnet.stellar.org',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  
  // Contract addresses (update with actual deployed addresses)
  governanceContract: 'GOV_TOKEN_CONTRACT_ADDRESS',
  votingEscrow: 'VE_TOKEN_CONTRACT_ADDRESS',
  stakingContract: 'STAKING_CONTRACT_ADDRESS',
  feeDistributor: 'FEE_DISTRIBUTOR_ADDRESS',
  timelock: 'TIMELOCK_CONTRACT_ADDRESS',
};

// ===== Initialize SDK =====
const server = new Server(CONFIG.horizonUrl);
const userKeypair = Keypair.random(); // In production, use actual keypair

const governanceSDK = new GovernanceSDK(
  server,
  CONFIG.network,
  userKeypair
);

// ===== Proposal Types =====

/**
 * Enum for different proposal types
 */
enum ProposalType {
  PARAMETER_CHANGE = 'parameter_change',
  STRATEGY_APPROVAL = 'strategy_approval',
  CONTRACT_UPGRADE = 'contract_upgrade',
  EMERGENCY = 'emergency',
  TREASURY = 'treasury',
}

// ===== Example Proposals =====

/**
 * Example 1: Change Performance Fee
 * 
 * Demonstrates creating a proposal to change the protocol's performance fee
 * from 10% to 12%.
 */
async function createPerformanceFeeProposal(): Promise<void> {
  console.log('\n=== Creating Performance Fee Proposal ===\n');
  
  const NEW_VALUE = 1200; // 12% in basis points (1200 bps = 12%)

  // Check user's voting power
  const votingPower = await governanceSDK.getVotingPower();
  console.log(`User voting power: ${formatVotingPower(votingPower)} SYGT`);
  
  if (votingPower < GOVERNANCE_CONSTANTS.PROPOSAL_THRESHOLD) {
    console.log(`Insufficient voting power. Minimum required: ${formatVotingPower(GOVERNANCE_CONSTANTS.PROPOSAL_THRESHOLD)}`);
    return;
  }

  // Create call data for the proposal
  const callData: CallData[] = [
    {
      contractAddress: CONFIG.governanceContract,
      functionName: 'set_performance_fee',
      args: [NEW_VALUE],
    }
  ];

  // Create proposal description
  const description = `Change performance fee from 10% to 12%
  
Rationale:
- Increase protocol revenue to support development
- Align with industry standards for DeFi yield protocols
- Maintain competitive rates vs. alternatives

Technical Details:
- New fee: ${NEW_VALUE / 100}% (basis points: ${NEW_VALUE})
- Affects all vault strategies
- No retroactive changes to existing positions`;

  // Create proposal
  const votingDuration = 3 * 24 * 60 * 60; // 3 days

  try {
    const transaction = await governanceSDK.createProposal(
      description,
      callData,
      votingDuration
    );
    
    console.log('Proposal created successfully!');
    console.log('Transaction hash:', transaction.hash().toString('hex'));
    console.log('Please sign and submit the transaction to submit the proposal.');
    
    // In production, submit the transaction
    // await server.submitTransaction(transaction);
  } catch (error) {
    console.error('Error creating proposal:', error);
  }
}

/**
 * Example 2: Change Multiple Parameters
 * 
 * Demonstrates creating a proposal to change multiple protocol parameters
 * in a single proposal.
 */
async function createMultiParameterProposal(): Promise<void> {
  console.log('\n=== Creating Multi-Parameter Proposal ===\n');

  const callData: CallData[] = [
    {
      contractAddress: CONFIG.governanceContract,
      functionName: 'set_performance_fee',
      args: [1200], // 12%
    },
    {
      contractAddress: CONFIG.governanceContract,
      functionName: 'set_withdrawal_fee',
      args: [15], // 0.15%
    },
    {
      contractAddress: CONFIG.governanceContract,
      functionName: 'set_rebalance_threshold',
      args: [300], // 3%
    }
  ];

  const description = `Protocol Parameter Updates

This proposal updates multiple protocol parameters for improved sustainability:

1. Performance Fee: 10% → 12%
   - Increase dev fund allocation
   - Support ongoing protocol development

2. Withdrawal Fee: 0.1% → 0.15%
   - Better protect against mercenary capital
   - Minor increase for vault health

3. Rebalance Threshold: 2% → 3%
   - Reduce unnecessary rebalancing
   - Lower gas costs for users

Impact Assessment:
- Estimated additional annual revenue: +$50K
- User cost impact: <0.1% additional fees
- Net benefit to protocol positive`;

  const votingDuration = 5 * 24 * 60 * 60; // 5 days for multi-param changes

  try {
    const transaction = await governanceSDK.createProposal(
      description,
      callData,
      votingDuration
    );
    
    console.log('Multi-parameter proposal created!');
    console.log('Contains', callData.length, 'parameter changes');
  } catch (error) {
    console.error('Error creating proposal:', error);
  }
}

/**
 * Example 3: Add New Strategy
 * 
 * Demonstrates creating a proposal to add a new yield strategy
 * to the protocol.
 */
async function createStrategyProposal(): Promise<void> {
  console.log('\n=== Creating Strategy Approval Proposal ===\n');

  const newStrategyAddress = 'NEW_STRATEGY_CONTRACT_ADDRESS';

  const callData: CallData[] = [
    {
      contractAddress: 'STRATEGY_REGISTRY_ADDRESS',
      functionName: 'add_strategy',
      args: [newStrategyAddress],
    }
  ];

  const description = `Add new yield strategy: [Strategy Name]

Overview:
- Strategy type: [e.g., Loopring AMM, Marco Polo Lending, etc.]
- Expected APY: X% - Y%
- Risk level: [Low/Medium/High]
- Supported assets: [USDC, XLM, etc.]

Due Diligence:
- Security audit completed by [Audit Firm]
- Audit report: [Link]
- TVL cap recommended: $[Amount]

Risk Assessment:
- Smart contract risk: Low
- Impermanent loss: [N/A or %]
- Counterparty risk: [Description]

Integration Details:
- Contract address: ${newStrategyAddress}
- Required permissions: [List]
- Migration path: [Description]`;

  const votingDuration = 7 * 24 * 60 * 60; // 7 days for strategy additions

  try {
    const transaction = await governanceSDK.createProposal(
      description,
      callData,
      votingDuration
    );
    
    console.log('Strategy approval proposal created!');
  } catch (error) {
    console.error('Error creating proposal:', error);
  }
}

/**
 * Example 4: Emergency Pause Proposal
 * 
 * Demonstrates creating an emergency proposal to pause the protocol
 * in case of detected vulnerability or attack.
 */
async function createEmergencyPauseProposal(): Promise<void> {
  console.log('\n=== Creating Emergency Pause Proposal ===\n');

  const reason = 'Potential vulnerability detected in [component]. ' +
    'Recommend immediate pause pending security review. ' +
    'Audit firm contacted and investigating.';

  const callData: CallData[] = [
    {
      contractAddress: CONFIG.governanceContract,
      functionName: 'emergency_pause',
      args: [
        'REASON_FOR_PAUSE',
        Date.now().toString()
      ],
    }
  ];

  const description = `EMERGENCY: Protocol Pause Request

${reason}

Immediate Actions Required:
1. Pause all vault deposits
2. Pause strategy allocations
3. Initiate emergency multisig review

Timeline:
- Proposal voting: 24 hours (emergency expedited)
- Immediate execution upon success

Security Contact:
- Audit firm: [Name]
- Contact: [Email/Phone]

Post-Pause Plan:
1. Security review by audit team
2. Deploy fix if vulnerability confirmed
3. Resume operations after security sign-off`;

  const votingDuration = 24 * 60 * 60; // 24 hours for emergency

  try {
    const transaction = await governanceSDK.createProposal(
      description,
      callData,
      votingDuration
    );
    
    console.log('EMERGENCY proposal created - EXPEDITED VOTING!');
  } catch (error) {
    console.error('Error creating proposal:', error);
  }
}

/**
 * Example 5: Treasury Diversification
 * 
 * Demonstrates creating a proposal to diversify treasury holdings
 * by selling some SYGT tokens for stablecoins.
 */
async function createTreasuryProposal(): Promise<void> {
  console.log('\n=== Creating Treasury Diversification Proposal ===\n');

  const treasuryAddress = 'TREASURY_MULTISIG_ADDRESS';
  const recipientAddress = 'DIVERSIFIED_WALLET_ADDRESS';
  const tokenAmount = '10000000000'; // 10,000 SYGT (with 7 decimals)

  const callData: CallData[] = [
    {
      contractAddress: CONFIG.governanceContract,
      functionName: 'transfer',
      args: [
        treasuryAddress,
        recipientAddress,
        tokenAmount
      ],
    }
  ];

  const description = `Treasury Diversification: Sell 10,000 SYGT for Stablecoins

Purpose:
- Reduce SYGT concentration in treasury
- Increase stablecoin reserves for operational expenses
- Diversify into risk-averse assets

Details:
- Amount: 10,000 SYGT
- Recipient: ${recipientAddress}
- Sale method: OTC or DEX with minimum slippage

Proceeds Allocation:
- 50% → USDC for operational reserves
- 30% → XLM for gas fund
- 20% → Maintain as SYGT for future investments

Rationale:
- Current treasury: 80% SYGT, 20% stablecoins
- Target: 60% SYGT, 40% stablecoins
- Reduces market volatility exposure

Vote Metrics:
- Quorum: ${GOVERNANCE_CONSTANTS.QUORUM_PERCENTAGE}% required
- Approval margin: 60%+ recommended`;

  const votingDuration = 5 * 24 * 60 * 60;

  try {
    const transaction = await governanceSDK.createProposal(
      description,
      callData,
      votingDuration
    );
    
    console.log('Treasury proposal created!');
  } catch (error) {
    console.error('Error creating proposal:', error);
  }
}

// ===== Voting Functions =====

/**
 * Cast a vote on a proposal
 */
async function voteOnProposal(
  proposalId: number,
  support: boolean,
  amount?: bigint
): Promise<void> {
  console.log(`\n=== Voting on Proposal #${proposalId} ===\n`);
  
  try {
    // Get proposal details
    const proposal = await governanceSDK.getProposal(proposalId);
    console.log('Proposal:', proposal.description.slice(0, 100) + '...');
    console.log('Current state:', proposal.state);
    console.log('Votes for:', formatVotingPower(proposal.votesFor));
    console.log('Votes against:', formatVotingPower(proposal.votesAgainst));

    // Get user's voting power
    const votingPower = await governanceSDK.getVotingPower();
    console.log('Your voting power:', formatVotingPower(votingPower));

    // Use full voting power if not specified
    const voteAmount = amount || votingPower;
    
    if (voteAmount > votingPower) {
      console.log('Requested vote amount exceeds your voting power!');
      return;
    }

    // Cast vote
    const reason = support 
      ? 'I support this proposal as it benefits the protocol.'
      : 'I oppose this proposal due to concerns about [reason].';

    const transaction = await governanceSDK.castVote(
      proposalId,
      support,
      voteAmount,
      reason
    );

    console.log('Vote cast successfully!');
    console.log('Transaction:', transaction.hash().toString('hex'));
    
    // In production, submit the transaction
    // await server.submitTransaction(transaction);
  } catch (error) {
    console.error('Error voting:', error);
  }
}

// ===== Queue and Execute =====

/**
 * Queue a successful proposal for execution
 */
async function queueProposal(proposalId: number): Promise<void> {
  console.log(`\n=== Queuing Proposal #${proposalId} ===\n`);
  
  try {
    const proposal = await governanceSDK.getProposal(proposalId);
    
    if (proposal.state !== ProposalState.Succeeded) {
      console.log('Proposal has not succeeded yet!');
      return;
    }

    const transaction = await governanceSDK.queueProposal(proposalId);
    
    console.log('Proposal queued for execution!');
    console.log('Timelock delay:', GOVERNANCE_CONSTANTS.TIMELOCK_DELAY / 60 / 60, 'hours');
    
    // In production, submit the transaction
    // await server.submitTransaction(transaction);
  } catch (error) {
    console.error('Error queuing proposal:', error);
  }
}

/**
 * Execute a queued proposal after timelock
 */
async function executeProposal(proposalId: number): Promise<void> {
  console.log(`\n=== Executing Proposal #${proposalId} ===\n`);
  
  try {
    const transaction = await governanceSDK.executeProposal(proposalId);
    
    console.log('Proposal executed successfully!');
    console.log('All contract calls have been processed.');
    
    // In production, submit the transaction
    // await server.submitTransaction(transaction);
  } catch (error) {
    console.error('Error executing proposal:', error);
  }
}

// ===== Monitoring Functions =====

/**
 * Monitor active proposals
 */
async function monitorProposals(): Promise<void> {
  console.log('\n=== Monitoring Active Proposals ===\n');
  
  try {
    const activeProposals = await governanceSDK.getActiveProposals();
    
    console.log(`Found ${activeProposals.length} active proposals:\n`);
    
    for (const proposal of activeProposals) {
      console.log(`Proposal #${proposal.id}`);
      console.log(`  State: ${proposal.state}`);
      console.log(`  Description: ${proposal.description.slice(0, 80)}...`);
      console.log(`  Votes For: ${formatVotingPower(proposal.votesFor)}`);
      console.log(`  Votes Against: ${formatVotingPower(proposal.votesAgainst)}`);
      console.log(`  Ends: ${new Date(proposal.endTime * 1000).toLocaleString()}`);
      console.log(`  Quorum Reached: ${proposal.quorumReached}`);
      console.log(`  Passed: ${proposal.passed}`);
      console.log('');
    }
  } catch (error) {
    console.error('Error monitoring proposals:', error);
  }
}

/**
 * Get governance statistics
 */
async function getGovernanceStats(): Promise<void> {
  console.log('\n=== Governance Statistics ===\n');
  
  try {
    const totalSupply = await governanceSDK.getTotalSupply();
    console.log(`Total SYGT Supply: ${formatVotingPower(totalSupply)}`);

    const params = await governanceSDK.getProtocolParameters();
    console.log('\nProtocol Parameters:');
    console.log(`  Performance Fee: ${params.performanceFee / 100}%`);
    console.log(`  Withdrawal Fee: ${params.withdrawalFee / 100}%`);
    console.log(`  Rebalance Threshold: ${params.rebalanceThreshold / 100}%`);
    console.log(`  Insurance Reserve: ${params.insuranceReserveTarget / 100}%`);

    const totalFees = await governanceSDK.getTotalFeesCollected();
    console.log(`\nTotal Fees Collected: ${formatVotingPower(totalFees)}`);
  } catch (error) {
    console.error('Error getting stats:', error);
  }
}

// ===== Main Execution =====

async function main(): Promise<void> {
  console.log('=================================================');
  console.log('  STELLAR YIELD GOVERNANCE PROPOSAL EXAMPLES');
  console.log('=================================================');

  // Uncomment to run specific examples:
  
  // 1. Create a performance fee change proposal
  // await createPerformanceFeeProposal();
  
  // 2. Create a multi-parameter change proposal
  // await createMultiParameterProposal();
  
  // 3. Create a new strategy approval proposal
  // await createStrategyProposal();
  
  // 4. Create an emergency pause proposal
  // await createEmergencyPauseProposal();
  
  // 5. Create a treasury diversification proposal
  // await createTreasuryProposal();
  
  // 6. Vote on a proposal
  // await voteOnProposal(1, true); // Vote for proposal #1
  
  // 7. Queue a successful proposal
  // await queueProposal(1);
  
  // 8. Execute a queued proposal
  // await executeProposal(1);
  
  // 9. Monitor active proposals
  await monitorProposals();
  
  // 10. Get governance statistics
  await getGovernanceStats();
}

// Run if executed directly
main().catch(console.error);

// Export functions for use in other modules
export {
  createPerformanceFeeProposal,
  createMultiParameterProposal,
  createStrategyProposal,
  createEmergencyPauseProposal,
  createTreasuryProposal,
  voteOnProposal,
  queueProposal,
  executeProposal,
  monitorProposals,
  getGovernanceStats,
};
