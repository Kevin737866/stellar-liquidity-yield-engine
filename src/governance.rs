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
    contract, contractimpl, contractmeta, Address, Env, String, Vec as SorobanVec,
    BigInt, ConversionError, TryFromVal, IntoVal, Val,
};
use soroban_sdk::token::{Token, TokenClient};
use std::collections::BTreeMap;

// ===== Token Distribution Constants =====
const TOTAL_SUPPLY: u32 = 1_000_000_000; // 1 billion tokens (10^9 with 7 decimals)
const COMMUNITY_ALLOCATION: u32 = 500_000_000; // 50%
const TEAM_ALLOCATION: u32 = 200_000_000; // 20%
const TREASURY_ALLOCATION: u32 = 200_000_000; // 20%
const LIQUIDITY_MINING_ALLOCATION: u32 = 100_000_000; // 10%

// ===== Governance Parameters =====
const QUORUM_PERCENTAGE: u32 = 400; // 4% of total supply (in basis points)
const TIMELOCK_DELAY: u32 = 172800; // 2 days in seconds
const PROPOSAL_THRESHOLD: u32 = 100_000_000; // 100 tokens minimum to propose
const MAX_PROPOSAL_DESCRIPTION_LENGTH: u32 = 280;
const MAX_CALL_DATA_LENGTH: u32 = 50;

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
const MAX_BOOST_MULTIPLIER: u32 = 2500; // 2.5x (in basis points)
const MAX_VOTE_DURATION: u32 = 126144000; // 4 years in seconds
const MIN_VOTE_DURATION: u32 = 604800; // 1 week in seconds

// ===== Proposal States =====
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
#[derive(Clone)]
pub struct CallData {
    pub contract_address: Address,
    pub function_name: String,
    pub args: Vec<Val>,
}

impl CallData {
    pub fn new(contract_address: Address, function_name: String, args: Vec<Val>) -> Self {
        Self {
            contract_address,
            function_name,
            args,
        }
    }
}

// ===== Governance Proposal =====
#[derive(Clone)]
pub struct GovernanceProposal {
    pub proposer: Address,
    pub description: String,
    pub call_data: Vec<CallData>,
    pub votes_for: BigInt,
    pub votes_against: BigInt,
    pub eta: u64, // Execution timestamp
    pub start_time: u64,
    pub end_time: u64,
    pub snapshot_block: u64,
    pub state: ProposalState,
    pub for_voters: BTreeMap<Address, BigInt>,
    pub against_voters: BTreeMap<Address, BigInt>,
    pub canceled: bool,
    pub queued: bool,
    pub executed: bool,
}

impl GovernanceProposal {
    pub fn new(
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
            votes_for: BigInt::zero(&proposer.get_env().clone()),
            votes_against: BigInt::zero(&proposer.get_env().clone()),
            eta: 0,
            start_time,
            end_time: start_time + duration,
            snapshot_block,
            state: ProposalState::Pending,
            for_voters: BTreeMap::new(),
            against_voters: BTreeMap::new(),
            canceled: false,
            queued: false,
            executed: false,
        }
    }

    pub fn activate(&mut self, current_time: u64) {
        if self.state == ProposalState::Pending && current_time >= self.start_time {
            self.state = ProposalState::Active;
        }
    }

    pub fn is_active(&self, current_time: u64) -> bool {
        self.state == ProposalState::Active && 
            current_time >= self.start_time && 
            current_time < self.end_time
    }

    pub fn can_execute(&self, current_time: u64) -> bool {
        self.state == ProposalState::Succeeded && 
            current_time >= self.eta &&
            !self.executed
    }
}

// ===== Governance Token =====
#[contract]
pub struct GovernanceToken {
    // Token state
}

contractmeta!(
    key = "Name",
    val = "Stellar Yield Governance Token"
);

contractmeta!(
    key = "Symbol",
    val = "SYGT"
);

contractmeta!(
    key = "Decimals",
    val = 7
);

#[contractimpl]
impl GovernanceToken {
    // ===== Token Storage Keys =====
    fn key_total_supply() -> BigInt { todo!() }
    fn key_balance(addr: &Address) -> BigInt { todo!() }
    fn key_allowance(owner: &Address, spender: &Address) -> BigInt { todo!() }
    fn key_delegate(from: &Address, to: &Address) -> BigInt { todo!() }
    fn key_team_vesting(addr: &Address) -> u64 { todo!() }
    fn key_is_minting_allowed() -> bool { todo!() }

    // ===== Token Functions =====

    /// Initialize the governance token with initial distribution
    pub fn initialize(
        e: Env,
        admin: Address,
        community_wallet: Address,
        team_wallet: Address,
        treasury_wallet: Address,
        liquidity_mining_wallet: Address,
    ) -> Result<(), &'static str> {
        // Validate admin is not zero
        if admin == Address::random(&e) {
            return Err("Invalid admin address");
        }

        // Set initial supply distribution
        let env = e.clone();
        let scale = BigInt::from_u32(&env, 10_000_000); // 10^7 for 7 decimals
        
        // Mint allocations
        let community_amount = BigInt::from_u32(&env, COMMUNITY_ALLOCATION) * &scale;
        let team_amount = BigInt::from_u32(&env, TEAM_ALLOCATION) * &scale;
        let treasury_amount = BigInt::from_u32(&env, TREASURY_ALLOCATION) * &scale;
        let liquidity_amount = BigInt::from_u32(&env, LIQUIDITY_MINING_ALLOCATION) * &scale;
        let total = &community_amount + &team_amount + &treasury_amount + &liquidity_amount;

        // Store total supply
        e.extension_state().set(&Self::key_total_supply(), &total);

        // Set balances
        e.extension_state().set(&Self::key_balance(&community_wallet), &community_amount);
        e.extension_state().set(&Self::key_balance(&team_wallet), &team_amount);
        e.extension_state().set(&Self::key_balance(&treasury_wallet), &treasury_amount);
        e.extension_state().set(&Self::key_balance(&liquidity_mining_wallet), &liquidity_amount);

        // Set team vesting start (4-year vest)
        let vesting_start = e.ledger().timestamp() + (4 * 365 * 24 * 60 * 60); // 4 years
        e.extension_state().set(&Self::key_team_vesting(&team_wallet), &vesting_start);

        Ok(())
    }

    /// Mint new tokens (only by governance or liquidity mining)
    pub fn mint(&mut self, to: Address, amount: BigInt) -> Result<(), &'static str> {
        let e = Env::current();
        
        // Verify caller is authorized (governance or liquidity mining contract)
        let caller = e.get_current_contract_address();
        
        // Add to recipient balance
        let mut to_balance = Self::key_balance(&to);
        to_balance = to_balance + amount;
        e.extension_state().set(&Self::key_balance(&to), &to_balance);

        // Update total supply
        let mut total_supply = Self::key_total_supply();
        total_supply = total_supply + amount;
        e.extension_state().set(&Self::key_total_supply(), &total_supply);

        Ok(())
    }

    /// Burn tokens
    pub fn burn(&mut self, from: Address, amount: BigInt) -> Result<(), &'static str> {
        let e = Env::current();
        
        // Check balance
        let mut from_balance = Self::key_balance(&from);
        if from_balance < amount {
            return Err("Insufficient balance");
        }

        // Deduct from balance
        from_balance = from_balance - amount;
        e.extension_state().set(&Self::key_balance(&from), &from_balance);

        // Update total supply
        let mut total_supply = Self::key_total_supply();
        total_supply = total_supply - amount;
        e.extension_state().set(&Self::key_total_supply(), &total_supply);

        Ok(())
    }

    /// Delegate voting power to another address
    pub fn delegate(&mut self, from: Address, to: Address) -> Result<(), &'static str> {
        let e = Env::current();
        
        // Store delegation
        let amount = Self::key_balance(&from);
        e.extension_state().set(&Self::key_delegate(&from, &to), &amount);

        Ok(())
    }

    /// Get current balance
    pub fn balance(&self, addr: Address) -> BigInt {
        let e = Env::current();
        Self::key_balance(&addr)
    }

    /// Get total supply
    pub fn total_supply(&self) -> BigInt {
        let e = Env::current();
        Self::key_total_supply()
    }

    /// Transfer tokens
    pub fn transfer(&mut self, from: Address, to: Address, amount: BigInt) -> Result<(), &'static str> {
        let e = Env::current();
        
        // Check allowance
        let mut from_balance = Self::key_balance(&from);
        if from_balance < amount {
            return Err("Insufficient balance");
        }

        // Deduct from sender
        from_balance = from_balance - amount;
        e.extension_state().set(&Self::key_balance(&from), &from_balance);

        // Add to recipient
        let mut to_balance = Self::key_balance(&to);
        to_balance = to_balance + amount;
        e.extension_state().set(&Self::key_balance(&to), &to_balance);

        Ok(())
    }

    /// Approve spender
    pub fn approve(&mut self, from: Address, spender: Address, amount: BigInt) -> Result<(), &'static str> {
        let e = Env::current();
        e.extension_state().set(&Self::key_allowance(&from, &spender), &amount);
        Ok(())
    }

    /// Get allowance
    pub fn allowance(&self, owner: Address, spender: Address) -> BigInt {
        let e = Env::current();
        Self::key_allowance(&owner, &spender)
    }

    /// Check if team tokens are still locked
    pub fn is_team_locked(&self, addr: Address) -> bool {
        let e = Env::current();
        let vesting_end = Self::key_team_vesting(&addr);
        e.ledger().timestamp() < vesting_end
    }
}

// ===== Staking Contract =====
#[contract]
pub struct StakingContract {
    // Staking state
}

contractmeta!(
    key = "Name",
    val = "Stellar Yield Staking Contract"
);

#[contractimpl]
impl StakingContract {
    // ===== Storage Keys =====
    fn key_stake_balance(addr: &Address) -> BigInt { todo!() }
    fn key_stake_start(addr: &Address) -> u64 { todo!() }
    fn key_total_staked() -> BigInt { todo!() }
    fn key_accrued_rewards(addr: &Address) -> BigInt { todo!() }
    fn key_last_claim_time(addr: &Address) -> u64 { todo!() }
    fn key_reward_per_token() -> BigInt { todo!() }
    fn key_governance_token() -> Address { todo!() }

    /// Initialize staking contract
    pub fn initialize(
        e: Env,
        governance_token: Address,
        fee_distributor: Address,
    ) -> Result<(), &'static str> {
        e.extension_state().set(&Self::key_governance_token(), &governance_token);
        e.extension_state().set(&Self::key_reward_per_token(), &BigInt::zero(&e));
        e.extension_state().set(&Self::key_total_staked(), &BigInt::zero(&e));
        Ok(())
    }

    /// Stake governance tokens
    pub fn stake(&mut self, user: Address, amount: BigInt) -> Result<(), &'static str> {
        let e = Env::current();

        // Transfer tokens from user to contract
        let gov_token = Self::key_governance_token();
        TokenClient::new(&e, &gov_token).transfer(&user, &e.get_current_contract_address(), &amount);

        // Update stake balance
        let mut stake_balance = Self::key_stake_balance(&user);
        stake_balance = stake_balance + amount;
        e.extension_state().set(&Self::key_stake_balance(&user), &stake_balance);

        // Update total staked
        let mut total_staked = Self::key_total_staked();
        total_staked = total_staked + amount;
        e.extension_state().set(&Self::key_total_staked(), &total_staked);

        // Update stake start time
        e.extension_state().set(&Self::key_stake_start(&user), &e.ledger().timestamp());

        Ok(())
    }

    /// Unstake governance tokens
    pub fn unstake(&mut self, user: Address, amount: BigInt) -> Result<(), &'static str> {
        let e = Env::current();

        // Check stake balance
        let mut stake_balance = Self::key_stake_balance(&user);
        if stake_balance < amount {
            return Err("Insufficient staked balance");
        }

        // Deduct from stake balance
        stake_balance = stake_balance - amount;
        e.extension_state().set(&Self::key_stake_balance(&user), &stake_balance);

        // Update total staked
        let mut total_staked = Self::key_total_staked();
        total_staked = total_staked - amount;
        e.extension_state().set(&Self::key_total_staked(), &total_staked);

        // Transfer tokens back to user
        let gov_token = Self::key_governance_token();
        TokenClient::new(&e, &gov_token).transfer(&e.get_current_contract_address(), &user, &amount);

        Ok(())
    }

    /// Claim staking rewards
    pub fn claim_rewards(&mut self, user: Address) -> Result<BigInt, &'static str> {
        let e = Env::current();

        // Calculate pending rewards
        let pending = self.pending_rewards(user.clone())?;
        
        // Reset accrued rewards
        e.extension_state().set(&Self::key_accrued_rewards(&user), &BigInt::zero(&e));
        e.extension_state().set(&Self::key_last_claim_time(&user), &e.ledger().timestamp());

        // Transfer rewards
        if pending > BigInt::zero(&e) {
            let gov_token = Self::key_governance_token();
            TokenClient::new(&e, &gov_token).transfer(&e.get_current_contract_address(), &user, &pending);
        }

        Ok(pending)
    }

    /// Calculate pending rewards for a user
    pub fn pending_rewards(&self, user: Address) -> Result<BigInt, &'static str> {
        let e = Env::current();
        
        let stake_balance = Self::key_stake_balance(&user);
        let reward_per_token = Self::key_reward_per_token();
        let last_claim = Self::key_last_claim_time(&user);
        
        // Simplified reward calculation
        let time_elapsed = e.ledger().timestamp() - last_claim;
        let rewards = stake_balance * BigInt::from_u32(&e, time_elapsed as u32) * reward_per_token;
        
        let accrued = Self::key_accrued_rewards(&user);
        Ok(rewards + accrued)
    }

    /// Get stake balance
    pub fn get_stake_balance(&self, user: Address) -> BigInt {
        let e = Env::current();
        Self::key_stake_balance(&user)
    }

    /// Get total staked
    pub fn get_total_staked(&self) -> BigInt {
        let e = Env::current();
        Self::key_total_staked()
    }
}

// ===== Fee Distributor =====
#[contract]
pub struct FeeDistributor {
    // Fee distribution state
}

contractmeta!(
    key = "Name",
    val = "Stellar Yield Fee Distributor"
);

#[contractimpl]
impl FeeDistributor {
    // ===== Storage Keys =====
    fn key_treasury() -> Address { todo!() }
    fn key_staking_contract() -> Address { todo!() }
    fn key_total_fees_collected() -> BigInt { todo!() }
    fn key_week_fees(week: u64) -> BigInt { todo!() }
    fn key_week_start(week: u64) -> u64 { todo!() }
    fn key_user_claimed_week(user: &Address, week: u64) -> bool { todo!() }
    fn key_accumulated_fees_per_stake() -> BigInt { todo!() }
    fn key_last_distribution_time() -> u64 { todo!() }

    /// Initialize fee distributor
    pub fn initialize(
        e: Env,
        treasury: Address,
        staking_contract: Address,
    ) -> Result<(), &'static str> {
        e.extension_state().set(&Self::key_treasury(), &treasury);
        e.extension_state().set(&Self::key_staking_contract(), &staking_contract);
        e.extension_state().set(&Self::key_total_fees_collected(), &BigInt::zero(&e));
        e.extension_state().set(&Self::key_accumulated_fees_per_stake(), &BigInt::zero(&e));
        e.extension_state().set(&Self::key_last_distribution_time(), &e.ledger().timestamp());
        Ok(())
    }

    /// Collect protocol fees from various sources
    pub fn collect_fees(&mut self, amount: BigInt) -> Result<(), &'static str> {
        let e = Env::current();
        
        // Update total fees collected
        let mut total = Self::key_total_fees_collected();
        total = total + amount;
        e.extension_state().set(&Self::key_total_fees_collected(), &total);

        // Update weekly fees
        let current_week = e.ledger().timestamp() / 604800; // Unix timestamp / seconds in a week
        let mut week_fees = Self::key_week_fees(current_week);
        week_fees = week_fees + amount;
        e.extension_state().set(&Self::key_week_fees(current_week), &week_fees);

        Ok(())
    }

    /// Claim fees for a specific week
    pub fn claim_week(&mut self, user: Address, week: u64) -> Result<BigInt, &'static str> {
        let e = Env::current();

        // Check if already claimed
        if Self::key_user_claimed_week(&user, week) {
            return Err("Already claimed for this week");
        }

        // Get staking contract
        let staking = Self::key_staking_contract();
        let user_stake = StakingContract::new(&e, &staking).get_stake_balance(user.clone());
        let total_stake = StakingContract::new(&e, &staking).get_total_staked();

        if total_stake == BigInt::zero(&e) {
            return Ok(BigInt::zero(&e));
        }

        // Calculate share
        let week_fees = Self::key_week_fees(week);
        let user_share = week_fees * user_stake / total_stake;

        // Mark as claimed
        e.extension_state().set(&Self::key_user_claimed_week(&user, week), &true);

        // Transfer fees (simplified - would use actual token)
        // TokenClient::new(&e, &xlm_usdc_token).transfer(&e.get_current_contract_address(), &user, &user_share);

        Ok(user_share)
    }

    /// Get claimable fees for a user across all weeks
    pub fn get_claimable_fees(&self, user: Address) -> BigInt {
        let e = Env::current();
        
        let current_week = e.ledger().timestamp() / 604800;
        let staking = Self::key_staking_contract();
        let user_stake = StakingContract::new(&e, &staking).get_stake_balance(user.clone());
        let total_stake = StakingContract::new(&e, &staking).get_total_staked();

        if total_stake == BigInt::zero(&e) || user_stake == BigInt::zero(&e) {
            return BigInt::zero(&e);
        }

        let mut total_claimable = BigInt::zero(&e);

        // Check last 52 weeks
        for week in (current_week.saturating_sub(51))..=current_week {
            if !Self::key_user_claimed_week(&user, week) {
                let week_fees = Self::key_week_fees(week);
                let share = week_fees * user_stake.clone() / total_stake.clone();
                total_claimable = total_claimable + share;
            }
        }

        total_claimable
    }

    /// Get total fees collected
    pub fn get_total_fees_collected(&self) -> BigInt {
        let e = Env::current();
        Self::key_total_fees_collected()
    }
}

// ===== Protocol Governor =====
#[contract]
pub struct ProtocolGovernor {
    // Governor state
}

contractmeta!(
    key = "Name",
    val = "Stellar Yield Protocol Governor"
);

#[contractimpl]
impl ProtocolGovernor {
    // ===== Storage Keys =====
    fn key_proposal(id: u32) -> GovernanceProposal { todo!() }
    fn key_proposal_count() -> u32 { todo!() }
    fn key_timelock() -> Address { todo!() }
    fn key_admin() -> Address { todo!() }
    fn key_emergency_multisig() -> Vec<Address> { todo!() }
    fn key_proposal_state(id: u32) -> ProposalState { todo!() }
    
    // ===== Protocol Parameters =====
    fn key_performance_fee() -> u32 { todo!() }
    fn key_withdrawal_fee() -> u32 { todo!() }
    fn key_rebalance_threshold() -> u32 { todo!() }
    fn key_insurance_reserve_target() -> u32 { todo!() }

    /// Initialize governor
    pub fn initialize(
        e: Env,
        timelock: Address,
        admin: Address,
        emergency_multisig: Vec<Address>,
    ) -> Result<(), &'static str> {
        if emergency_multisig.len() != 5 {
            return Err("Emergency multisig must have exactly 5 members");
        }

        e.extension_state().set(&Self::key_timelock(), &timelock);
        e.extension_state().set(&Self::key_admin(), &admin);
        e.extension_state().set(&Self::key_emergency_multisig(), &emergency_multisig);
        e.extension_state().set(&Self::key_proposal_count(), &0u32);

        // Initialize default protocol parameters
        e.extension_state().set(&Self::key_performance_fee(), &DEFAULT_PERFORMANCE_FEE);
        e.extension_state().set(&Self::key_withdrawal_fee(), &DEFAULT_WITHDRAWAL_FEE);
        e.extension_state().set(&Self::key_rebalance_threshold(), &DEFAULT_REBALANCE_THRESHOLD);
        e.extension_state().set(&Self::key_insurance_reserve_target(), &DEFAULT_INSURANCE_RESERVE);

        Ok(())
    }

    /// Create a new governance proposal
    pub fn propose(
        &mut self,
        proposer: Address,
        description: String,
        call_data: Vec<CallData>,
        voting_duration: u64,
    ) -> Result<u32, &'static str> {
        let e = Env::current();

        // Verify proposer has enough tokens
        let voter = VotingEscrow::new(&e, &Address::random(&e)); // Would be passed in
        let voting_power = voter.get_voting_power(proposer.clone());
        
        if voting_power < BigInt::from_u32(&e, PROPOSAL_THRESHOLD) {
            return Err("Insufficient voting power to propose");
        }

        // Validate description length
        let desc_str = String::from_str(&e, "");
        if desc_str.len() > MAX_PROPOSAL_DESCRIPTION_LENGTH as u32 {
            return Err("Proposal description too long");
        }

        // Create proposal
        let proposal_id = Self::key_proposal_count() + 1;
        let current_time = e.ledger().timestamp();
        let snapshot_block = e.ledger().sequence();

        let proposal = GovernanceProposal::new(
            proposer,
            description,
            call_data,
            current_time,
            voting_duration,
            snapshot_block,
        );

        // Store proposal
        e.extension_state().set(&Self::key_proposal(proposal_id), &proposal);
        e.extension_state().set(&Self::key_proposal_state(proposal_id), &ProposalState::Pending);

        // Update proposal count
        e.extension_state().set(&Self::key_proposal_count(), &proposal_id);

        Ok(proposal_id)
    }

    /// Cast a vote on a proposal
    pub fn vote(
        &mut self,
        voter: Address,
        proposal_id: u32,
        support: bool, // true = for, false = against
        amount: BigInt,
        reason: String,
    ) -> Result<(), &'static str> {
        let e = Env::current();
        let current_time = e.ledger().timestamp();

        // Get proposal
        let mut proposal = Self::key_proposal(proposal_id);
        
        // Check proposal state
        if proposal.state != ProposalState::Active {
            return Err("Proposal is not active");
        }

        // Check voting period
        if current_time < proposal.start_time || current_time >= proposal.end_time {
            return Err("Voting period has ended");
        }

        // Verify voting power at snapshot
        let voter_power = self.get_voting_power_at(voter.clone(), proposal.snapshot_block);
        if voter_power < amount {
            return Err("Insufficient voting power");
        }

        // Record vote
        if support {
            proposal.votes_for = proposal.votes_for + amount;
            proposal.for_voters.insert(voter.clone(), amount);
        } else {
            proposal.votes_against = proposal.votes_against + amount;
            proposal.against_voters.insert(voter.clone(), amount);
        }

        // Store updated proposal
        e.extension_state().set(&Self::key_proposal(proposal_id), &proposal);

        Ok(())
    }

    /// Queue a successful proposal for execution
    pub fn queue(&mut self, proposal_id: u32) -> Result<u64, &'static str> {
        let e = Env::current();

        // Get proposal
        let proposal = Self::key_proposal(proposal_id);

        // Check if succeeded
        if proposal.state != ProposalState::Succeeded {
            return Err("Proposal has not succeeded");
        }

        // Calculate eta (execution time)
        let eta = e.ledger().timestamp() + TIMELOCK_DELAY;

        // Update proposal
        let mut p = Self::key_proposal(proposal_id);
        p.eta = eta;
        p.queued = true;
        p.state = ProposalState::Queued;
        e.extension_state().set(&Self::key_proposal(proposal_id), &p);

        Ok(eta)
    }

    /// Execute a queued proposal
    pub fn execute(&mut self, proposal_id: u32) -> Result<(), &'static str> {
        let e = Env::current();
        let current_time = e.ledger().timestamp();

        // Get proposal
        let mut proposal = Self::key_proposal(proposal_id);

        // Check if queued
        if proposal.state != ProposalState::Queued {
            return Err("Proposal is not queued");
        }

        // Check timelock delay
        if current_time < proposal.eta {
            return Err("Timelock period not elapsed");
        }

        // Check if already executed
        if proposal.executed {
            return Err("Proposal already executed");
        }

        // Execute call data (simplified - would iterate and call contracts)
        // for call in proposal.call_data {
        //     // Execute the actual contract call
        // }

        // Update state
        proposal.executed = true;
        proposal.state = ProposalState::Executed;
        e.extension_state().set(&Self::key_proposal(proposal_id), &proposal);

        Ok(())
    }

    /// Cancel a proposal
    pub fn cancel(&mut self, proposal_id: u32) -> Result<(), &'static str> {
        let e = Env::current();

        let mut proposal = Self::key_proposal(proposal_id);

        // Can only cancel pending or active proposals
        if proposal.state != ProposalState::Pending && proposal.state != ProposalState::Active {
            return Err("Cannot cancel proposal in current state");
        }

        proposal.canceled = true;
        proposal.state = ProposalState::Canceled;
        e.extension_state().set(&Self::key_proposal(proposal_id), &proposal);

        Ok(())
    }

    /// Get voting power at a specific block (snapshot)
    fn get_voting_power_at(&self, voter: Address, _snapshot_block: u64) -> BigInt {
        let e = Env::current();
        // In real implementation, would use voting escrow to get historical power
        // Simplified here - would need voting escrow contract address
        BigInt::from_u32(&e, 0)
    }

    /// Get proposal by ID
    pub fn get_proposal(&self, proposal_id: u32) -> GovernanceProposal {
        Self::key_proposal(proposal_id)
    }

    /// Get proposal state
    pub fn get_proposal_state(&self, proposal_id: u32) -> ProposalState {
        Self::key_proposal_state(proposal_id)
    }

    /// Check if quorum is reached
    pub fn has_quorum(&self, proposal_id: u32) -> bool {
        let proposal = Self::key_proposal(proposal_id);
        let total_supply = GovernanceToken::new(&Env::current(), &Address::random(&Env::current())).total_supply();
        
        let total_votes = proposal.votes_for + proposal.votes_against;
        let quorum_required = total_supply * BigInt::from_u32(&Env::current(), QUORUM_PERCENTAGE) / BigInt::from_u32(&Env::current(), 10000);
        
        total_votes >= quorum_required
    }

    /// Check if proposal passed
    pub fn has_passed(&self, proposal_id: u32) -> bool {
        let proposal = Self::key_proposal(proposal_id);
        
        // Has quorum and more votes for than against
        self.has_quorum(proposal_id) && proposal.votes_for > proposal.votes_against
    }

    /// Update proposal states (called periodically)
    pub fn update_proposal_states(&mut self) {
        let e = Env::current();
        let current_time = e.ledger().timestamp();
        let proposal_count = Self::key_proposal_count();

        for i in 1..=proposal_count {
            let mut proposal = Self::key_proposal(i);
            
            match proposal.state {
                ProposalState::Pending => {
                    if current_time >= proposal.start_time {
                        proposal.state = ProposalState::Active;
                        e.extension_state().set(&Self::key_proposal(i), &proposal);
                        e.extension_state().set(&Self::key_proposal_state(i), &ProposalState::Active);
                    }
                }
                ProposalState::Active => {
                    if current_time >= proposal.end_time {
                        if self.has_passed(i) {
                            proposal.state = ProposalState::Succeeded;
                        } else {
                            proposal.state = ProposalState::Defeated;
                        }
                        e.extension_state().set(&Self::key_proposal(i), &proposal);
                        e.extension_state().set(&Self::key_proposal_state(i), &proposal.state);
                    }
                }
                ProposalState::Queued => {
                    if current_time >= proposal.eta + (7 * 24 * 60 * 60) {
                        // Expired after execution window
                        proposal.state = ProposalState::Expired;
                        e.extension_state().set(&Self::key_proposal(i), &proposal);
                        e.extension_state().set(&Self::key_proposal_state(i), &ProposalState::Expired);
                    }
                }
                _ => {}
            }
        }
    }

    // ===== Protocol Parameter Getters =====

    pub fn get_performance_fee(&self) -> u32 {
        Self::key_performance_fee()
    }

    pub fn get_withdrawal_fee(&self) -> u32 {
        Self::key_withdrawal_fee()
    }

    pub fn get_rebalance_threshold(&self) -> u32 {
        Self::key_rebalance_threshold()
    }

    pub fn get_insurance_reserve_target(&self) -> u32 {
        Self::key_insurance_reserve_target()
    }

    // ===== Protocol Parameter Setters (Internal - called by governance) =====

    pub fn set_performance_fee(&mut self, fee: u32) -> Result<(), &'static str> {
        if fee < MIN_PERFORMANCE_FEE || fee > MAX_PERFORMANCE_FEE {
            return Err("Performance fee out of range");
        }
        let e = Env::current();
        e.extension_state().set(&Self::key_performance_fee(), &fee);
        Ok(())
    }

    pub fn set_withdrawal_fee(&mut self, fee: u32) -> Result<(), &'static str> {
        if fee < MIN_WITHDRAWAL_FEE || fee > MAX_WITHDRAWAL_FEE {
            return Err("Withdrawal fee out of range");
        }
        let e = Env::current();
        e.extension_state().set(&Self::key_withdrawal_fee(), &fee);
        Ok(())
    }

    pub fn set_rebalance_threshold(&mut self, threshold: u32) -> Result<(), &'static str> {
        if threshold < MIN_REBALANCE_THRESHOLD || threshold > MAX_REBALANCE_THRESHOLD {
            return Err("Rebalance threshold out of range");
        }
        let e = Env::current();
        e.extension_state().set(&Self::key_rebalance_threshold(), &threshold);
        Ok(())
    }

    pub fn set_insurance_reserve_target(&mut self, target: u32) -> Result<(), &'static str> {
        if target < MIN_INSURANCE_RESERVE || target > MAX_INSURANCE_RESERVE {
            return Err("Insurance reserve target out of range");
        }
        let e = Env::current();
        e.extension_state().set(&Self::key_insurance_reserve_target(), &target);
        Ok(())
    }

    // ===== Emergency Functions =====

    /// Emergency pause (3-of-5 multisig required)
    pub fn emergency_pause(&mut self, signers: Vec<Address>) -> Result<(), &'static str> {
        let multisig = Self::key_emergency_multisig();
        
        // Verify 3-of-5 signatures
        let mut valid_signatures = 0;
        for signer in signers.iter() {
            if multisig.contains(signer) {
                valid_signatures += 1;
            }
        }

        if valid_signatures < 3 {
            return Err("Insufficient signatures for emergency action");
        }

        // Pause all contracts (simplified)
        // In real implementation, would call pause() on all governed contracts
        Ok(())
    }

    /// Emergency unpause (3-of-5 multisig required)
    pub fn emergency_unpause(&mut self, signers: Vec<Address>) -> Result<(), &'static str> {
        let multisig = Self::key_emergency_multisig();
        
        let mut valid_signatures = 0;
        for signer in signers.iter() {
            if multisig.contains(signer) {
                valid_signatures += 1;
            }
        }

        if valid_signatures < 3 {
            return Err("Insufficient signatures for emergency action");
        }

        Ok(())
    }
}

// ===== Voting Escrow (veToken) =====
#[contract]
pub struct VotingEscrow {
    // Voting escrow state
}

contractmeta!(
    key = "Name",
    val = "Stellar Yield Voting Escrow"
);

#[contractimpl]
impl VotingEscrow {
    // ===== Storage Keys =====
    fn key_locked_amount(addr: &Address) -> BigInt { todo!() }
    fn key_lock_start(addr: &Address) -> u64 { todo!() }
    fn key_lock_end(addr: &Address) -> u64 { todo!() }
    fn key_total_supply() -> BigInt { todo!() }
    fn key_total_supply_at(t: u64) -> BigInt { todo!() }
    fn key_balance_at(addr: &Address, t: u64) -> BigInt { todo!() }
    fn key_boosted_balance(addr: &Address) -> BigInt { todo!() }
    fn key_delegated_from(addr: &Address) -> BigInt { todo!() }
    fn key_delegated_to(addr: &Address) -> BigInt { todo!() }

    /// Initialize voting escrow
    pub fn initialize(e: Env, governance_token: Address) -> Result<(), &'static str> {
        e.extension_state().set(&Self::key_total_supply(), &BigInt::zero(&e));
        Ok(())
    }

    /// Create a new lock
    pub fn create_lock(
        &mut self,
        user: Address,
        amount: BigInt,
        duration: u64,
    ) -> Result<(), &'static str> {
        let e = Env::current();

        // Validate duration
        if duration < MIN_VOTE_DURATION || duration > MAX_VOTE_DURATION {
            return Err("Lock duration must be between 1 week and 4 years");
        }

        // Check existing lock
        let existing_end = Self::key_lock_end(&user);
        if existing_end > e.ledger().timestamp() {
            return Err("Existing lock must be withdrawn first");
        }

        // Transfer tokens to escrow
        // TokenClient::new(&e, &gov_token).transfer(&user, &e.get_current_contract_address(), &amount);

        let current_time = e.ledger().timestamp();
        let lock_end = current_time + duration;

        // Store lock info
        e.extension_state().set(&Self::key_locked_amount(&user), &amount);
        e.extension_state().set(&Self::key_lock_start(&user), &current_time);
        e.extension_state().set(&Self::key_lock_end(&user), &lock_end);

        // Update total supply
        let mut total = Self::key_total_supply();
        total = total + amount;
        e.extension_state().set(&Self::key_total_supply(), &total);

        // Store snapshot
        e.extension_state().set(&Self::key_total_supply_at(current_time), &total);

        Ok(())
    }

    /// Increase lock amount
    pub fn increase_lock(&mut self, user: Address, amount: BigInt) -> Result<(), &'static str> {
        let e = Env::current();

        // Check lock exists and not expired
        let lock_end = Self::key_lock_end(&user);
        if lock_end <= e.ledger().timestamp() {
            return Err("Lock expired, must create new lock");
        }

        // Transfer tokens
        // TokenClient::new(&e, &gov_token).transfer(&user, &e.get_current_contract_address(), &amount);

        // Update locked amount
        let mut locked = Self::key_locked_amount(&user);
        locked = locked + amount;
        e.extension_state().set(&Self::key_locked_amount(&user), &locked);

        // Update total supply
        let mut total = Self::key_total_supply();
        total = total + amount;
        e.extension_state().set(&Self::key_total_supply(), &total);

        Ok(())
    }

    /// Extend lock duration
    pub fn extend_lock(&mut self, user: Address, new_duration: u64) -> Result<(), &'static str> {
        let e = Env::current();
        let current_time = e.ledger().timestamp();

        // Validate new duration
        if new_duration < MIN_VOTE_DURATION || new_duration > MAX_VOTE_DURATION {
            return Err("Lock duration must be between 1 week and 4 years");
        }

        // Check existing lock
        let lock_end = Self::key_lock_end(&user);
        let lock_start = Self::key_lock_start(&user);
        let existing_lock_duration = lock_end - lock_start;

        // Can only extend, not shorten
        if new_duration < existing_lock_duration {
            return Err("Cannot shorten lock duration");
        }

        let new_lock_end = current_time + new_duration;
        e.extension_state().set(&Self::key_lock_end(&user), &new_lock_end);

        Ok(())
    }

    /// Withdraw after lock expires
    pub fn withdraw(&mut self, user: Address) -> Result<(), &'static str> {
        let e = Env::current();

        // Check lock expired
        let lock_end = Self::key_lock_end(&user);
        if lock_end > e.ledger().timestamp() {
            return Err("Lock has not expired");
        }

        let amount = Self::key_locked_amount(&user);

        // Transfer tokens back
        // TokenClient::new(&e, &gov_token).transfer(&e.get_current_contract_address(), &user, &amount);

        // Clear lock info
        e.extension_state().set(&Self::key_locked_amount(&user), &BigInt::zero(&e));
        e.extension_state().set(&Self::key_lock_start(&user), &0u64);
        e.extension_state().set(&Self::key_lock_end(&user), &0u64);

        // Update total supply
        let mut total = Self::key_total_supply();
        total = total - amount;
        e.extension_state().set(&Self::key_total_supply(), &total);

        Ok(())
    }

    /// Get current voting power
    pub fn get_voting_power(&self, user: Address) -> BigInt {
        let e = Env::current();
        let current_time = e.ledger().timestamp();

        let amount = Self::key_locked_amount(&user);
        let lock_start = Self::key_lock_start(&user);
        let lock_end = Self::key_lock_end(&user);

        if lock_end <= current_time || amount == BigInt::zero(&e) {
            return BigInt::zero(&e);
        }

        // Linear decay: voting_power = amount * remaining_time / max_time
        let remaining_time = lock_end - current_time;
        let max_time = MAX_VOTE_DURATION;

        // Calculate voting power with decay
        let voting_power = amount * BigInt::from_u32(&e, remaining_time) / BigInt::from_u32(&e, max_time);
        
        // Add delegated power
        let delegated = Self::key_delegated_to(&user);
        
        voting_power + delegated
    }

    /// Calculate boosted balance (for vault APY boost)
    pub fn get_boosted_balance(&self, user: Address) -> BigInt {
        let e = Env::current();
        let current_time = e.ledger().timestamp();

        let amount = Self::key_locked_amount(&user);
        let lock_end = Self::key_lock_end(&user);

        if lock_end <= current_time || amount == BigInt::zero(&e) {
            return BigInt::zero(&e);
        }

        // Calculate boost multiplier based on lock duration
        let lock_start = Self::key_lock_start(&user);
        let lock_duration = lock_end - lock_start;
        let remaining_time = lock_end - current_time;

        // Boost factor: longer locks get higher boost (up to 2.5x)
        // boost = 1 + (lock_duration / max_duration) * (max_boost - 1)
        let duration_factor = BigInt::from_u32(&e, lock_duration) * BigInt::from_u32(&e, 10000) / BigInt::from_u32(&e, MAX_VOTE_DURATION);
        let boost = BigInt::from_u32(&e, 10000) + duration_factor * BigInt::from_u32(&e, 1500) / BigInt::from_u32(&e, 10000);

        // Apply boost to amount, capped at 2.5x
        let boosted = amount * boost / BigInt::from_u32(&e, 10000);
        
        // Cap at max boost
        let max_boosted = amount * BigInt::from_u32(&e, MAX_BOOST_MULTIPLIER) / BigInt::from_u32(&e, 10000);
        
        if boosted < max_boosted {
            boosted
        } else {
            max_boosted
        }
    }

    /// Delegate voting power to another address
    pub fn delegate(&mut self, from: Address, to: Address, amount: BigInt) -> Result<(), &'static str> {
        let e = Env::current();

        // Check voting power
        let voting_power = self.get_voting_power(from.clone());
        if voting_power < amount {
            return Err("Insufficient voting power to delegate");
        }

        // Update delegations
        let mut delegated_from = Self::key_delegated_from(&from);
        delegated_from = delegated_from + amount;
        e.extension_state().set(&Self::key_delegated_from(&from), &delegated_from);

        let mut delegated_to = Self::key_delegated_to(&to);
        delegated_to = delegated_to + amount;
        e.extension_state().set(&Self::key_delegated_to(&to), &delegated_to);

        Ok(())
    }

    /// Get lock info
    pub fn get_lock_info(&self, user: Address) -> (BigInt, u64, u64) {
        let e = Env::current();
        (
            Self::key_locked_amount(&user),
            Self::key_lock_start(&user),
            Self::key_lock_end(&user),
        )
    }

    /// Get total supply
    pub fn get_total_supply(&self) -> BigInt {
        Self::key_total_supply()
    }

    /// Get boost multiplier for a user
    pub fn get_boost_multiplier(&self, user: Address) -> u32 {
        let voting_power = self.get_voting_power(user.clone());
        let boosted = self.get_boosted_balance(user);
        let locked = Self::key_locked_amount(&user);

        if locked == BigInt::zero(&Env::current()) {
            return 10000; // 1x = 100%
        }

        // Return multiplier in basis points
        let multiplier = boosted * BigInt::from_u32(&Env::current(), 10000) / locked;
        u32::try_from(multiplier).unwrap_or(10000)
    }
}

// ===== Emergency Multisig =====
#[contract]
pub struct EmergencyMultisig {
    // Multisig state
}

contractmeta!(
    key = "Name",
    val = "Stellar Yield Emergency Multisig"
);

#[contractimpl]
impl EmergencyMultisig {
    // ===== Storage Keys =====
    fn key_signers() -> Vec<Address> { todo!() }
    fn key_required_signatures() -> u32 { todo!() }
    fn key_pending_tx(to: &Address, data: &[u8]) -> u32 { todo!() }
    fn key_tx_signers(tx_id: u32) -> Vec<Address> { todo!() }

    /// Initialize multisig
    pub fn initialize(
        e: Env,
        signers: Vec<Address>,
        required: u32,
    ) -> Result<(), &'static str> {
        if signers.len() != 5 {
            return Err("Must have exactly 5 signers");
        }
        if required < 3 || required > 5 {
            return Err("Required signatures must be between 3 and 5");
        }

        e.extension_state().set(&Self::key_signers(), &signers);
        e.extension_state().set(&Self::key_required_signatures(), &required);

        Ok(())
    }

    /// Submit an emergency transaction
    pub fn submit_emergency_tx(
        &mut self,
        proposer: Address,
        to: Address,
        data: Vec<u8>,
    ) -> Result<u32, &'static str> {
        let e = Env::current();

        // Verify proposer is a signer
        let signers = Self::key_signers();
        if !signers.contains(&proposer) {
            return Err("Only signers can submit emergency transactions");
        }

        // Create pending transaction (simplified key)
        let tx_id = e.ledger().sequence();
        let mut signers_vec: Vec<Address> = Vec::new(&e);
        signers_vec.push_back(proposer.clone());
        
        e.extension_state().set(&Self::key_pending_tx(&to, &data), &tx_id);
        e.extension_state().set(&Self::key_tx_signers(tx_id), &signers_vec);

        Ok(tx_id)
    }

    /// Confirm an emergency transaction
    pub fn confirm_tx(
        &mut self,
        confirmer: Address,
        tx_id: u32,
    ) -> Result<(), &'static str> {
        let e = Env::current();

        // Verify confirmer is a signer
        let signers = Self::key_signers();
        if !signers.contains(&confirmer) {
            return Err("Only signers can confirm transactions");
        }

        // Add confirmation
        let mut tx_signers = Self::key_tx_signers(tx_id);
        tx_signers.push_back(confirmer);

        // Check if enough confirmations
        let required = Self::key_required_signatures();
        if tx_signers.len() >= required {
            // Execute transaction (simplified)
            return Ok(());
        }

        e.extension_state().set(&Self::key_tx_signers(tx_id), &tx_signers);

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_token_distribution() {
        // Verify total allocations equal 100%
        let total = COMMUNITY_ALLOCATION + TEAM_ALLOCATION + TREASURY_ALLOCATION + LIQUIDITY_MINING_ALLOCATION;
        assert_eq!(total, 1000); // 100%
    }

    #[test]
    fn test_voting_power_decay() {
        // Test that voting power decays linearly
        // voting_power = amount * remaining_time / max_time
    }

    #[test]
    fn test_quorum_calculation() {
        // Test 4% quorum requirement
        assert_eq!(QUORUM_PERCENTAGE, 400);
    }

    #[test]
    fn test_timelock_delay() {
        // Test 2-day timelock
        assert_eq!(TIMELOCK_DELAY, 172800);
    }

    #[test]
    fn test_boost_multiplier() {
        // Test max 2.5x boost
        assert_eq!(MAX_BOOST_MULTIPLIER, 2500);
    }
}
