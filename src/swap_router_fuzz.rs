//! Deterministic randomized tests against the real router, not a routing copy.
use super::*;
use soroban_sdk::testutils::Address as _;

// Small, fixed algorithm: failures report a seed and case for exact replay.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, limit: u64) -> u64 {
        self.next() % limit
    }
}

fn seeds() -> std::vec::Vec<u64> {
    match std::env::var("ROUTER_FUZZ_SEED") {
        Ok(seed) => std::vec![seed.parse().expect("ROUTER_FUZZ_SEED must be a u64")],
        Err(_) => std::vec![328, 0x5eed, 0xdeadbeef, u64::MAX],
    }
}

fn cases() -> usize {
    std::env::var("ROUTER_FUZZ_CASES")
        .map(|value| value.parse().expect("ROUTER_FUZZ_CASES must be a usize"))
        .unwrap_or(32)
}

fn pool(env: &Env, a: &Address, b: &Address, ra: i128, rb: i128, fee: u32) -> PoolInfo {
    PoolInfo {
        pool_address: Address::generate(env),
        token_a: a.clone(),
        token_b: b.clone(),
        reserve_a: ra,
        reserve_b: rb,
        fee_bps: fee,
        is_stable_swap: false,
    }
}

#[test]
fn fuzz_quote_arithmetic_and_invalid_inputs() {
    let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.cost_estimate().budget().reset_unlimited();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let unrelated = Address::generate(&env);
    let edges = [
        i128::MIN,
        -1,
        0,
        1,
        2,
        10_000,
        i128::MAX / 10_000,
        i128::MAX,
    ];
    for seed in seeds() {
        let mut rng = Rng(seed);
        for case in 0..cases() {
            eprintln!("arithmetic seed={seed} case={case}");
            let ra = edges[rng.below(edges.len() as u64) as usize];
            let rb = edges[rng.below(edges.len() as u64) as usize];
            let amount = edges[rng.below(edges.len() as u64) as usize];
            let fee = [0, 30, 9_999, 10_000, u32::MAX][rng.below(5) as usize];
            let p = pool(&env, &a, &b, ra, rb, fee);
            // Invalid/unsupported arithmetic must be rejected, never panic.
            for token in [&a, &b, &unrelated] {
                let output = SwapRouter::calculate_direct_swap_output_for_pool(&p, token, amount);
                if token == &unrelated {
                    assert!(output.is_none(), "seed={seed} case={case}");
                }
                if let Some(output) = output {
                    let reserve_out = if token == &a { rb } else { ra };
                    assert!(ra > 0 && rb > 0 && amount > 0 && fee < 10_000);
                    assert!(
                        output >= 0 && output < reserve_out,
                        "seed={seed} case={case}"
                    );
                }
            }
            assert!(p.depth_score() >= 0, "seed={seed} case={case}");
        }
        // Bounded values admit an independent exact integer reference formula.
        for case in 0..cases() {
            eprintln!("reference seed={seed} case={case}");
            let ra = 1 + rng.below(1_000_000_000) as i128;
            let rb = 1 + rng.below(1_000_000_000) as i128;
            let amount = 1 + rng.below(1_000_000) as i128;
            let fee = rng.below(10_000) as u32;
            let p = pool(&env, &a, &b, ra, rb, fee);
            for (token, rin, rout) in [(&a, ra, rb), (&b, rb, ra)] {
                let net = amount * (10_000 - i128::from(fee));
                let expected = net * rout / (rin * 10_000 + net);
                assert_eq!(
                    SwapRouter::calculate_direct_swap_output_for_pool(&p, token, amount),
                    Some(expected),
                    "seed={seed} case={case}"
                );
                let (output, impact) = SwapRouter::calculate_direct_swap(&p, token, amount);
                assert_eq!(output, expected);
                assert_eq!(impact, 10_000 - output * rin * 10_000 / (amount * rout));
                assert!(
                    (0..=10_000).contains(&impact),
                    "seed={seed} case={case} impact={impact}"
                );
                let slip = rng.below(101) as u32;
                assert_eq!(
                    SwapRouter::calculate_minimum_output(output, slip),
                    output * (10_000 - i128::from(slip)) / 10_000
                );
            }
        }
    }
}

fn assert_path(
    env: &Env,
    pools: &Map<Address, PoolInfo>,
    a: &Address,
    b: &Address,
    amount: i128,
    path: &SwapPath,
) {
    assert_eq!(path.tokens.len(), path.pools.len() + 1);
    assert!(path.pools.len() <= MAX_PATH_LENGTH);
    assert_eq!(path.tokens.first().unwrap(), *a);
    assert_eq!(path.tokens.last().unwrap(), *b);
    let mut output = amount;
    for i in 0..path.pools.len() {
        let from = path.tokens.get(i).unwrap();
        let to = path.tokens.get(i + 1).unwrap();
        for j in 0..i + 1 {
            assert_ne!(path.tokens.get(j).unwrap(), to, "route must not cycle");
        }
        let p = pools.get(path.pools.get(i).unwrap()).unwrap();
        assert!((p.token_a == from && p.token_b == to) || (p.token_b == from && p.token_a == to));
        let (rin, rout) = if p.token_a == from {
            (p.reserve_a, p.reserve_b)
        } else {
            (p.reserve_b, p.reserve_a)
        };
        let net = output * (10_000 - i128::from(p.fee_bps));
        output = net * rout / (rin * 10_000 + net);
    }
    assert_eq!(path.expected_output, output);
    assert_eq!(
        SwapRouter::calculate_output_amount(env, path, amount),
        output
    );
}

#[test]
fn fuzz_pool_graphs_and_quote_consistency() {
    for seed in seeds() {
        let mut rng = Rng(seed);
        for case in 0..cases() {
            eprintln!("graph seed={seed} case={case}");
            let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
                capture_snapshot_at_drop: false,
            });
            env.cost_estimate().budget().reset_unlimited();
            let contract = env.register(SwapRouter, ());
            env.as_contract(&contract, || {
                let tokens: std::vec::Vec<_> = (0..6).map(|_| Address::generate(&env)).collect();
                let admin = Address::generate(&env);
                SwapRouter::initialize(env.clone(), admin.clone(), admin, tokens[5].clone());
                let mut pools = Map::new(&env);
                // Random graphs include empty/disconnected sets, self-edges,
                // cycles and duplicate pairs, with randomized reserve orientation.
                for _ in 0..rng.below(12) {
                    let a = rng.below(6) as usize;
                    let b = rng.below(6) as usize;
                    let p = pool(
                        &env,
                        &tokens[a],
                        &tokens[b],
                        1_000_000 + rng.below(1_000_000) as i128,
                        1_000_000 + rng.below(1_000_000) as i128,
                        rng.below(100) as u32,
                    );
                    pools.set(p.pool_address.clone(), p);
                }
                // Every fourth case forces a three-edge non-XLM path.
                if case % 4 == 0 {
                    pools = Map::new(&env);
                    for i in 0..3 {
                        let p = pool(&env, &tokens[i], &tokens[i + 1], 1_000_000, 2_000_000, 30);
                        pools.set(p.pool_address.clone(), p);
                    }
                }
                env.storage()
                    .instance()
                    .set(&Symbol::new(&env, "pools"), &pools);
                let amount = 10_000 + rng.below(10_000) as i128;
                let (path, _) = SwapRouter::find_best_path(&env, &tokens[0], &tokens[3], amount);
                // Independent bounded reachability oracle. Generated valid
                // reserves/amounts cannot round to zero within three hops.
                let mut reachable = [true, false, false, false, false, false];
                for _ in 0..MAX_PATH_LENGTH {
                    let previous = reachable;
                    for (_, p) in pools.iter() {
                        let a = tokens.iter().position(|token| *token == p.token_a).unwrap();
                        let b = tokens.iter().position(|token| *token == p.token_b).unwrap();
                        if previous[a] {
                            reachable[b] = true;
                        }
                        if previous[b] {
                            reachable[a] = true;
                        }
                    }
                }
                assert_eq!(
                    !path.pools.is_empty(),
                    reachable[3],
                    "seed={seed} case={case}"
                );
                if case % 4 == 0 {
                    assert_eq!(path.pools.len(), 3, "seed={seed} case={case}");
                }
                if !path.pools.is_empty() {
                    assert_path(&env, &pools, &tokens[0], &tokens[3], amount, &path);
                    let slip = rng.below(101) as u32;
                    let quote = SwapRouter::get_quote(
                        env.clone(),
                        tokens[0].clone(),
                        tokens[3].clone(),
                        amount,
                        Some(slip),
                    );
                    assert_eq!(
                        quote.expected_output, path.expected_output,
                        "seed={seed} case={case}"
                    );
                    assert_eq!(quote.path, path);
                    assert_eq!(
                        quote.minimum_output,
                        quote.expected_output * (10_000 - i128::from(slip)) / 10_000
                    );
                    assert_eq!(quote.protocol_fee, quote.expected_output * 25 / 10_000);
                }
            });
        }
    }
}

#[test]
fn regression_quote_uses_selected_pool_and_skips_invalid_candidates() {
    let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.cost_estimate().budget().reset_unlimited();
    let contract = env.register(SwapRouter, ());
    env.as_contract(&contract, || {
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let xlm = Address::generate(&env);
        let admin = Address::generate(&env);
        SwapRouter::initialize(env.clone(), admin.clone(), admin, xlm);
        let shallow = pool(&env, &a, &b, 1_000, 2_000, 30);
        let deep = pool(&env, &b, &a, 2_000_000, 1_000_000, 30);
        let invalid = pool(&env, &a, &b, 3_000_000, 3_000_000, u32::MAX);
        let mut pools = Map::new(&env);
        for p in [shallow, deep.clone(), invalid] {
            pools.set(p.pool_address.clone(), p);
        }
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pools"), &pools);
        for (from, to) in [(&a, &b), (&b, &a)] {
            let quote = SwapRouter::get_quote(env.clone(), from.clone(), to.clone(), 100, None);
            assert_eq!(quote.path.pools.first(), Some(deep.pool_address.clone()));
            assert_path(&env, &pools, from, to, 100, &quote.path);
            assert_eq!(quote.expected_output, quote.path.expected_output);
            let direct =
                SwapRouter::get_direct_quote(env.clone(), from.clone(), to.clone(), 100).unwrap();
            assert_eq!(direct.expected_output, quote.expected_output);
            assert_eq!(direct.path.pools, quote.path.pools);
            assert_eq!(direct.path.price_impact_bps, direct.price_impact_bps);
        }
    });
}

#[test]
fn regression_empty_graph_and_public_input_validation() {
    let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    let contract = env.register(SwapRouter, ());
    env.as_contract(&contract, || {
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let admin = Address::generate(&env);
        SwapRouter::initialize(env.clone(), admin.clone(), admin, b.clone());
        assert!(SwapRouter::find_best_path(&env, &a, &b, 1)
            .0
            .pools
            .is_empty());
        for amount in [i128::MIN, -1, 0, 1, i128::MAX] {
            assert!(
                SwapRouter::get_direct_quote(env.clone(), a.clone(), b.clone(), amount).is_none()
            );
        }
        let p = pool(&env, &a, &b, 1_000_000, 2_000_000, 30);
        let mut pools = Map::new(&env);
        pools.set(p.pool_address.clone(), p);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pools"), &pools);
        for amount in [i128::MIN, -1, 0] {
            assert!(
                SwapRouter::get_direct_quote(env.clone(), a.clone(), b.clone(), amount).is_none()
            );
        }
        assert!(SwapRouter::get_direct_quote(env.clone(), a.clone(), a.clone(), 100).is_none());
        for slip in [101, 10_000, u32::MAX] {
            assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                SwapRouter::get_quote(env.clone(), a.clone(), b.clone(), 100, Some(slip))
            }))
            .is_err());
        }
        for slip in [0, 100] {
            let quote = SwapRouter::get_quote(env.clone(), a.clone(), b.clone(), 100, Some(slip));
            assert!(quote.minimum_output <= quote.expected_output);
        }
    });
}

#[test]
fn regression_invalid_branch_does_not_hide_valid_sibling() {
    let env = Env::new_with_config(soroban_sdk::testutils::EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.cost_estimate().budget().reset_unlimited();
    let contract = env.register(SwapRouter, ());
    env.as_contract(&contract, || {
        let tokens: std::vec::Vec<_> = (0..5).map(|_| Address::generate(&env)).collect();
        let admin = Address::generate(&env);
        SwapRouter::initialize(env.clone(), admin.clone(), admin, tokens[4].clone());
        let mut pools = Map::new(&env);
        // This high-depth candidate overflows quote arithmetic for this amount.
        let invalid = pool(&env, &tokens[0], &tokens[1], 1, i128::MAX / 2, 0);
        pools.set(invalid.pool_address.clone(), invalid);
        for (a, b) in [(0, 2), (2, 3)] {
            let p = pool(&env, &tokens[a], &tokens[b], 1_000_000, 1_000_000, 30);
            pools.set(p.pool_address.clone(), p);
        }
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "pools"), &pools);
        let (path, kind) = SwapRouter::find_best_path(&env, &tokens[0], &tokens[3], 10_000);
        assert_eq!(kind, RouteType::MultiHop);
        assert_eq!(path.pools.len(), 2);
        assert_path(&env, &pools, &tokens[0], &tokens[3], 10_000, &path);
    });
}

#[test]
fn regression_scaling_and_depth_extremes() {
    for amount in [0, 1, 9_999, 10_000, i128::MAX] {
        let mut previous = amount;
        for slippage in 0..=100 {
            let output = SwapRouter::calculate_minimum_output(amount, slippage);
            assert!((0..=previous).contains(&output));
            previous = output;
        }
        assert_eq!(SwapRouter::calculate_minimum_output(amount, 0), amount);
        assert!((0..=amount).contains(&SwapRouter::scale_bps(amount, 25)));
    }
    for n in [0, 1, 2, 3, 4, 1_000_000_000_000, i128::MAX] {
        let root = PoolInfo::isqrt(n);
        if root > 0 {
            assert!(root <= n / root);
        }
        assert!(root + 1 > n / (root + 1));
    }
}
