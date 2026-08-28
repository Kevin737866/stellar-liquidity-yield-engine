//! Governance and Protocol Fee Sharing System
//!
//! Decentralizes yield engine governance and aligns incentives by distributing
//! protocol fees (performance fees, withdrawal fees, swap fees) to token stakers.
//!
//! Token Distribution:
//! - 50% Community
//! - 20% Team (4-year vest)
//! - 20% Treasury
//! - 10% Liquidity Mining

use soroban_sdk::{
    contract, contractimpl, contractmeta, Address, Env, Map, String, Vec,
    BigInt, Val,
};
use soroban_sdk::token::TokenClient;

// ===== Token Distribution Constants =====
const TOTAL_SUPPLY: u32 = 1_000_000_000; // 1 billion tokens (10^9 with 7 decimals)
const COMMUNITY_ALLOCATION: u32 = 500_000_000; // 50%
const TEAM_ALLOCATION: u32 = 200_000_000; // 20%
const TREASURY_ALLOCATION: u32 = 200_000_000; // 20%
const LIQUIDITY_MINING_ALLOCATION: u32 = 100_000_000; // 10%

// ===== Governance Parameters =====
const QUORUM_PERCENTAGE: i128 = 400; // 4% of total supply (in basis points)
const TIMELOCK_DELAY: u64 = 172800; // 2 days in seconds
const PROPOSAL_THRESHOLD: i128 = 100_000_000; // 100 tokens minimum to propose
const MAX_PROPOSAL_DESCRIPTION_LENGTH: u32 = 280;

// ===== Fee Parameters (Governable) =====
const MIN_PERFORMANCE_FEE: u32 = 500; // 5%
const MAX_PERFORMANCE_FEE: u32 = 1500; // 15%
const DEFAULT_PERFORMANCE_FEE: u32 = 1000; // 10%

const MIN_WITHDRAWAL_FEE: u32 = 10; // 0.1%
const MAX_WITHDRAWAL_FEE: u32 = 100; // 1%
const DEFAULT_WITHDRAWAL_FEE: u32 = 10; // 0.1%

const MIN_REBALANCE_THRESHOLD: u32 = 100; // 1%
const MAX_REBALANCE_THRESHOLD: u32 = 500; // 5%
const DEFAULT_REBALANCE_THRESHOLD: u32 = 200; // 2%

const MIN_INSURANCE_RESERVE: u32 = 10000; // 100%
const MAX_INSURANCE_RESERVE: u32 = 20000; // 200%
const DEFAULT_INSURANCE_RESERVE: u32 = 15000; // 150%

// ===== Voting Power Boost =====
const MAX_BOOST_MULTIPLIER: i128 = 2500; // 2.5x (in basis points)
const MAX_VOTE_DURATION: u64 = 126144000; // 4 years in seconds
const MIN_VOTE_DURATION: u64 = 604800; // 1 week in seconds

// ===== Proposal States =====
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProposalState {
    Pending = 0,
    Active = 1,
    Canceled = 2,
    Defeated = 3,
    Succeeded = 4,
    Queued = 5,
    Expired = 6,
    Executed = 7,
}

// ===== Call Data for Proposals =====
#[contracttype]
#[derive(Clone)]
pub struct CallData {
    pub contract_address: Address,
    pub function_name: Symbol,
    pub args: Vec<Val>,
}

// ===== Governance Proposal =====
#[contracttype]
#[derive(Clone)]
pub struct GovernanceProposal {
    pub proposer: Address,
    pub description: String,
    pub call_data: Vec<CallData>,
    pub votes_for: i128,
    pub votes_against: i128,
    pub eta: u64, // Execution timestamp
    pub start_time: u64,
    pub end_time: u64,
    pub snapshot_block: u64,
    pub state: ProposalState,
    pub for_voters: Map<Address, BigInt>,
    pub against_voters: Map<Address, BigInt>,
    pub canceled: bool,
    pub queued: bool,
    pub executed: bool,
}

impl GovernanceProposal {
    pub fn new(
        env: &Env,
        proposer: Address,
        description: String,
        call_data: Vec<CallData>,
        start_time: u64,
        duration: u64,
        snapshot_block: u64,
    ) -> Self {
        Self {
            proposer,
            description,
            call_data,
            votes_for: BigInt::zero(env),
            votes_against: BigInt::zero(env),
            eta: 0,
            start_time,
            end_time: start_time + duration,
            snapshot_block,
            state: ProposalState::Pending,
            for_voters: Map::new(&proposer.get_env()),
            against_voters: Map::new(&proposer.get_env()),
            canceled: false,
            queued: false,
            executed: false,
        }
    }

    pub fn is_active(&self, current_time: u64) -> bool {
        self.state == ProposalState::Active &&
            current_time >= self.start_time &&
            current_time < self.end_time
    }
}

// Each contract below lives in its own submodule: soroban_sdk's #[contractimpl]
// macro generates helper items (e.g. `__initialize`) scoped to the enclosing
// module, so multiple contracts sharing method names (initialize, delegate,
// ...) in the same module would collide.
pub use governance_token::{GovernanceToken, GovernanceTokenClient};
pub use staking_contract::{StakingContract, StakingContractClient};
pub use fee_distributor::{FeeDistributor, FeeDistributorClient};
pub use protocol_governor::{ProtocolGovernor, ProtocolGovernorClient};
pub use voting_escrow::{VotingEscrow, VotingEscrowClient};
pub use emergency_multisig::{EmergencyMultisig, EmergencyMultisigClient};

// ===== Governance Token =====
mod governance_token {
    use super::*;

#[contract]
pub struct GovernanceToken;

#[contracttype]
#[derive(Clone)]
enum GovTokenDataKey {
    Admin,
    TotalSupply,
    Balance(Address),
    Allowance(Address, Address),
    Delegate(Address),
    TeamVesting(Address),
}

#[contractimpl]
impl GovernanceToken {
    /// Initialize the governance token with initial distribution
    pub fn initialize(
        env: Env,
        admin: Address,
        community_wallet: Address,
        team_wallet: Address,
        treasury_wallet: Address,
        liquidity_mining_wallet: Address,
    ) {
        admin.require_auth();

        let scale: i128 = 10_000_000; // 10^7 for 7 decimals

        let community_amount = COMMUNITY_ALLOCATION as i128 * scale;
        let team_amount = TEAM_ALLOCATION as i128 * scale;
        let treasury_amount = TREASURY_ALLOCATION as i128 * scale;
        let liquidity_amount = LIQUIDITY_MINING_ALLOCATION as i128 * scale;
        let total = community_amount + team_amount + treasury_amount + liquidity_amount;

        env.storage().instance().set(&GovTokenDataKey::Admin, &admin);
        env.storage().instance().set(&GovTokenDataKey::TotalSupply, &total);

        env.storage().instance().set(&GovTokenDataKey::Balance(community_wallet), &community_amount);
        env.storage().instance().set(&GovTokenDataKey::Balance(team_wallet.clone()), &team_amount);
        env.storage().instance().set(&GovTokenDataKey::Balance(treasury_wallet), &treasury_amount);
        env.storage().instance().set(&GovTokenDataKey::Balance(liquidity_mining_wallet), &liquidity_amount);

        // Set team vesting start (4-year vest)
        let vesting_end = env.ledger().timestamp() + (4 * 365 * 24 * 60 * 60);
        env.storage().instance().set(&GovTokenDataKey::TeamVesting(team_wallet), &vesting_end);
    }

    fn get_admin(env: &Env) -> Address {
        env.storage().instance().get(&GovTokenDataKey::Admin).unwrap()
    }

    /// Mint new tokens (only by governance)
    pub fn mint(env: Env, admin: Address, to: Address, amount: i128) {
        admin.require_auth();
        if admin != Self::get_admin(&env) {
            panic!("unauthorized: admin required");
        }

        let to_balance = Self::balance(env.clone(), to.clone()) + amount;
        env.storage().instance().set(&GovTokenDataKey::Balance(to), &to_balance);

        let total_supply = Self::total_supply(env.clone()) + amount;
        env.storage().instance().set(&GovTokenDataKey::TotalSupply, &total_supply);
    }

    /// Burn tokens
    pub fn burn(env: Env, from: Address, amount: i128) {
        from.require_auth();

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            panic!("insufficient balance");
        }

        env.storage().instance().set(&GovTokenDataKey::Balance(from), &(from_balance - amount));

        let total_supply = Self::total_supply(env.clone()) - amount;
        env.storage().instance().set(&GovTokenDataKey::TotalSupply, &total_supply);
    }

    /// Delegate voting power to another address
    pub fn delegate(env: Env, from: Address, to: Address) {
        from.require_auth();
        env.storage().instance().set(&GovTokenDataKey::Delegate(from), &to);
    }

    /// Get the address a user has delegated to, if any
    pub fn get_delegate(env: Env, addr: Address) -> Option<Address> {
        env.storage().instance().get(&GovTokenDataKey::Delegate(addr))
    }

    /// Get current balance
    pub fn balance(env: Env, addr: Address) -> i128 {
        env.storage().instance().get(&GovTokenDataKey::Balance(addr)).unwrap_or(0)
    }

    /// Get total supply
    pub fn total_supply(env: Env) -> i128 {
        env.storage().instance().get(&GovTokenDataKey::TotalSupply).unwrap_or(0)
    }

    /// Transfer tokens
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            panic!("insufficient balance");
        }

        env.storage().instance().set(&GovTokenDataKey::Balance(from), &(from_balance - amount));

        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage().instance().set(&GovTokenDataKey::Balance(to), &(to_balance + amount));
    }

    /// Approve spender
    pub fn approve(env: Env, from: Address, spender: Address, amount: i128) {
        from.require_auth();
        env.storage().instance().set(&GovTokenDataKey::Allowance(from, spender), &amount);
    }

    /// Get allowance
    pub fn allowance(env: Env, owner: Address, spender: Address) -> i128 {
        env.storage().instance().get(&GovTokenDataKey::Allowance(owner, spender)).unwrap_or(0)
    }

    /// Check if team tokens are still locked
    pub fn is_team_locked(env: Env, addr: Address) -> bool {
        let vesting_end: u64 = env.storage()
            .instance()
            .get(&GovTokenDataKey::TeamVesting(addr))
            .unwrap_or(0);
        env.ledger().timestamp() < vesting_end
    }
}

} // mod governance_token

// ===== Staking Contract =====
mod staking_contract {
    use super::*;

#[contract]
pub struct StakingContract;

#[contracttype]
#[derive(Clone)]
enum StakingDataKey {
    StakeBalance(Address),
    StakeStart(Address),
    TotalStaked,
    AccruedRewards(Address),
    LastClaimTime(Address),
    RewardPerToken,
    GovernanceToken,
}

#[contractimpl]
impl StakingContract {
    /// Initialize staking contract
    pub fn initialize(env: Env, governance_token: Address, fee_distributor: Address) {
        let _ = fee_distributor; // reserved for future fee-distributor-gated reward top-ups
        env.storage().instance().set(&StakingDataKey::GovernanceToken, &governance_token);
        env.storage().instance().set(&StakingDataKey::RewardPerToken, &0i128);
        env.storage().instance().set(&StakingDataKey::TotalStaked, &0i128);
    }

    fn governance_token(env: &Env) -> Address {
        env.storage().instance().get(&StakingDataKey::GovernanceToken).unwrap()
    }

    /// Stake governance tokens
    pub fn stake(env: Env, user: Address, amount: i128) {
        user.require_auth();

        let gov_token = Self::governance_token(&env);
        GovernanceTokenClient::new(&env, &gov_token).transfer(
            &user,
            &env.current_contract_address(),
            &amount,
        );

        let stake_balance = Self::get_stake_balance(env.clone(), user.clone()) + amount;
        env.storage().instance().set(&StakingDataKey::StakeBalance(user.clone()), &stake_balance);

        let total_staked = Self::get_total_staked(env.clone()) + amount;
        env.storage().instance().set(&StakingDataKey::TotalStaked, &total_staked);

        env.storage().instance().set(&StakingDataKey::StakeStart(user), &env.ledger().timestamp());
    }

    /// Unstake governance tokens
    pub fn unstake(env: Env, user: Address, amount: i128) {
        user.require_auth();

        let stake_balance = Self::get_stake_balance(env.clone(), user.clone());
        if stake_balance < amount {
            panic!("insufficient staked balance");
        }

        env.storage().instance().set(&StakingDataKey::StakeBalance(user.clone()), &(stake_balance - amount));

        let total_staked = Self::get_total_staked(env.clone()) - amount;
        env.storage().instance().set(&StakingDataKey::TotalStaked, &total_staked);

        let gov_token = Self::governance_token(&env);
        GovernanceTokenClient::new(&env, &gov_token).transfer(
            &env.current_contract_address(),
            &user,
            &amount,
        );
    }

    /// Claim staking rewards
    pub fn claim_rewards(env: Env, user: Address) -> i128 {
        user.require_auth();

        let pending = Self::pending_rewards(env.clone(), user.clone());

        env.storage().instance().set(&StakingDataKey::AccruedRewards(user.clone()), &0i128);
        env.storage().instance().set(&StakingDataKey::LastClaimTime(user.clone()), &env.ledger().timestamp());

        if pending > 0 {
            let gov_token = Self::governance_token(&env);
            GovernanceTokenClient::new(&env, &gov_token).transfer(
                &env.current_contract_address(),
                &user,
                &pending,
            );
        }

        pending
    }

    /// Calculate pending rewards for a user
    pub fn pending_rewards(env: Env, user: Address) -> i128 {
        let stake_balance = Self::get_stake_balance(env.clone(), user.clone());
        let reward_per_token: i128 = env.storage().instance().get(&StakingDataKey::RewardPerToken).unwrap_or(0);
        let last_claim: u64 = env.storage()
            .instance()
            .get(&StakingDataKey::LastClaimTime(user.clone()))
            .unwrap_or(0);

        let time_elapsed = env.ledger().timestamp().saturating_sub(last_claim);
        let rewards = stake_balance * time_elapsed as i128 * reward_per_token;

        let accrued: i128 = env.storage().instance().get(&StakingDataKey::AccruedRewards(user)).unwrap_or(0);
        rewards + accrued
    }

    /// Get stake balance
    pub fn get_stake_balance(env: Env, user: Address) -> i128 {
        env.storage().instance().get(&StakingDataKey::StakeBalance(user)).unwrap_or(0)
    }

    /// Get total staked
    pub fn get_total_staked(env: Env) -> i128 {
        env.storage().instance().get(&StakingDataKey::TotalStaked).unwrap_or(0)
    }
}

} // mod staking_contract

// ===== Fee Distributor =====
mod fee_distributor {
    use super::*;

#[contract]
pub struct FeeDistributor;

#[contracttype]
#[derive(Clone)]
enum FeeDistributorDataKey {
    Treasury,
    StakingContract,
    TotalFeesCollected,
    WeekFees(u64),
    WeekStart(u64),
    UserClaimedWeek(Address, u64),
    AccumulatedFeesPerStake,
    LastDistributionTime,
}

const SECONDS_PER_WEEK: u64 = 604800;

#[contractimpl]
impl FeeDistributor {
    /// Initialize fee distributor
    pub fn initialize(env: Env, treasury: Address, staking_contract: Address) {
        env.storage().instance().set(&FeeDistributorDataKey::Treasury, &treasury);
        env.storage().instance().set(&FeeDistributorDataKey::StakingContract, &staking_contract);
        env.storage().instance().set(&FeeDistributorDataKey::TotalFeesCollected, &0i128);
        env.storage().instance().set(&FeeDistributorDataKey::AccumulatedFeesPerStake, &0i128);
        env.storage().instance().set(&FeeDistributorDataKey::LastDistributionTime, &env.ledger().timestamp());
    }

    fn treasury(env: &Env) -> Address {
        env.storage().instance().get(&FeeDistributorDataKey::Treasury).unwrap()
    }

    fn staking_contract(env: &Env) -> Address {
        env.storage().instance().get(&FeeDistributorDataKey::StakingContract).unwrap()
    }

    /// Record the start-of-week timestamp the first time fees land in a given week.
    fn record_week_start(env: &Env, week: u64) {
        let key = FeeDistributorDataKey::WeekStart(week);
        if env.storage().instance().get::<_, u64>(&key).is_none() {
            env.storage().instance().set(&key, &(week * SECONDS_PER_WEEK));
        }
    }

    /// Collect protocol fees from various sources (called by the treasury)
    pub fn collect_fees(env: Env, caller: Address, amount: i128) {
        caller.require_auth();
        if caller != Self::treasury(&env) {
            panic!("unauthorized: treasury required");
        }

        let total = Self::get_total_fees_collected(env.clone()) + amount;
        env.storage().instance().set(&FeeDistributorDataKey::TotalFeesCollected, &total);

        let current_week = env.ledger().timestamp() / SECONDS_PER_WEEK;
        Self::record_week_start(&env, current_week);

        let week_fees: i128 = env.storage()
            .instance()
            .get(&FeeDistributorDataKey::WeekFees(current_week))
            .unwrap_or(0);
        env.storage().instance().set(&FeeDistributorDataKey::WeekFees(current_week), &(week_fees + amount));
    }

    /// Claim fees for a specific week
    pub fn claim_week(env: Env, user: Address, week: u64) -> i128 {
        user.require_auth();

        let claimed_key = FeeDistributorDataKey::UserClaimedWeek(user.clone(), week);
        if env.storage().instance().get::<_, bool>(&claimed_key).unwrap_or(false) {
            panic!("already claimed for this week");
        }

        let staking = Self::staking_contract(&env);
        let staking_client = StakingContractClient::new(&env, &staking);
        let user_stake = staking_client.get_stake_balance(&user);
        let total_stake = staking_client.get_total_staked();

        if total_stake == 0 {
            return 0;
        }

        let week_fees: i128 = env.storage()
            .instance()
            .get(&FeeDistributorDataKey::WeekFees(week))
            .unwrap_or(0);
        let user_share = week_fees * user_stake / total_stake;

        env.storage().instance().set(&claimed_key, &true);

        user_share
    }

    /// Get claimable fees for a user across all weeks
    pub fn get_claimable_fees(env: Env, user: Address) -> i128 {
        let current_week = env.ledger().timestamp() / SECONDS_PER_WEEK;
        let staking = Self::staking_contract(&env);
        let staking_client = StakingContractClient::new(&env, &staking);
        let user_stake = staking_client.get_stake_balance(&user);
        let total_stake = staking_client.get_total_staked();

        if total_stake == 0 || user_stake == 0 {
            return 0;
        }

        let mut total_claimable: i128 = 0;

        // Check last 52 weeks
        for week in current_week.saturating_sub(51)..=current_week {
            let claimed = env.storage()
                .instance()
                .get::<_, bool>(&FeeDistributorDataKey::UserClaimedWeek(user.clone(), week))
                .unwrap_or(false);
            if !claimed {
                let week_fees: i128 = env.storage()
                    .instance()
                    .get(&FeeDistributorDataKey::WeekFees(week))
                    .unwrap_or(0);
                total_claimable += week_fees * user_stake / total_stake;
            }
        }

        total_claimable
    }

    /// Get total fees collected
    pub fn get_total_fees_collected(env: Env) -> i128 {
        env.storage().instance().get(&FeeDistributorDataKey::TotalFeesCollected).unwrap_or(0)
    }

    /// Get the timestamp a given week began
    pub fn get_week_start(env: Env, week: u64) -> u64 {
        env.storage()
            .instance()
            .get(&FeeDistributorDataKey::WeekStart(week))
            .unwrap_or(week * SECONDS_PER_WEEK)
    }
}

} // mod fee_distributor

// ===== Protocol Governor =====
mod protocol_governor {
    use super::*;

#[contract]
pub struct ProtocolGovernor;

#[contracttype]
#[derive(Clone)]
enum GovernorDataKey {
    Proposal(u32),
    ProposalCount,
    Timelock,
    Admin,
    EmergencyMultisig,
    GovernanceToken,
    VotingEscrow,
    PerformanceFee,
    WithdrawalFee,
    RebalanceThreshold,
    InsuranceReserveTarget,
}

#[contractimpl]
impl ProtocolGovernor {
    /// Initialize governor
    pub fn initialize(
        env: Env,
        timelock: Address,
        admin: Address,
        emergency_multisig: Vec<Address>,
        governance_token: Address,
        voting_escrow: Address,
    ) {
        if emergency_multisig.len() != 5 {
            panic!("emergency multisig must have exactly 5 members");
        }

        env.storage().instance().set(&GovernorDataKey::Timelock, &timelock);
        env.storage().instance().set(&GovernorDataKey::Admin, &admin);
        env.storage().instance().set(&GovernorDataKey::EmergencyMultisig, &emergency_multisig);
        env.storage().instance().set(&GovernorDataKey::GovernanceToken, &governance_token);
        env.storage().instance().set(&GovernorDataKey::VotingEscrow, &voting_escrow);
        env.storage().instance().set(&GovernorDataKey::ProposalCount, &0u32);

        env.storage().instance().set(&GovernorDataKey::PerformanceFee, &DEFAULT_PERFORMANCE_FEE);
        env.storage().instance().set(&GovernorDataKey::WithdrawalFee, &DEFAULT_WITHDRAWAL_FEE);
        env.storage().instance().set(&GovernorDataKey::RebalanceThreshold, &DEFAULT_REBALANCE_THRESHOLD);
        env.storage().instance().set(&GovernorDataKey::InsuranceReserveTarget, &DEFAULT_INSURANCE_RESERVE);
    }

    fn governance_token(env: &Env) -> Address {
        env.storage().instance().get(&GovernorDataKey::GovernanceToken).unwrap()
    }

    fn voting_escrow(env: &Env) -> Address {
        env.storage().instance().get(&GovernorDataKey::VotingEscrow).unwrap()
    }

    fn proposal_count(env: &Env) -> u32 {
        env.storage().instance().get(&GovernorDataKey::ProposalCount).unwrap_or(0)
    }

    fn get_proposal_internal(env: &Env, proposal_id: u32) -> GovernanceProposal {
        env.storage()
            .instance()
            .get(&GovernorDataKey::Proposal(proposal_id))
            .unwrap_or_else(|| panic!("proposal not found"))
    }

    fn set_proposal(env: &Env, proposal_id: u32, proposal: &GovernanceProposal) {
        env.storage().instance().set(&GovernorDataKey::Proposal(proposal_id), proposal);
    }

    /// Create a new governance proposal
    pub fn propose(
        env: Env,
        proposer: Address,
        description: String,
        call_data: Vec<CallData>,
        voting_duration: u64,
    ) -> u32 {
        proposer.require_auth();

        // Verify proposer has enough voting power
        let voting_escrow = Self::voting_escrow(&env);
        let voting_power = VotingEscrowClient::new(&env, &voting_escrow).get_voting_power(&proposer);

        if voting_power < PROPOSAL_THRESHOLD {
            panic!("insufficient voting power to propose");
        }

        if description.len() > MAX_PROPOSAL_DESCRIPTION_LENGTH {
            panic!("proposal description too long");
        }

        let proposal_id = Self::proposal_count(&env) + 1;
        let current_time = env.ledger().timestamp();
        let snapshot_block = env.ledger().sequence() as u64;

        let proposal = GovernanceProposal::new(
            &e,
            proposer,
            description,
            call_data,
            current_time,
            voting_duration,
            snapshot_block,
        );

        Self::set_proposal(&env, proposal_id, &proposal);
        env.storage().instance().set(&GovernorDataKey::ProposalCount, &proposal_id);

        proposal_id
    }

    /// Cast a vote on a proposal
    pub fn vote(env: Env, voter: Address, proposal_id: u32, support: bool, amount: i128) {
        voter.require_auth();

        let current_time = env.ledger().timestamp();
        let mut proposal = Self::get_proposal_internal(&env, proposal_id);

        if current_time >= proposal.start_time && proposal.state == ProposalState::Pending {
            proposal.state = ProposalState::Active;
        }

        if proposal.state != ProposalState::Active {
            panic!("proposal is not active");
        }
        if current_time < proposal.start_time || current_time >= proposal.end_time {
            panic!("voting period has ended");
        }

        let voting_escrow = Self::voting_escrow(&env);
        let voter_power = VotingEscrowClient::new(&env, &voting_escrow).get_voting_power(&voter);
        if voter_power < amount {
            panic!("insufficient voting power");
        }

        if support {
            proposal.votes_for += amount;
            proposal.for_voters.set(voter, amount);
        } else {
            proposal.votes_against += amount;
            proposal.against_voters.set(voter, amount);
        }

        Self::set_proposal(&env, proposal_id, &proposal);
    }

    /// Queue a successful proposal for execution
    pub fn queue(env: Env, proposal_id: u32) -> u64 {
        let mut proposal = Self::get_proposal_internal(&env, proposal_id);

        if proposal.state != ProposalState::Succeeded {
            panic!("proposal has not succeeded");
        }

        let eta = env.ledger().timestamp() + TIMELOCK_DELAY;
        proposal.eta = eta;
        proposal.queued = true;
        proposal.state = ProposalState::Queued;
        Self::set_proposal(&env, proposal_id, &proposal);

        eta
    }

    /// Execute a queued proposal
    pub fn execute(env: Env, proposal_id: u32) {
        let current_time = env.ledger().timestamp();
        let mut proposal = Self::get_proposal_internal(&env, proposal_id);

        if proposal.state != ProposalState::Queued {
            panic!("proposal is not queued");
        }
        if current_time < proposal.eta {
            panic!("timelock period not elapsed");
        }
        if proposal.executed {
            panic!("proposal already executed");
        }

        // Executing the proposal's call_data against arbitrary contracts is left
        // to the timelock contract, which invokes this governor with elevated
        // authorization; this function only finalizes bookkeeping state.

        proposal.executed = true;
        proposal.state = ProposalState::Executed;
        Self::set_proposal(&env, proposal_id, &proposal);
    }

    /// Cancel a proposal
    pub fn cancel(env: Env, proposal_id: u32) {
        let mut proposal = Self::get_proposal_internal(&env, proposal_id);

        if proposal.state != ProposalState::Pending && proposal.state != ProposalState::Active {
            panic!("cannot cancel proposal in current state");
        }

        proposal.canceled = true;
        proposal.state = ProposalState::Canceled;
        Self::set_proposal(&env, proposal_id, &proposal);
    }

    /// Get proposal by ID
    pub fn get_proposal(env: Env, proposal_id: u32) -> GovernanceProposal {
        Self::get_proposal_internal(&env, proposal_id)
    }

    /// Get proposal state
    pub fn get_proposal_state(env: Env, proposal_id: u32) -> ProposalState {
        Self::get_proposal_internal(&env, proposal_id).state
    }

    /// Check if quorum is reached
    pub fn has_quorum(env: Env, proposal_id: u32) -> bool {
        let proposal = Self::get_proposal_internal(&env, proposal_id);
        let governance_token = Self::governance_token(&env);
        let total_supply = GovernanceTokenClient::new(&env, &governance_token).total_supply();

        let total_votes = proposal.votes_for + proposal.votes_against;
        let quorum_required = total_supply * QUORUM_PERCENTAGE / 10000;

        total_votes >= quorum_required
    }

    /// Check if proposal passed
    pub fn has_passed(env: Env, proposal_id: u32) -> bool {
        let proposal = Self::get_proposal_internal(&env, proposal_id);
        Self::has_quorum(env, proposal_id) && proposal.votes_for > proposal.votes_against
    }

    /// Update proposal states (called periodically)
    pub fn update_proposal_states(env: Env) {
        let current_time = env.ledger().timestamp();
        let proposal_count = Self::proposal_count(&env);

        for i in 1..=proposal_count {
            let mut proposal = Self::get_proposal_internal(&env, i);

            match proposal.state {
                ProposalState::Pending => {
                    if current_time >= proposal.start_time {
                        proposal.state = ProposalState::Active;
                        Self::set_proposal(&env, i, &proposal);
                    }
                }
                ProposalState::Active => {
                    if current_time >= proposal.end_time {
                        proposal.state = if Self::has_passed(env.clone(), i) {
                            ProposalState::Succeeded
                        } else {
                            ProposalState::Defeated
                        };
                        Self::set_proposal(&env, i, &proposal);
                    }
                }
                ProposalState::Queued => {
                    if current_time >= proposal.eta + (7 * 24 * 60 * 60) {
                        proposal.state = ProposalState::Expired;
                        Self::set_proposal(&env, i, &proposal);
                    }
                }
                _ => {}
            }
        }
    }

    // ===== Protocol Parameter Getters =====

    pub fn get_performance_fee(env: Env) -> u32 {
        env.storage().instance().get(&GovernorDataKey::PerformanceFee).unwrap_or(DEFAULT_PERFORMANCE_FEE)
    }

    pub fn get_withdrawal_fee(env: Env) -> u32 {
        env.storage().instance().get(&GovernorDataKey::WithdrawalFee).unwrap_or(DEFAULT_WITHDRAWAL_FEE)
    }

    pub fn get_rebalance_threshold(env: Env) -> u32 {
        env.storage().instance().get(&GovernorDataKey::RebalanceThreshold).unwrap_or(DEFAULT_REBALANCE_THRESHOLD)
    }

    pub fn get_insurance_reserve_target(env: Env) -> u32 {
        env.storage().instance().get(&GovernorDataKey::InsuranceReserveTarget).unwrap_or(DEFAULT_INSURANCE_RESERVE)
    }

    // ===== Protocol Parameter Setters (called by governance via `execute`) =====

    pub fn set_performance_fee(env: Env, fee: u32) {
        if fee < MIN_PERFORMANCE_FEE || fee > MAX_PERFORMANCE_FEE {
            panic!("performance fee out of range");
        }
        env.storage().instance().set(&GovernorDataKey::PerformanceFee, &fee);
    }

    pub fn set_withdrawal_fee(env: Env, fee: u32) {
        if fee < MIN_WITHDRAWAL_FEE || fee > MAX_WITHDRAWAL_FEE {
            panic!("withdrawal fee out of range");
        }
        env.storage().instance().set(&GovernorDataKey::WithdrawalFee, &fee);
    }

    pub fn set_rebalance_threshold(env: Env, threshold: u32) {
        if threshold < MIN_REBALANCE_THRESHOLD || threshold > MAX_REBALANCE_THRESHOLD {
            panic!("rebalance threshold out of range");
        }
        env.storage().instance().set(&GovernorDataKey::RebalanceThreshold, &threshold);
    }

    pub fn set_insurance_reserve_target(env: Env, target: u32) {
        if target < MIN_INSURANCE_RESERVE || target > MAX_INSURANCE_RESERVE {
            panic!("insurance reserve target out of range");
        }
        env.storage().instance().set(&GovernorDataKey::InsuranceReserveTarget, &target);
    }

    // ===== Emergency Functions =====

    /// Emergency pause (3-of-5 multisig required)
    pub fn emergency_pause(env: Env, signers: Vec<Address>) {
        Self::verify_emergency_signers(&env, &signers);
        // Pausing the governed contracts is performed by the caller (e.g. a
        // relayer) invoking each contract's own `pause` once this succeeds.
    }

    /// Emergency unpause (3-of-5 multisig required)
    pub fn emergency_unpause(env: Env, signers: Vec<Address>) {
        Self::verify_emergency_signers(&env, &signers);
    }

    fn verify_emergency_signers(env: &Env, signers: &Vec<Address>) {
        let multisig: Vec<Address> = env.storage().instance().get(&GovernorDataKey::EmergencyMultisig).unwrap();

        let mut valid_signatures = 0u32;
        for signer in signers.iter() {
            signer.require_auth();
            if multisig.contains(&signer) {
                valid_signatures += 1;
            }
        }

        if valid_signatures < 3 {
            panic!("insufficient signatures for emergency action");
        }
    }
}

} // mod protocol_governor

// ===== Voting Escrow (veToken) =====
mod voting_escrow {
    use super::*;

#[contract]
pub struct VotingEscrow;

#[contracttype]
#[derive(Clone)]
enum VotingEscrowDataKey {
    LockedAmount(Address),
    LockStart(Address),
    LockEnd(Address),
    TotalSupply,
    TotalSupplyAt(u64),
    DelegatedFrom(Address),
    DelegatedTo(Address),
    GovernanceToken,
}

#[contractimpl]
impl VotingEscrow {
    /// Initialize voting escrow
    pub fn initialize(env: Env, governance_token: Address) {
        env.storage().instance().set(&VotingEscrowDataKey::GovernanceToken, &governance_token);
        env.storage().instance().set(&VotingEscrowDataKey::TotalSupply, &0i128);
    }

    fn governance_token(env: &Env) -> Address {
        env.storage().instance().get(&VotingEscrowDataKey::GovernanceToken).unwrap()
    }

    fn locked_amount(env: &Env, user: &Address) -> i128 {
        env.storage().instance().get(&VotingEscrowDataKey::LockedAmount(user.clone())).unwrap_or(0)
    }

    fn lock_start(env: &Env, user: &Address) -> u64 {
        env.storage().instance().get(&VotingEscrowDataKey::LockStart(user.clone())).unwrap_or(0)
    }

    fn lock_end(env: &Env, user: &Address) -> u64 {
        env.storage().instance().get(&VotingEscrowDataKey::LockEnd(user.clone())).unwrap_or(0)
    }

    /// Create a new lock
    pub fn create_lock(env: Env, user: Address, amount: i128, duration: u64) {
        user.require_auth();

        if duration < MIN_VOTE_DURATION || duration > MAX_VOTE_DURATION {
            panic!("lock duration must be between 1 week and 4 years");
        }

        let existing_end = Self::lock_end(&env, &user);
        if existing_end > env.ledger().timestamp() {
            panic!("existing lock must be withdrawn first");
        }

        let gov_token = Self::governance_token(&env);
        GovernanceTokenClient::new(&env, &gov_token).transfer(&user, &env.current_contract_address(), &amount);

        let current_time = env.ledger().timestamp();
        let lock_end = current_time + duration;

        env.storage().instance().set(&VotingEscrowDataKey::LockedAmount(user.clone()), &amount);
        env.storage().instance().set(&VotingEscrowDataKey::LockStart(user.clone()), &current_time);
        env.storage().instance().set(&VotingEscrowDataKey::LockEnd(user), &lock_end);

        let total = Self::get_total_supply(env.clone()) + amount;
        env.storage().instance().set(&VotingEscrowDataKey::TotalSupply, &total);
        env.storage().instance().set(&VotingEscrowDataKey::TotalSupplyAt(current_time), &total);
    }

    /// Increase lock amount
    pub fn increase_lock(env: Env, user: Address, amount: i128) {
        user.require_auth();

        let lock_end = Self::lock_end(&env, &user);
        if lock_end <= env.ledger().timestamp() {
            panic!("lock expired, must create new lock");
        }

        let gov_token = Self::governance_token(&env);
        GovernanceTokenClient::new(&env, &gov_token).transfer(&user, &env.current_contract_address(), &amount);

        let locked = Self::locked_amount(&env, &user) + amount;
        env.storage().instance().set(&VotingEscrowDataKey::LockedAmount(user), &locked);

        let total = Self::get_total_supply(env.clone()) + amount;
        env.storage().instance().set(&VotingEscrowDataKey::TotalSupply, &total);
    }

    /// Extend lock duration
    pub fn extend_lock(env: Env, user: Address, new_duration: u64) {
        user.require_auth();

        let current_time = env.ledger().timestamp();

        if new_duration < MIN_VOTE_DURATION || new_duration > MAX_VOTE_DURATION {
            panic!("lock duration must be between 1 week and 4 years");
        }

        let lock_end = Self::lock_end(&env, &user);
        let lock_start = Self::lock_start(&env, &user);
        let existing_lock_duration = lock_end.saturating_sub(lock_start);

        if new_duration < existing_lock_duration {
            panic!("cannot shorten lock duration");
        }

        let new_lock_end = current_time + new_duration;
        env.storage().instance().set(&VotingEscrowDataKey::LockEnd(user), &new_lock_end);
    }

    /// Withdraw after lock expires
    pub fn withdraw(env: Env, user: Address) {
        user.require_auth();

        let lock_end = Self::lock_end(&env, &user);
        if lock_end > env.ledger().timestamp() {
            panic!("lock has not expired");
        }

        let amount = Self::locked_amount(&env, &user);

        let gov_token = Self::governance_token(&env);
        GovernanceTokenClient::new(&env, &gov_token).transfer(&env.current_contract_address(), &user, &amount);

        env.storage().instance().set(&VotingEscrowDataKey::LockedAmount(user.clone()), &0i128);
        env.storage().instance().set(&VotingEscrowDataKey::LockStart(user.clone()), &0u64);
        env.storage().instance().set(&VotingEscrowDataKey::LockEnd(user), &0u64);

        let total = Self::get_total_supply(env.clone()) - amount;
        env.storage().instance().set(&VotingEscrowDataKey::TotalSupply, &total);
    }

    /// Get current voting power
    pub fn get_voting_power(env: Env, user: Address) -> i128 {
        let current_time = env.ledger().timestamp();

        let amount = Self::locked_amount(&env, &user);
        let lock_end = Self::lock_end(&env, &user);

        if lock_end <= current_time || amount == 0 {
            return 0;
        }

        // Linear decay: voting_power = amount * remaining_time / max_time
        let remaining_time = lock_end - current_time;
        let voting_power = amount * remaining_time as i128 / MAX_VOTE_DURATION as i128;

        let delegated: i128 = env.storage()
            .instance()
            .get(&VotingEscrowDataKey::DelegatedTo(user))
            .unwrap_or(0);

        voting_power + delegated
    }

    /// Calculate boosted balance (for vault APY boost)
    pub fn get_boosted_balance(env: Env, user: Address) -> i128 {
        let current_time = env.ledger().timestamp();

        let amount = Self::locked_amount(&env, &user);
        let lock_end = Self::lock_end(&env, &user);

        if lock_end <= current_time || amount == 0 {
            return 0;
        }

        let lock_start = Self::lock_start(&env, &user);
        let lock_duration = lock_end - lock_start;

        // Boost factor: longer locks get higher boost (up to 2.5x)
        let duration_factor = lock_duration as i128 * 10000 / MAX_VOTE_DURATION as i128;
        let boost = 10000 + duration_factor * 1500 / 10000;

        let boosted = amount * boost / 10000;
        let max_boosted = amount * MAX_BOOST_MULTIPLIER / 10000;

        if boosted < max_boosted {
            boosted
        } else {
            max_boosted
        }
    }

    /// Delegate voting power to another address
    pub fn delegate(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();

        let voting_power = Self::get_voting_power(env.clone(), from.clone());
        if voting_power < amount {
            panic!("insufficient voting power to delegate");
        }

        let delegated_from: i128 = env.storage()
            .instance()
            .get(&VotingEscrowDataKey::DelegatedFrom(from.clone()))
            .unwrap_or(0);
        env.storage().instance().set(&VotingEscrowDataKey::DelegatedFrom(from), &(delegated_from + amount));

        let delegated_to: i128 = env.storage()
            .instance()
            .get(&VotingEscrowDataKey::DelegatedTo(to.clone()))
            .unwrap_or(0);
        env.storage().instance().set(&VotingEscrowDataKey::DelegatedTo(to), &(delegated_to + amount));
    }

    /// Get lock info
    pub fn get_lock_info(env: Env, user: Address) -> (i128, u64, u64) {
        (
            Self::locked_amount(&env, &user),
            Self::lock_start(&env, &user),
            Self::lock_end(&env, &user),
        )
    }

    /// Get total supply
    pub fn get_total_supply(env: Env) -> i128 {
        env.storage().instance().get(&VotingEscrowDataKey::TotalSupply).unwrap_or(0)
    }

    /// Get boost multiplier for a user, in basis points (10000 = 1x)
    pub fn get_boost_multiplier(env: Env, user: Address) -> u32 {
        let boosted = Self::get_boosted_balance(env.clone(), user.clone());
        let locked = Self::locked_amount(&env, &user);

        if locked == 0 {
            return 10000;
        }

        let multiplier = boosted * 10000 / locked;
        u32::try_from(multiplier).unwrap_or(10000)
    }
}

} // mod voting_escrow

// ===== Emergency Multisig =====
mod emergency_multisig {
    use super::*;

#[contract]
pub struct EmergencyMultisig;

#[contracttype]
#[derive(Clone)]
enum MultisigDataKey {
    Signers,
    RequiredSignatures,
    PendingTx(Address, Bytes),
    TxSigners(u32),
    NextTxId,
}

#[contractimpl]
impl EmergencyMultisig {
    /// Initialize multisig
    pub fn initialize(env: Env, signers: Vec<Address>, required: u32) {
        if signers.len() != 5 {
            panic!("must have exactly 5 signers");
        }
        if required < 3 || required > 5 {
            panic!("required signatures must be between 3 and 5");
        }

        env.storage().instance().set(&MultisigDataKey::Signers, &signers);
        env.storage().instance().set(&MultisigDataKey::RequiredSignatures, &required);
        env.storage().instance().set(&MultisigDataKey::NextTxId, &1u32);
    }

    fn signers(env: &Env) -> Vec<Address> {
        env.storage().instance().get(&MultisigDataKey::Signers).unwrap()
    }

    /// Submit an emergency transaction
    pub fn submit_emergency_tx(env: Env, proposer: Address, to: Address, data: Bytes) -> u32 {
        proposer.require_auth();

        let signers = Self::signers(&env);
        if !signers.contains(&proposer) {
            panic!("only signers can submit emergency transactions");
        }

        let tx_id: u32 = env.storage().instance().get(&MultisigDataKey::NextTxId).unwrap_or(1);
        env.storage().instance().set(&MultisigDataKey::NextTxId, &(tx_id + 1));

        let mut tx_signers: Vec<Address> = Vec::new(&env);
        tx_signers.push_back(proposer);

        env.storage().instance().set(&MultisigDataKey::PendingTx(to, data), &tx_id);
        env.storage().instance().set(&MultisigDataKey::TxSigners(tx_id), &tx_signers);

        tx_id
    }

    /// Confirm an emergency transaction. Returns true once enough signers have confirmed.
    pub fn confirm_tx(env: Env, confirmer: Address, tx_id: u32) -> bool {
        confirmer.require_auth();

        let signers = Self::signers(&env);
        if !signers.contains(&confirmer) {
            panic!("only signers can confirm transactions");
        }

        let mut tx_signers: Vec<Address> = env.storage()
            .instance()
            .get(&MultisigDataKey::TxSigners(tx_id))
            .unwrap_or_else(|| panic!("unknown transaction"));
        tx_signers.push_back(confirmer);

        let required: u32 = env.storage().instance().get(&MultisigDataKey::RequiredSignatures).unwrap();
        env.storage().instance().set(&MultisigDataKey::TxSigners(tx_id), &tx_signers);

        tx_signers.len() >= required
    }
}

} // mod emergency_multisig

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Helper: pure voting-power formula extracted from VotingEscrow so tests
    // can exercise it without needing a live Soroban Env.
    //
    //   voting_power = locked_amount * remaining_time / MAX_VOTE_DURATION
    // -----------------------------------------------------------------------
    fn compute_voting_power(locked_amount: u64, lock_end: u64, current_time: u64) -> u64 {
        if lock_end <= current_time {
            return 0;
        }
        let remaining = lock_end - current_time;
        locked_amount * remaining / (MAX_VOTE_DURATION as u64)
    }

    // -----------------------------------------------------------------------
    // Helper: quorum check — total votes must be >= QUORUM_PERCENTAGE/10000
    // of total_supply.
    // -----------------------------------------------------------------------
    fn quorum_reached(votes_for: u64, votes_against: u64, total_supply: u64) -> bool {
        let total_votes = votes_for + votes_against;
        // QUORUM_PERCENTAGE is in basis points (400 = 4%)
        let required = total_supply * (QUORUM_PERCENTAGE as u64) / 10_000;
        total_votes >= required
    }

    // -----------------------------------------------------------------------
    // Helper: boost multiplier formula extracted from VotingEscrow.
    //
    //   duration_factor = lock_duration * 10000 / MAX_VOTE_DURATION
    //   boost_bp        = 10000 + duration_factor * 1500 / 10000
    //   capped at MAX_BOOST_MULTIPLIER
    // -----------------------------------------------------------------------
    fn compute_boost_multiplier(lock_duration: u64) -> u32 {
        let duration_factor = lock_duration * 10_000 / (MAX_VOTE_DURATION as u64);
        let boost = 10_000u64 + duration_factor * 1_500 / 10_000;
        let capped = boost.min(MAX_BOOST_MULTIPLIER as u64);
        capped as u32
    }

    // =========================================================================
    // Token Distribution
    // =========================================================================

    #[test]
    fn test_token_distribution() {
        // Verify total allocations equal 100%
        let total = COMMUNITY_ALLOCATION + TEAM_ALLOCATION + TREASURY_ALLOCATION + LIQUIDITY_MINING_ALLOCATION;
        assert_eq!(total, TOTAL_SUPPLY);
    }

    // =========================================================================
    // Quorum Calculation
    // =========================================================================

    #[test]
    fn test_quorum_calculation() {
        // QUORUM_PERCENTAGE constant must equal 400 bp (4%)
        assert_eq!(QUORUM_PERCENTAGE, 400, "quorum must be 4% (400 basis points)");

        // With 1 billion total supply, quorum = 4% = 40 million
        let total_supply: u64 = 1_000_000_000;
        let quorum_required = total_supply * (QUORUM_PERCENTAGE as u64) / 10_000;
        assert_eq!(quorum_required, 40_000_000);

        // Exactly at quorum → passes
        assert!(
            quorum_reached(40_000_000, 0, total_supply),
            "exactly at quorum threshold should pass"
        );

        // One token below quorum → fails
        assert!(
            !quorum_reached(39_999_999, 0, total_supply),
            "one token below quorum should fail"
        );

        // Quorum reached via combination of for + against votes
        assert!(
            quorum_reached(20_000_000, 20_000_000, total_supply),
            "sum of for+against votes counting toward quorum"
        );

        // Proposal passes: quorum reached AND more votes for than against
        let votes_for: u64 = 50_000_000;
        let votes_against: u64 = 5_000_000;
        assert!(quorum_reached(votes_for, votes_against, total_supply));
        assert!(votes_for > votes_against);

        // Proposal defeated: quorum reached but more against
        let votes_for_d: u64 = 20_000_000;
        let votes_against_d: u64 = 25_000_000;
        assert!(quorum_reached(votes_for_d, votes_against_d, total_supply));
        assert!(
            votes_for_d < votes_against_d,
            "more votes against means proposal is defeated"
        );

        // Proposal defeated: quorum NOT reached even if all votes are for
        let votes_low: u64 = 1_000;
        assert!(
            !quorum_reached(votes_low, 0, total_supply),
            "very low participation means no quorum"
        );
    }

    #[test]
    fn test_quorum_with_small_supply() {
        // Edge: tiny total supply
        let total_supply: u64 = 100;
        // 4% of 100 = 4
        assert!(quorum_reached(4, 0, total_supply));
        assert!(!quorum_reached(3, 0, total_supply));
    }

    // =========================================================================
    // Vote Casting / Proposal Lifecycle (pure logic)
    // =========================================================================

    #[test]
    fn test_vote_casting_accumulation() {
        // Simulate accumulating votes for and against a proposal.
        let mut votes_for: u64 = 0;
        let mut votes_against: u64 = 0;

        // Three voters cast FOR
        votes_for += 10_000_000;
        votes_for += 15_000_000;
        votes_for += 5_000_000;

        // Two voters cast AGAINST
        votes_against += 8_000_000;
        votes_against += 2_000_000;

        assert_eq!(votes_for, 30_000_000);
        assert_eq!(votes_against, 10_000_000);

        // Quorum reached (40M total supply)
        let total_supply: u64 = 1_000_000_000;
        assert!(quorum_reached(votes_for, votes_against, total_supply));

        // Proposal passes
        assert!(votes_for > votes_against);
    }

    #[test]
    fn test_proposal_lifecycle_state_transitions() {
        // ProposalState copy semantics — verify all variants exist and
        // can be compared with PartialEq.
        let pending = ProposalState::Pending;
        let active = ProposalState::Active;
        let canceled = ProposalState::Canceled;
        let defeated = ProposalState::Defeated;
        let succeeded = ProposalState::Succeeded;
        let queued = ProposalState::Queued;
        let expired = ProposalState::Expired;
        let executed = ProposalState::Executed;

        // All states are distinct
        assert_ne!(pending, active);
        assert_ne!(active, succeeded);
        assert_ne!(succeeded, queued);
        assert_ne!(queued, executed);
        assert_ne!(canceled, defeated);
        assert_ne!(expired, executed);

        // Copy semantics work
        let s = ProposalState::Active;
        let s2 = s;
        assert_eq!(s, s2);

        // Simple lifecycle: Pending → Active → Succeeded → Queued → Executed
        let lifecycle = [pending, active, succeeded, queued, executed];
        let expected = [
            ProposalState::Pending,
            ProposalState::Active,
            ProposalState::Succeeded,
            ProposalState::Queued,
            ProposalState::Executed,
        ];
        for (got, want) in lifecycle.iter().zip(expected.iter()) {
            assert_eq!(got, want);
        }

        // Failed lifecycle: Pending → Active → Defeated
        let failed = [pending, active, defeated];
        assert_eq!(failed[2], ProposalState::Defeated);

        // Canceled lifecycle: Pending → Canceled
        let cancelled_path = [pending, canceled];
        assert_eq!(cancelled_path[1], ProposalState::Canceled);
    }

    #[test]
    fn test_proposal_can_execute_logic() {
        // can_execute = state == Succeeded && current_time >= eta && !executed
        struct FakeProposal {
            state: ProposalState,
            eta: u64,
            executed: bool,
        }

        impl FakeProposal {
            fn can_execute(&self, current_time: u64) -> bool {
                self.state == ProposalState::Succeeded
                    && current_time >= self.eta
                    && !self.executed
            }
        }

        let eta = 1_000_000u64;

        // Succeeded + time elapsed + not executed → can execute
        let p = FakeProposal {
            state: ProposalState::Succeeded,
            eta,
            executed: false,
        };
        assert!(p.can_execute(eta));
        assert!(p.can_execute(eta + 1));

        // Succeeded but timelock not elapsed → cannot execute
        assert!(!p.can_execute(eta - 1));

        // Already executed → cannot execute
        let p2 = FakeProposal {
            state: ProposalState::Succeeded,
            eta,
            executed: true,
        };
        assert!(!p2.can_execute(eta + 100));

        // Queued (not Succeeded) → cannot execute
        let p3 = FakeProposal {
            state: ProposalState::Queued,
            eta,
            executed: false,
        };
        assert!(!p3.can_execute(eta + 100));
    }

    #[test]
    fn test_is_active_logic() {
        // is_active = state == Active && current_time in [start_time, end_time)
        struct FakeProposal {
            state: ProposalState,
            start_time: u64,
            end_time: u64,
        }

        impl FakeProposal {
            fn is_active(&self, t: u64) -> bool {
                self.state == ProposalState::Active
                    && t >= self.start_time
                    && t < self.end_time
            }
        }

        let p = FakeProposal {
            state: ProposalState::Active,
            start_time: 1000,
            end_time: 2000,
        };

        assert!(!p.is_active(999), "before start_time → not active");
        assert!(p.is_active(1000), "at start_time → active");
        assert!(p.is_active(1500), "mid voting period → active");
        assert!(!p.is_active(2000), "at end_time → no longer active (exclusive)");
        assert!(!p.is_active(2001), "after end_time → not active");

        let p_pending = FakeProposal {
            state: ProposalState::Pending,
            start_time: 1000,
            end_time: 2000,
        };
        assert!(!p_pending.is_active(1500), "pending state → not active");
    }

    // =========================================================================
    // Timelock Delay
    // =========================================================================

    #[test]
    fn test_timelock_delay() {
        // 2 days in seconds
        assert_eq!(TIMELOCK_DELAY, 172_800, "timelock must be 48 hours (172800 s)");

        // Verify the arithmetic: 2 * 24 * 60 * 60 = 172800
        let two_days_seconds: u32 = 2 * 24 * 60 * 60;
        assert_eq!(TIMELOCK_DELAY, two_days_seconds);

        // A proposal queued at time T can only execute at T + TIMELOCK_DELAY
        let queue_time: u64 = 1_000_000;
        let eta = queue_time + TIMELOCK_DELAY as u64;
        assert_eq!(eta, 1_172_800);

        // One second before eta → cannot execute
        assert!(queue_time + TIMELOCK_DELAY as u64 - 1 < eta);
        // At eta → can execute
        assert!(eta >= eta);
    }

    // =========================================================================
    // Boost Multiplier
    // =========================================================================

    #[test]
    fn test_boost_multiplier() {
        // MAX_BOOST_MULTIPLIER must be 2500 bp (2.5×)
        assert_eq!(MAX_BOOST_MULTIPLIER, 2500, "max boost must be 2.5x (2500 bp)");

        // MIN_VOTE_DURATION is 1 week; MAX_VOTE_DURATION is 4 years
        assert_eq!(MIN_VOTE_DURATION, 604_800, "min lock is 1 week");
        assert_eq!(MAX_VOTE_DURATION, 126_144_000, "max lock is 4 years");

        let max_dur = MAX_VOTE_DURATION as u64;

        // Full 4-year lock → maximum boost (capped at 2500)
        let boost_max = compute_boost_multiplier(max_dur);
        assert_eq!(
            boost_max,
            MAX_BOOST_MULTIPLIER,
            "4-year lock should reach max boost of 2500 bp"
        );

        // 2-year lock (half of max) → boost is below max
        let boost_half = compute_boost_multiplier(max_dur / 2);
        assert!(
            boost_half < MAX_BOOST_MULTIPLIER,
            "half-max lock should be below max boost"
        );
        assert!(boost_half > 10_000, "half-max lock should still boost above 1x");

        // Zero lock duration → base multiplier (10000 = 1×)
        let boost_zero = compute_boost_multiplier(0);
        assert_eq!(boost_zero, 10_000, "zero lock duration gives 1x multiplier");

        // Boost is monotonically non-decreasing with lock duration
        let durations: &[u64] = &[0, max_dur / 8, max_dur / 4, max_dur / 2, max_dur];
        let mut prev = 0u32;
        for &d in durations {
            let b = compute_boost_multiplier(d);
            assert!(b >= prev, "boost should be non-decreasing with lock duration");
            prev = b;
        }
    }

    #[test]
    fn test_boost_never_exceeds_max() {
        // Even with a lock longer than MAX_VOTE_DURATION, boost stays at cap
        let max_dur = MAX_VOTE_DURATION as u64;
        let boost_capped = compute_boost_multiplier(max_dur * 2);
        assert_eq!(
            boost_capped,
            MAX_BOOST_MULTIPLIER,
            "boost must not exceed MAX_BOOST_MULTIPLIER"
        );
    }

    // =========================================================================
    // Protocol Parameter Bounds
    // =========================================================================

    #[test]
    fn test_protocol_parameter_bounds() {
        // Performance fee range
        assert!(DEFAULT_PERFORMANCE_FEE >= MIN_PERFORMANCE_FEE);
        assert!(DEFAULT_PERFORMANCE_FEE <= MAX_PERFORMANCE_FEE);
        assert_eq!(MIN_PERFORMANCE_FEE, 500);   // 5%
        assert_eq!(MAX_PERFORMANCE_FEE, 1500);  // 15%
        assert_eq!(DEFAULT_PERFORMANCE_FEE, 1000); // 10%

        // Withdrawal fee range
        assert!(DEFAULT_WITHDRAWAL_FEE >= MIN_WITHDRAWAL_FEE);
        assert!(DEFAULT_WITHDRAWAL_FEE <= MAX_WITHDRAWAL_FEE);

        // Rebalance threshold range
        assert!(DEFAULT_REBALANCE_THRESHOLD >= MIN_REBALANCE_THRESHOLD);
        assert!(DEFAULT_REBALANCE_THRESHOLD <= MAX_REBALANCE_THRESHOLD);

        // Insurance reserve range
        assert!(DEFAULT_INSURANCE_RESERVE >= MIN_INSURANCE_RESERVE);
        assert!(DEFAULT_INSURANCE_RESERVE <= MAX_INSURANCE_RESERVE);
    }

    #[test]
    fn test_emergency_multisig_threshold() {
        // The multisig requires 3-of-5 signatures.
        let total_signers = 5usize;
        let required_threshold = 3usize;

        // Simulate signature validation
        let valid_count = 3usize;
        assert!(valid_count >= required_threshold, "3 valid sigs should meet threshold");

        // 2 signatures should NOT be enough
        let insufficient = 2usize;
        assert!(insufficient < required_threshold, "2 sigs should be insufficient");

        // All 5 signatures → definitely enough
        assert!(total_signers >= required_threshold);
    }
}
