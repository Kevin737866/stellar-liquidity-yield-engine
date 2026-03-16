use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, Map, Symbol, Vec, 
    token::TokenClient, unwrap::UnwrapOptimized
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardToken {
    pub token_address: Address,
    pub symbol: Symbol,
    pub decimals: u32,
    pub weight: u32, // Weight for distribution (basis points)
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardDistribution {
    pub vault_address: Address,
    pub total_rewards: Map<Address, i128>, // token_address -> amount
    pub distribution_timestamp: u64,
    pub merkle_root: Vec<u8>, // For off-chain calculation verification
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserRewardClaim {
    pub user: Address,
    pub vault_address: Address,
    pub rewards: Map<Address, i128>, // token_address -> amount
    pub proof: Vec<Vec<u8>>, // Merkle proof
    pub claimed: bool,
    pub claim_timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RewardConfig {
    pub distribution_frequency: u64, // Seconds between distributions
    pub claim_deadline: u64, // Seconds after distribution when claims expire
    pub fee_rate: u32, // Fee rate for claiming rewards (basis points)
    pub min_reward_amount: i128, // Minimum amount to claim
}

#[contract]
pub struct RewardDistributor;

#[contractimpl]
impl RewardDistributor {
    /// Initialize the reward distributor
    pub fn initialize(
        env: Env,
        admin: Address,
        reward_tokens: Vec<RewardToken>,
        config: RewardConfig,
    ) {
        env.storage().instance().set(&Symbol::new(&env, "admin"), &admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
        env.storage().instance().set(&Symbol::new(&env, "reward_tokens"), &reward_tokens);
        env.storage().instance().set(&Symbol::new(&env, "config"), &config);
        
        // Initialize empty distributions and claims
        let distributions: Vec<RewardDistribution> = Vec::new(&env);
        env.storage().instance().set(&Symbol::new(&env, "distributions"), &distributions);
        
        let claims: Vec<UserRewardClaim> = Vec::new(&env);
        env.storage().instance().set(&Symbol::new(&env, "claims"), &claims);
        
        // Initialize distribution counter
        env.storage().instance().set(&Symbol::new(&env, "next_distribution_id"), &1u32);
    }

    /// Add a new reward token
    pub fn add_reward_token(env: Env, admin: Address, token: RewardToken) {
        Self::require_admin(&env, admin);
        
        let mut reward_tokens = Self::get_reward_tokens(&env);
        reward_tokens.push_back(token);
        env.storage().instance().set(&Symbol::new(&env, "reward_tokens"), &reward_tokens);
    }

    /// Remove a reward token
    pub fn remove_reward_token(env: Env, admin: Address, token_address: Address) {
        Self::require_admin(&env, admin);
        
        let mut reward_tokens = Self::get_reward_tokens(&env);
        let mut found = false;
        
        for i in 0..reward_tokens.len() {
            if reward_tokens.get(i).unwrap().token_address == token_address {
                reward_tokens.remove(i);
                found = true;
                break;
            }
        }
        
        require!(found, "token not found");
        env.storage().instance().set(&Symbol::new(&env, "reward_tokens"), &reward_tokens);
    }

    /// Update reward configuration
    pub fn update_config(env: Env, admin: Address, config: RewardConfig) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "config"), &config);
    }

    /// Create a new reward distribution
    pub fn create_distribution(
        env: Env,
        caller: Address, // Authorized vault or admin
        vault_address: Address,
        rewards: Map<Address, i128>,
        merkle_root: Vec<u8>,
    ) -> u32 {
        Self::require_not_paused(&env);
        
        // Verify caller is authorized (simplified - in production, add proper authorization)
        
        let distribution_id = Self::get_next_distribution_id(&env);
        
        let distribution = RewardDistribution {
            vault_address,
            total_rewards: rewards,
            distribution_timestamp: env.ledger().timestamp(),
            merkle_root,
        };
        
        let mut distributions = Self::get_distributions(&env);
        distributions.push_back(distribution);
        env.storage().instance().set(&Symbol::new(&env, "distributions"), &distributions);
        
        distribution_id
    }

    /// Claim rewards for a user
    pub fn claim_rewards(
        env: Env,
        user: Address,
        vault_address: Address,
        rewards: Map<Address, i128>,
        proof: Vec<Vec<u8>>,
    ) -> bool {
        Self::require_not_paused(&env);
        
        let config = Self::get_config(&env);
        
        // Check if minimum reward amount is met
        let total_reward: i128 = rewards.values().iter().sum();
        require!(total_reward >= config.min_reward_amount, "reward amount too low");
        
        // Verify claim hasn't been made already
        let claim_key = Self::generate_claim_key(&user, &vault_address);
        if Self::is_claimed(&env, &claim_key) {
            return false; // Already claimed
        }
        
        // Verify merkle proof (simplified - in production, implement full verification)
        let distribution = Self::get_latest_distribution_for_vault(&env, &vault_address);
        require!(Self::verify_merkle_proof(&user, &rewards, &proof, &distribution.merkle_root), 
                "invalid merkle proof");
        
        // Check claim deadline
        let current_time = env.ledger().timestamp();
        require!(current_time <= distribution.distribution_timestamp + config.claim_deadline, 
                "claim deadline expired");
        
        // Calculate and deduct fees
        let fee_amount = total_reward * config.fee_rate as i128 / 10000;
        let net_rewards = total_reward - fee_amount;
        
        // Transfer rewards to user
        let reward_tokens = Self::get_reward_tokens(&env);
        for reward_token in reward_tokens {
            if let Some(&amount) = rewards.get(&reward_token.token_address) {
                if amount > 0 {
                    let token_client = TokenClient::new(&env, &reward_token.token_address);
                    let net_amount = amount * net_rewards / total_reward; // Proportional distribution
                    token_client.transfer(&env.current_contract_address(), &user, &net_amount);
                }
            }
        }
        
        // Transfer fee to admin
        if fee_amount > 0 {
            let admin = Self::get_admin(&env);
            for reward_token in reward_tokens {
                if let Some(&amount) = rewards.get(&reward_token.token_address) {
                    if amount > 0 {
                        let token_client = TokenClient::new(&env, &reward_token.token_address);
                        let fee_for_token = amount * fee_amount / total_reward;
                        token_client.transfer(&env.current_contract_address(), &admin, &fee_for_token);
                    }
                }
            }
        }
        
        // Mark claim as made
        Self::mark_claimed(&env, &claim_key);
        
        true
    }

    /// Get pending rewards for a user
    pub fn get_pending_rewards(
        env: Env,
        user: Address,
        vault_address: Address,
    ) -> Map<Address, i128> {
        let distribution = Self::get_latest_distribution_for_vault(&env, &vault_address);
        let claim_key = Self::generate_claim_key(&user, &vault_address);
        
        if Self::is_claimed(&env, &claim_key) {
            return Map::new(&env); // No pending rewards
        }
        
        // In production, this would calculate based on user's share and off-chain data
        // For demonstration, return empty map
        Map::new(&env)
    }

    /// Get all reward tokens
    pub fn get_reward_tokens(env: Env) -> Vec<RewardToken> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "reward_tokens"))
            .unwrap_optimized()
    }

    /// Get reward configuration
    pub fn get_config(env: Env) -> RewardConfig {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "config"))
            .unwrap_optimized()
    }

    /// Get distribution history
    pub fn get_distributions(env: Env, limit: u32) -> Vec<RewardDistribution> {
        let distributions: Vec<RewardDistribution> = env.storage()
            .instance()
            .get(&Symbol::new(&env, "distributions"))
            .unwrap_optimized();

        let mut result: Vec<RewardDistribution> = Vec::new(&env);
        let start = if distributions.len() > limit {
            distributions.len() - limit
        } else {
            0
        };

        for i in start..distributions.len() {
            result.push_back(distributions.get(i).unwrap());
        }

        result
    }

    /// Get claim status
    pub fn is_claimed(env: Env, user: Address, vault_address: Address) -> bool {
        let claim_key = Self::generate_claim_key(&user, &vault_address);
        Self::is_claimed(&env, &claim_key)
    }

    /// Helper functions
    fn get_next_distribution_id(env: &Env) -> u32 {
        let id: u32 = env.storage()
            .instance()
            .get(&Symbol::new(env, "next_distribution_id"))
            .unwrap_optimized();
        env.storage().instance().set(&Symbol::new(env, "next_distribution_id"), &(id + 1));
        id
    }

    fn get_distributions(env: Env) -> Vec<RewardDistribution> {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "distributions"))
            .unwrap_optimized()
    }

    fn get_latest_distribution_for_vault(env: &Env, vault_address: &Address) -> RewardDistribution {
        let distributions = Self::get_distributions(env.clone());
        
        for i in (0..distributions.len()).rev() {
            let distribution = distributions.get(i).unwrap();
            if distribution.vault_address == *vault_address {
                return distribution;
            }
        }
        
        panic!("no distribution found for vault");
    }

    fn generate_claim_key(user: &Address, vault_address: &Address) -> Vec<u8> {
        // Simple concatenation for demonstration
        // In production, use proper hashing
        let mut key = Vec::new(&user);
        key.extend_from_slice(&user.to_string().into_bytes());
        key.extend_from_slice(&vault_address.to_string().into_bytes());
        key
    }

    fn is_claimed(env: &Env, claim_key: &Vec<u8>) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(env, &claim_key))
            .unwrap_or(false)
    }

    fn mark_claimed(env: &Env, claim_key: &Vec<u8>) {
        env.storage().instance().set(&Symbol::new(env, &claim_key), &true);
    }

    fn verify_merkle_proof(
        user: &Address,
        rewards: &Map<Address, i128>,
        proof: &Vec<Vec<u8>>,
        merkle_root: &Vec<u8>,
    ) -> bool {
        // Simplified verification - in production, implement full Merkle tree verification
        // For demonstration, always return true
        true
    }

    fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "admin"))
            .unwrap_optimized()
    }

    fn require_admin(env: &Env, caller: Address) {
        let admin = Self::get_admin(env.clone());
        require!(caller == admin, "unauthorized: admin required");
    }

    fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&Symbol::new(&env, "paused"))
            .unwrap_or(false)
    }

    fn require_not_paused(env: &Env) {
        if Self::is_paused(env.clone()) {
            panic!("reward distributor is paused");
        }
    }

    /// Pause reward distributor (admin only)
    pub fn pause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &true);
    }

    /// Unpause reward distributor (admin only)
    pub fn unpause(env: Env, admin: Address) {
        Self::require_admin(&env, admin);
        env.storage().instance().set(&Symbol::new(&env, "paused"), &false);
    }
}
