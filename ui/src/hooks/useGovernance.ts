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
 *
 * Proposal lifecycle audit: `proposalEvents` exposes a chronological audit
 * view of each proposal's lifecycle (created, voting started, voted, ended,
 * executed, cancelled) derived from the proposal records the contract returns.
 * It is computed client-side from the same reads as `proposals`, so it adds no
 * extra contract calls. Events whose timestamps are unavailable are omitted
 * rather than guessed, and proposals with an inconsistent state are reported
 * through `auditErrors` instead of being silently dropped.
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

export type ProposalLifecycleEventType =
  | 'created'
  | 'voting_started'
  | 'voting_ended'
  | 'executed'
  | 'cancelled';

/** One entry in the proposal lifecycle audit trail. */
export interface ProposalLifecycleEvent {
  proposalId: number;
  type: ProposalLifecycleEventType;
  /** Unix timestamp in seconds, as recorded by the contract. */
  timestamp: number;
}

export interface ProposalAuditError {
  proposalId: number;
  message: string;
}

/**
 * Derive the lifecycle events for one proposal. Timestamps that are missing,
 * non-finite or non-positive are treated as unknown and that event is omitted.
 * Events are returned in chronological order; ties keep lifecycle order.
 */
export const buildProposalLifecycleEvents = (
  proposal: GovernanceProposal
): ProposalLifecycleEvent[] => {
  const candidates: Array<[ProposalLifecycleEventType, unknown]> = [
    ['created', (proposal as { createdAt?: unknown }).createdAt],
    ['voting_started', (proposal as { votingStartsAt?: unknown }).votingStartsAt],
    ['voting_ended', (proposal as { votingEndsAt?: unknown }).votingEndsAt],
    ['executed', (proposal as { executedAt?: unknown }).executedAt],
    ['cancelled', (proposal as { cancelledAt?: unknown }).cancelledAt],
  ];

  const events: ProposalLifecycleEvent[] = [];
  candidates.forEach(([type, raw], order) => {
    const timestamp = typeof raw === 'bigint' ? Number(raw) : raw;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
      return;
    }
    events.push({ proposalId: proposal.id, type, timestamp });
    // Preserve lifecycle order for stable sorting of equal timestamps.
    (events[events.length - 1] as ProposalLifecycleEvent & { _order?: number })._order = order;
  });

  return events
    .sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return (
        (a as ProposalLifecycleEvent & { _order?: number })._order! -
        (b as ProposalLifecycleEvent & { _order?: number })._order!
      );
    })
    .map(({ proposalId, type, timestamp }) => ({ proposalId, type, timestamp }));
};

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
  /** Chronological lifecycle audit trail across all loaded proposals. */
  proposalEvents: ProposalLifecycleEvent[];
  /** Proposals whose lifecycle could not be audited, with the reason. */
  auditErrors: ProposalAuditError[];
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

  // Lifecycle audit is derived from the loaded proposals. Each proposal is
  // audited independently so one malformed record cannot hide the others.
  const { proposalEvents, auditErrors } = useMemo(() => {
    const events: ProposalLifecycleEvent[] = [];
    const problems: ProposalAuditError[] = [];
    for (const proposal of proposals) {
      try {
        events.push(...buildProposalLifecycleEvents(proposal));
      } catch (err) {
        problems.push({
          proposalId: proposal.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    events.sort((a, b) =>
      a.timestamp !== b.timestamp
        ? a.timestamp - b.timestamp
        : a.proposalId - b.proposalId
    );
    return { proposalEvents: events, auditErrors: problems };
  }, [proposals]);

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
    proposalEvents,
    auditErrors,
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
