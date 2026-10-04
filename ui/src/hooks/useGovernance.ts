/**
 * useGovernance hook
 *
 * Issue #102: `ProposalList`, `VotingPanel` and `StakingModal` rendered
 * whatever props they were handed, and nothing in the app ever fetched those
 * props from the governance contracts, so proposals, votes and stakes were
 * fabricated local state. This hook is that missing call layer: it owns a
 * `GovernanceSDK` instance, reads real contract state, and drives the
 * write calls those components expose as `on*` callbacks.
 *
 * Reads are per-role. A role with no contract ID configured (see
 * `src/config/network.ts`) is skipped and reported rather than throwing, so a
 * partially deployed governance system still renders whatever it can.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Keypair, Transaction } from 'stellar-sdk';
import {
  createGovernanceClient,
  type GovernanceSDK,
  type GovernanceProposal,
  type GovernanceContracts,
  type LockInfo,
  type SubmittedTransaction,
} from 'stellar-liquidity-yield-engine-sdk';
import {
  getGovernanceContracts,
  getNetwork,
  isConfigured,
  type UiNetwork,
} from '../config/network';
import {
  getFreighterPublicKey,
  isFreighterAvailable,
  isFreighterConnected,
} from '../lib/freighter';

/** Number of proposal IDs the UI probes when listing proposals. */
const MAX_PROPOSAL_IDS = 100;

export interface UseGovernanceOptions {
  /** Overrides the network from the environment. */
  network?: UiNetwork;
  /**
   * Signer for the write calls (locks, votes). Without one, reads still work
   * and each write resolves to a clear "Keypair required" error.
   */
  keypair?: Keypair;
  /** Address to load balances for. Falls back to the connected wallet. */
  address?: string;
  autoRefresh?: boolean;
  refreshInterval?: number;
}

export interface UseGovernanceReturn {
  sdk: GovernanceSDK | null;
  proposals: GovernanceProposal[];
  totalSupply: bigint;
  tokenBalance: bigint;
  userVotingPower: bigint;
  lockInfo: LockInfo | null;
  stakeBalance: bigint;
  pendingRewards: bigint;
  loading: boolean;
  /** Per-role read failures, e.g. "governance: not configured". */
  errors: string[];
  /** Roles with no contract ID configured. */
  unconfiguredRoles: Array<keyof GovernanceContracts>;
  refresh: () => Promise<void>;
  castVote: (
    proposalId: number,
    support: boolean,
    amount: bigint,
    reason?: string
  ) => Promise<SubmittedTransaction>;
  createLock: (amount: bigint, duration: number) => Promise<SubmittedTransaction>;
  increaseLock: (amount: bigint) => Promise<SubmittedTransaction>;
  extendLock: (newDuration: number) => Promise<SubmittedTransaction>;
  withdrawFromEscrow: () => Promise<SubmittedTransaction>;
  walletAddress: string | null;
  walletConnected: boolean;
  connect: () => Promise<string | null>;
  disconnect: () => void;
}

export const useGovernance = ({
  network,
  keypair,
  address,
  autoRefresh = false,
  refreshInterval = 30000,
}: UseGovernanceOptions = {}): UseGovernanceReturn => {
  const [proposals, setProposals] = useState<GovernanceProposal[]>([]);
  const [totalSupply, setTotalSupply] = useState<bigint>(0n);
  const [tokenBalance, setTokenBalance] = useState<bigint>(0n);
  const [userVotingPower, setUserVotingPower] = useState<bigint>(0n);
  const [lockInfo, setLockInfo] = useState<LockInfo | null>(null);
  const [stakeBalance, setStakeBalance] = useState<bigint>(0n);
  const [pendingRewards, setPendingRewards] = useState<bigint>(0n);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  // Contract IDs are injected rather than read from `process.env`, because a
  // browser bundle never has those server-side variables available (#101).
  const contracts = useMemo(() => getGovernanceContracts(), []);
  const activeNetwork = network ?? getNetwork();

  const sdk = useMemo(
    () =>
      createGovernanceClient(activeNetwork, {
        keypair,
        contracts,
      }),
    [activeNetwork, keypair, contracts]
  );

  const unconfiguredRoles = useMemo<Array<keyof GovernanceContracts>>(
    () =>
      (Object.keys(contracts) as Array<keyof GovernanceContracts>).filter(
        (role) => !isConfigured(contracts[role])
      ),
    [contracts]
  );

  // The address whose balances we display: explicit prop wins, then wallet.
  const activeAddress = address ?? walletAddress;

  const refresh = useCallback(async () => {
    const resolved = sdk.getContracts();
    const problems: string[] = [];

    /**
     * Run one read, skipping it when its contract is not configured and
     * recording the failure rather than letting it abort every other read.
     */
    const read = async <T>(
      role: keyof GovernanceContracts,
      load: () => Promise<T>,
      apply: (value: T) => void
    ): Promise<void> => {
      if (!isConfigured(resolved[role])) {
        problems.push(`${role}: not configured`);
        return;
      }
      try {
        apply(await load());
      } catch (err) {
        problems.push(`${role}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    setLoading(true);

    await Promise.all([
      read(
        'governance',
        () => sdk.getAllProposals(MAX_PROPOSAL_IDS),
        setProposals
      ),
      read('governance', () => sdk.getTotalSupply(), setTotalSupply),
      activeAddress
        ? read('governance', () => sdk.getTokenBalance(activeAddress), setTokenBalance)
        : Promise.resolve(),
      activeAddress
        ? read('votingEscrow', () => sdk.getVotingPower(activeAddress), setUserVotingPower)
        : Promise.resolve(),
      activeAddress
        ? read('votingEscrow', () => sdk.getLockInfo(activeAddress), setLockInfo)
        : Promise.resolve(),
      activeAddress
        ? read('staking', () => sdk.getStakeBalance(activeAddress), setStakeBalance)
        : Promise.resolve(),
      activeAddress
        ? read('staking', () => sdk.getPendingRewards(activeAddress), setPendingRewards)
        : Promise.resolve(),
    ]);

    setErrors(problems);
    setLoading(false);
  }, [sdk, activeAddress]);

  /**
   * Build, sign and submit one write call, so the UI reports success only
   * after the transaction is confirmed on chain.
   */
  const submit = useCallback(
    async (build: () => Promise<Transaction>): Promise<SubmittedTransaction> => {
      try {
        if (!sdk.getKeypair()) {
          return { hash: '', success: false, error: 'Keypair required to submit this call' };
        }
        return await sdk.submitTransaction(await build());
      } catch (err) {
        return {
          hash: '',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    [sdk]
  );

  const castVote = useCallback(
    (proposalId: number, support: boolean, amount: bigint, reason?: string) =>
      submit(() => sdk.castVote(proposalId, support, amount, reason)),
    [sdk, submit]
  );

  const createLock = useCallback(
    (amount: bigint, duration: number) => submit(() => sdk.createLock(amount, duration)),
    [sdk, submit]
  );

  const increaseLock = useCallback(
    (amount: bigint) => submit(() => sdk.increaseLock(amount)),
    [sdk, submit]
  );

  const extendLock = useCallback(
    (newDuration: number) => submit(() => sdk.extendLock(newDuration)),
    [sdk, submit]
  );

  const withdrawFromEscrow = useCallback(
    () => submit(() => sdk.withdrawFromEscrow()),
    [sdk, submit]
  );

  // Initial load + refresh whenever the address or contract IDs change.
  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      refresh();
    }, refreshInterval);
    return () => clearInterval(interval);
  }, [autoRefresh, refreshInterval, refresh]);

  // Reflect Freighter's persisted connection on mount.
  useEffect(() => {
    let cancelled = false;
    isFreighterConnected()
      .then(async (connected) => {
        if (cancelled || !connected) return;
        const publicKey = await getFreighterPublicKey().catch(() => null);
        if (publicKey && !cancelled) setWalletAddress(publicKey);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async (): Promise<string | null> => {
    if (!isFreighterAvailable()) {
      setErrors((prev) => [...prev, 'wallet: Freighter extension not installed']);
      return null;
    }
    try {
      const publicKey = await getFreighterPublicKey();
      setWalletAddress(publicKey);
      return publicKey;
    } catch (err) {
      setErrors([
        `wallet: ${err instanceof Error ? err.message : String(err)}`,
      ]);
      return null;
    }
  }, []);

  const disconnect = useCallback(() => setWalletAddress(null), []);

  return {
    sdk,
    proposals,
    totalSupply,
    tokenBalance,
    userVotingPower,
    lockInfo,
    stakeBalance,
    pendingRewards,
    loading,
    errors,
    unconfiguredRoles,
    refresh,
    castVote,
    createLock,
    increaseLock,
    extendLock,
    withdrawFromEscrow,
    walletAddress,
    walletConnected: Boolean(walletAddress),
    connect,
    disconnect,
  };
};

export default useGovernance;
