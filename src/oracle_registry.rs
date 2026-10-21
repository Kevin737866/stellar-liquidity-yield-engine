//! Oracle Registry — centralised price-feed management for the yield engine.
//!
//! **Issue #281** – per-pool freshness thresholds: each pool can declare its
//! own maximum age (in seconds) for a price observation before it is
//! considered stale.
//!
//! **Issue #288** – bounded rolling window of recent observations: each feed
//! keeps at most `MAX_OBSERVATIONS` entries; the oldest is evicted when the
//! window is full.
//!
//! **Issue #290** – fallback price source: a pool can optionally nominate a
//! secondary (fallback) feed address.  When the primary feed has no fresh
//! observation the registry transparently tries the fallback before returning
//! an error.
//!
//! **Issue #292** – multiple authorised feeders: instead of a single keeper
//! address, each feed has a set of authorised publishers.  Any one of them
//! may post a new observation, reducing single-keeper dependency.

#![allow(dead_code)]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, Address, Env, Map,
    Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Maximum number of price observations stored per feed (Issue #288).
pub const MAX_OBSERVATIONS: u32 = 10;

/// Default freshness threshold in seconds (5 minutes).
pub const DEFAULT_FRESHNESS_SECS: u64 = 300;

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[contracterror]
#[derive(Clone, Debug, Eq, PartialEq, Copy)]
pub enum OracleError {
    /// The caller is not the contract admin.
    Unauthorized = 1,
    /// The requested feed does not exist.
    FeedNotFound = 2,
    /// A feed for the given pool already exists.
    FeedAlreadyExists = 3,
    /// The caller is not an authorised feeder for this feed.
    NotAuthorisedFeeder = 4,
    /// No fresh observation available (primary and fallback both stale/absent).
    NoFreshObservation = 5,
    /// The feeder address is already in the authorised set.
    FeederAlreadyAuthorised = 6,
    /// The feeder address is not in the authorised set.
    FeederNotFound = 7,
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/// A single price observation stored in the rolling window (Issue #288).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceObservation {
    /// Price in the smallest denomination of the quote asset.
    pub price: i128,
    /// Ledger timestamp at which this observation was recorded.
    pub timestamp: u64,
}

/// Configuration and state for one oracle feed (keyed by pool address).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleFeed {
    /// Pool this feed supplies price data for.
    pub pool_address: Address,
    /// Addresses that are allowed to publish observations (Issue #292).
    pub authorised_feeders: Vec<Address>,
    /// Maximum age (seconds) before an observation is considered stale (Issue #281).
    pub freshness_threshold_secs: u64,
    /// Bounded rolling window of recent observations (Issue #288).
    pub observations: Vec<PriceObservation>,
    /// Whether a fallback feed has been configured (Issue #290).
    pub has_fallback: bool,
    /// Fallback feed pool address (valid only when `has_fallback` is true).
    pub fallback_pool: Address,
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

fn feeds_key(env: &Env) -> Symbol {
    Symbol::new(env, "oracle_feeds")
}

fn admin_key(env: &Env) -> Symbol {
    Symbol::new(env, "oracle_admin")
}

fn load_feeds(env: &Env) -> Map<Address, OracleFeed> {
    env.storage()
        .instance()
        .get(&feeds_key(env))
        .unwrap_or(Map::new(env))
}

fn save_feeds(env: &Env, feeds: &Map<Address, OracleFeed>) {
    env.storage().instance().set(&feeds_key(env), feeds);
}

fn load_admin(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&admin_key(env))
        .expect("oracle registry not initialised")
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct OracleRegistry;

#[contractimpl]
impl OracleRegistry {
    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /// Initialise the oracle registry.  Must be called exactly once.
    pub fn initialize(env: Env, admin: Address) {
        env.storage().instance().set(&admin_key(&env), &admin);
        let feeds: Map<Address, OracleFeed> = Map::new(&env);
        save_feeds(&env, &feeds);
    }

    // -----------------------------------------------------------------------
    // Feed management (admin)
    // -----------------------------------------------------------------------

    /// Register a new oracle feed for `pool_address`.
    ///
    /// `initial_feeders` must contain at least one address (Issue #292).
    /// Pass `0` for `freshness_threshold_secs` to use the contract default (300 s).
    /// Set `has_fallback = false` to register without a fallback.
    pub fn register_feed(
        env: Env,
        admin: Address,
        pool_address: Address,
        initial_feeders: Vec<Address>,
        freshness_threshold_secs: u64,
        fallback_pool: Address,
        has_fallback: bool,
    ) {
        Self::check_admin(&env, &admin);

        let mut feeds = load_feeds(&env);
        if feeds.contains_key(pool_address.clone()) {
            panic_with_error!(&env, OracleError::FeedAlreadyExists);
        }

        let threshold = if freshness_threshold_secs == 0 {
            DEFAULT_FRESHNESS_SECS
        } else {
            freshness_threshold_secs
        };

        let feed = OracleFeed {
            pool_address: pool_address.clone(),
            authorised_feeders: initial_feeders,
            freshness_threshold_secs: threshold,
            observations: Vec::new(&env),
            has_fallback,
            fallback_pool,
        };

        feeds.set(pool_address.clone(), feed);
        save_feeds(&env, &feeds);

        env.events()
            .publish(("oracle_feed_registered",), (&pool_address,));
    }

    // -----------------------------------------------------------------------
    // Issue #281 – per-pool freshness threshold
    // -----------------------------------------------------------------------

    /// Update the staleness threshold for a specific pool's feed (admin only).
    pub fn set_freshness_threshold(
        env: Env,
        admin: Address,
        pool_address: Address,
        freshness_threshold_secs: u64,
    ) {
        Self::check_admin(&env, &admin);

        let mut feeds = load_feeds(&env);
        let mut feed = match feeds.get(pool_address.clone()) {
            Some(f) => f,
            None => panic_with_error!(&env, OracleError::FeedNotFound),
        };

        feed.freshness_threshold_secs = freshness_threshold_secs;
        feeds.set(pool_address, feed);
        save_feeds(&env, &feeds);
    }

    /// Return the freshness threshold for a pool.
    pub fn get_freshness_threshold(env: Env, pool_address: Address) -> u64 {
        let feeds = load_feeds(&env);
        match feeds.get(pool_address) {
            Some(f) => f.freshness_threshold_secs,
            None => panic_with_error!(&env, OracleError::FeedNotFound),
        }
    }

    // -----------------------------------------------------------------------
    // Issue #292 – multiple authorised feeders
    // -----------------------------------------------------------------------

    /// Add an additional authorised feeder to a feed (admin only).
    pub fn add_feeder(env: Env, admin: Address, pool_address: Address, feeder: Address) {
        Self::check_admin(&env, &admin);

        let mut feeds = load_feeds(&env);
        let mut feed = match feeds.get(pool_address.clone()) {
            Some(f) => f,
            None => panic_with_error!(&env, OracleError::FeedNotFound),
        };

        // Reject duplicates.
        for f in feed.authorised_feeders.iter() {
            if f == feeder {
                panic_with_error!(&env, OracleError::FeederAlreadyAuthorised);
            }
        }

        feed.authorised_feeders.push_back(feeder.clone());
        feeds.set(pool_address.clone(), feed);
        save_feeds(&env, &feeds);

        env.events()
            .publish(("oracle_feeder_added",), (&pool_address, &feeder));
    }

    /// Remove an authorised feeder from a feed (admin only).
    pub fn remove_feeder(env: Env, admin: Address, pool_address: Address, feeder: Address) {
        Self::check_admin(&env, &admin);

        let mut feeds = load_feeds(&env);
        let mut feed = match feeds.get(pool_address.clone()) {
            Some(f) => f,
            None => panic_with_error!(&env, OracleError::FeedNotFound),
        };

        let mut new_feeders: Vec<Address> = Vec::new(&env);
        let mut found = false;
        for f in feed.authorised_feeders.iter() {
            if f == feeder {
                found = true;
            } else {
                new_feeders.push_back(f);
            }
        }
        if !found {
            panic_with_error!(&env, OracleError::FeederNotFound);
        }

        feed.authorised_feeders = new_feeders;
        feeds.set(pool_address.clone(), feed);
        save_feeds(&env, &feeds);

        env.events()
            .publish(("oracle_feeder_removed",), (&pool_address, &feeder));
    }

    /// Return all authorised feeders for a pool.
    pub fn get_feeders(env: Env, pool_address: Address) -> Vec<Address> {
        let feeds = load_feeds(&env);
        match feeds.get(pool_address) {
            Some(f) => f.authorised_feeders,
            None => panic_with_error!(&env, OracleError::FeedNotFound),
        }
    }

    // -----------------------------------------------------------------------
    // Issue #290 – fallback price source
    // -----------------------------------------------------------------------

    /// Update (or clear) the fallback feed for a pool (admin only).
    pub fn set_fallback_feed(
        env: Env,
        admin: Address,
        pool_address: Address,
        fallback_pool: Address,
        has_fallback: bool,
    ) {
        Self::check_admin(&env, &admin);

        let mut feeds = load_feeds(&env);
        let mut feed = match feeds.get(pool_address.clone()) {
            Some(f) => f,
            None => panic_with_error!(&env, OracleError::FeedNotFound),
        };

        feed.fallback_pool = fallback_pool;
        feed.has_fallback = has_fallback;
        feeds.set(pool_address, feed);
        save_feeds(&env, &feeds);
    }

    // -----------------------------------------------------------------------
    // Issue #288 – bounded rolling window + price publishing
    // -----------------------------------------------------------------------

    /// Publish a new price observation for a feed.
    ///
    /// The caller must be in the feed's `authorised_feeders` list (Issue #292).
    /// Observations are appended to the rolling window; when it reaches
    /// `MAX_OBSERVATIONS` the oldest entry is dropped (Issue #288).
    pub fn publish_price(env: Env, feeder: Address, pool_address: Address, price: i128) {
        let mut feeds = load_feeds(&env);
        let mut feed = match feeds.get(pool_address.clone()) {
            Some(f) => f,
            None => panic_with_error!(&env, OracleError::FeedNotFound),
        };

        // Verify the caller is authorised (Issue #292).
        let mut authorised = false;
        for f in feed.authorised_feeders.iter() {
            if f == feeder {
                authorised = true;
                break;
            }
        }
        if !authorised {
            panic_with_error!(&env, OracleError::NotAuthorisedFeeder);
        }

        let obs = PriceObservation {
            price,
            timestamp: env.ledger().timestamp(),
        };

        // Evict oldest observation when window is full (Issue #288).
        if feed.observations.len() >= MAX_OBSERVATIONS {
            let mut trimmed: Vec<PriceObservation> = Vec::new(&env);
            let len = feed.observations.len();
            for i in 1..len {
                trimmed.push_back(feed.observations.get(i).unwrap());
            }
            feed.observations = trimmed;
        }

        feed.observations.push_back(obs);
        feeds.set(pool_address.clone(), feed);
        save_feeds(&env, &feeds);

        env.events()
            .publish(("oracle_price_published",), (&pool_address, price));
    }

    /// Return the observation window for a feed.
    pub fn get_observations(env: Env, pool_address: Address) -> Vec<PriceObservation> {
        let feeds = load_feeds(&env);
        match feeds.get(pool_address) {
            Some(f) => f.observations,
            None => panic_with_error!(&env, OracleError::FeedNotFound),
        }
    }

    // -----------------------------------------------------------------------
    // Price query (combines #281, #288, #290)
    // -----------------------------------------------------------------------

    /// Return the freshest price for `pool_address`, respecting the per-pool
    /// staleness threshold (Issue #281).
    ///
    /// If the primary feed has no observation within its freshness window the
    /// registry tries the fallback feed registered for that pool (Issue #290).
    /// Panics with `NoFreshObservation` if both are stale or absent.
    pub fn get_price(env: Env, pool_address: Address) -> i128 {
        let now = env.ledger().timestamp();
        let feeds = load_feeds(&env);

        let feed = match feeds.get(pool_address.clone()) {
            Some(f) => f,
            None => panic_with_error!(&env, OracleError::FeedNotFound),
        };

        // Try primary feed.
        if let Some(price) = Self::latest_fresh_price(&feed, now) {
            return price;
        }

        // Try fallback (Issue #290).
        if feed.has_fallback {
            if let Some(fallback_feed) = feeds.get(feed.fallback_pool.clone()) {
                if let Some(price) = Self::latest_fresh_price(&fallback_feed, now) {
                    env.events().publish(
                        ("oracle_fallback_used",),
                        (&pool_address, &feed.fallback_pool),
                    );
                    return price;
                }
            }
        }

        panic_with_error!(&env, OracleError::NoFreshObservation)
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    fn check_admin(env: &Env, caller: &Address) {
        let admin = load_admin(env);
        if *caller != admin {
            panic_with_error!(env, OracleError::Unauthorized);
        }
    }

    fn latest_fresh_price(feed: &OracleFeed, now: u64) -> Option<i128> {
        let len = feed.observations.len();
        for i in (0..len).rev() {
            let obs = feed.observations.get(i)?;
            let age = now.saturating_sub(obs.timestamp);
            if age <= feed.freshness_threshold_secs {
                return Some(obs.price);
            }
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
    use soroban_sdk::Env;

    fn set_timestamp(env: &Env, ts: u64) {
        env.ledger().set(LedgerInfo {
            timestamp: ts,
            protocol_version: 22,
            sequence_number: ts as u32,
            network_id: Default::default(),
            base_reserve: 10,
            min_temp_entry_ttl: 1,
            min_persistent_entry_ttl: 1,
            max_entry_ttl: 999_999,
        });
    }

    fn deploy(env: &Env) -> (Address, OracleRegistryClient) {
        let admin = Address::generate(env);
        let contract_id = env.register_contract(None, OracleRegistry);
        let client = OracleRegistryClient::new(env, &contract_id);
        client.initialize(&admin);
        (admin, client)
    }

    // -----------------------------------------------------------------------
    // Issue #292 – multiple authorised feeders
    // -----------------------------------------------------------------------

    /// More than one feeder can publish to the same feed.
    #[test]
    fn test_multiple_feeders_can_publish() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = deploy(&env);

        let feeder_a = Address::generate(&env);
        let feeder_b = Address::generate(&env);
        let pool = Address::generate(&env);

        let feeders = soroban_sdk::vec![&env, feeder_a.clone()];
        client.register_feed(&admin, &pool, &feeders, &DEFAULT_FRESHNESS_SECS, &pool, &false);

        // feeder_b not yet authorised.
        set_timestamp(&env, 1000);
        let err = client
            .try_publish_price(&feeder_b, &pool, &9_i128)
            .unwrap_err()
            .unwrap();
        assert_eq!(
            err,
            soroban_sdk::Error::from_contract_error(OracleError::NotAuthorisedFeeder as u32)
        );

        // Add feeder_b.
        client.add_feeder(&admin, &pool, &feeder_b);

        // Now both can publish.
        client.publish_price(&feeder_a, &pool, &10_i128);
        client.publish_price(&feeder_b, &pool, &20_i128);

        let obs = client.get_observations(&pool);
        assert_eq!(obs.len(), 2);
        assert_eq!(obs.get(0).unwrap().price, 10);
        assert_eq!(obs.get(1).unwrap().price, 20);
    }

    /// A feeder can be removed; it must not publish afterwards.
    #[test]
    fn test_remove_feeder() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = deploy(&env);

        let feeder_a = Address::generate(&env);
        let feeder_b = Address::generate(&env);
        let pool = Address::generate(&env);

        let feeders = soroban_sdk::vec![&env, feeder_a.clone(), feeder_b.clone()];
        client.register_feed(&admin, &pool, &feeders, &DEFAULT_FRESHNESS_SECS, &pool, &false);

        // Remove feeder_a.
        client.remove_feeder(&admin, &pool, &feeder_a);

        set_timestamp(&env, 1000);

        // feeder_a should now be rejected.
        let err = client
            .try_publish_price(&feeder_a, &pool, &5_i128)
            .unwrap_err()
            .unwrap();
        assert_eq!(
            err,
            soroban_sdk::Error::from_contract_error(OracleError::NotAuthorisedFeeder as u32)
        );

        // feeder_b still works.
        client.publish_price(&feeder_b, &pool, &42_i128);
        assert_eq!(client.get_price(&pool), 42);
    }

    /// Adding a duplicate feeder returns FeederAlreadyAuthorised.
    #[test]
    fn test_add_duplicate_feeder_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = deploy(&env);

        let feeder = Address::generate(&env);
        let pool = Address::generate(&env);
        let feeders = soroban_sdk::vec![&env, feeder.clone()];

        client.register_feed(&admin, &pool, &feeders, &DEFAULT_FRESHNESS_SECS, &pool, &false);

        let err = client
            .try_add_feeder(&admin, &pool, &feeder)
            .unwrap_err()
            .unwrap();
        assert_eq!(
            err,
            soroban_sdk::Error::from_contract_error(OracleError::FeederAlreadyAuthorised as u32)
        );
    }

    /// Removing a non-existent feeder returns FeederNotFound.
    #[test]
    fn test_remove_nonexistent_feeder_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = deploy(&env);

        let feeder = Address::generate(&env);
        let stranger = Address::generate(&env);
        let pool = Address::generate(&env);
        let feeders = soroban_sdk::vec![&env, feeder.clone()];

        client.register_feed(&admin, &pool, &feeders, &DEFAULT_FRESHNESS_SECS, &pool, &false);

        let err = client
            .try_remove_feeder(&admin, &pool, &stranger)
            .unwrap_err()
            .unwrap();
        assert_eq!(
            err,
            soroban_sdk::Error::from_contract_error(OracleError::FeederNotFound as u32)
        );
    }

    /// Multiple feeders all publish to the same rolling window (combined #288 + #292).
    #[test]
    fn test_multiple_feeders_rolling_window() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = deploy(&env);

        let feeder_a = Address::generate(&env);
        let feeder_b = Address::generate(&env);
        let pool = Address::generate(&env);
        let feeders = soroban_sdk::vec![&env, feeder_a.clone(), feeder_b.clone()];

        client.register_feed(&admin, &pool, &feeders, &DEFAULT_FRESHNESS_SECS, &pool, &false);

        // Alternate between feeders to fill the window beyond MAX_OBSERVATIONS.
        for i in 0..(MAX_OBSERVATIONS + 2) {
            set_timestamp(&env, 1_000 + i as u64 * 5);
            if i % 2 == 0 {
                client.publish_price(&feeder_a, &pool, &(i as i128 * 10));
            } else {
                client.publish_price(&feeder_b, &pool, &(i as i128 * 10));
            }
        }

        let obs = client.get_observations(&pool);
        assert_eq!(obs.len(), MAX_OBSERVATIONS);
    }

    // -----------------------------------------------------------------------
    // Regressions for #281, #288, #290
    // -----------------------------------------------------------------------

    #[test]
    fn test_per_pool_freshness_threshold_regression() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = deploy(&env);

        let feeder = Address::generate(&env);
        let pool_relaxed = Address::generate(&env);
        let pool_strict = Address::generate(&env);
        let feeders = soroban_sdk::vec![&env, feeder.clone()];

        client.register_feed(&admin, &pool_relaxed, &feeders, &600_u64, &pool_relaxed, &false);
        client.register_feed(&admin, &pool_strict, &feeders, &30_u64, &pool_strict, &false);

        set_timestamp(&env, 1000);
        client.publish_price(&feeder, &pool_relaxed, &500_i128);
        client.publish_price(&feeder, &pool_strict, &500_i128);

        set_timestamp(&env, 1200);
        assert_eq!(client.get_price(&pool_relaxed), 500);
        let err = client.try_get_price(&pool_strict).unwrap_err().unwrap();
        assert_eq!(
            err,
            soroban_sdk::Error::from_contract_error(OracleError::NoFreshObservation as u32)
        );
    }

    #[test]
    fn test_fallback_used_when_primary_stale_regression() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = deploy(&env);

        let feeder = Address::generate(&env);
        let pool_primary = Address::generate(&env);
        let pool_fallback = Address::generate(&env);
        let feeders = soroban_sdk::vec![&env, feeder.clone()];

        client.register_feed(&admin, &pool_fallback, &feeders, &600_u64, &pool_fallback, &false);
        client.register_feed(&admin, &pool_primary, &feeders, &30_u64, &pool_fallback, &true);

        set_timestamp(&env, 1000);
        client.publish_price(&feeder, &pool_primary, &100_i128);
        client.publish_price(&feeder, &pool_fallback, &200_i128);

        set_timestamp(&env, 1200);
        assert_eq!(client.get_price(&pool_primary), 200);
    }
}
