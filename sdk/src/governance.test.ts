import { GovernanceSDK, calculateBoostMultiplier, GOVERNANCE_CONSTANTS } from './governance';

const MAX_LOCK_DURATION = 4 * 365 * 24 * 60 * 60;
const BOOST_BASE_BPS = 10_000;

const proposalActions = [
  'queueProposal',
  'executeProposal',
  'cancelProposal',
] as const;

describe('GovernanceSDK proposal actions', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(proposalActions)(
    '%s rejects before building a transaction without a keypair',
    async (method) => {
      const sdk = new GovernanceSDK(
        'https://127.0.0.1:8080',
        'Test SDF Network ; September 2015'
      );
      const buildTransaction = jest.spyOn(sdk as any, 'buildTransaction');

      await expect(sdk[method](7)).rejects.toThrow('Keypair required');
      expect(buildTransaction).not.toHaveBeenCalled();
    }
  );
});

describe('calculateBoostMultiplier', () => {
  it('returns the 1.0x base for a zero-length lock', () => {
    expect(calculateBoostMultiplier(0)).toBe(BOOST_BASE_BPS);
  });

  it('is not capped below the base any more', () => {
    // Regression: the cap used to be 2500 while the base is 10000, so every
    // lock duration collapsed to the same 2500 value.
    for (const lockDuration of [0, 1, MAX_LOCK_DURATION / 4, MAX_LOCK_DURATION]) {
      expect(calculateBoostMultiplier(lockDuration)).toBeGreaterThanOrEqual(BOOST_BASE_BPS);
    }
  });

  it('distinguishes lock durations instead of returning a constant', () => {
    const shortLock = calculateBoostMultiplier(MAX_LOCK_DURATION / 4);
    const fullLock = calculateBoostMultiplier(MAX_LOCK_DURATION);

    expect(fullLock).toBeGreaterThan(shortLock);
    expect(shortLock).toBeGreaterThan(calculateBoostMultiplier(0));
  });

  it('never exceeds the maximum boost declared in GOVERNANCE_CONSTANTS', () => {
    const maxBoostBps = GOVERNANCE_CONSTANTS.MAX_BOOST_MULTIPLIER * BOOST_BASE_BPS;

    expect(maxBoostBps).toBe(25_000);
    expect(calculateBoostMultiplier(MAX_LOCK_DURATION)).toBeLessThanOrEqual(maxBoostBps);
  });

  it('clamps lock durations longer than maxDuration at the maximum boost', () => {
    const maxBoostBps = GOVERNANCE_CONSTANTS.MAX_BOOST_MULTIPLIER * BOOST_BASE_BPS;

    expect(calculateBoostMultiplier(MAX_LOCK_DURATION)).toBeLessThan(maxBoostBps);
    expect(calculateBoostMultiplier(MAX_LOCK_DURATION * 10)).toBe(maxBoostBps);
    expect(calculateBoostMultiplier(MAX_LOCK_DURATION * 1000)).toBe(maxBoostBps);
  });

  it('increases monotonically with lock duration', () => {
    let previous = calculateBoostMultiplier(0);

    for (let i = 1; i <= 10; i += 1) {
      const current = calculateBoostMultiplier((MAX_LOCK_DURATION / 10) * i);
      expect(current).toBeGreaterThan(previous);
      previous = current;
    }
  });

  it('honours a custom maxDuration', () => {
    expect(calculateBoostMultiplier(365 * 24 * 60 * 60, 365 * 24 * 60 * 60)).toBe(
      calculateBoostMultiplier(MAX_LOCK_DURATION)
    );
  });
});
