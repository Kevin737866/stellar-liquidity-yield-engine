/**
 * GovernancePanel Component
 *
 * Issue #102: the three governance components took their data as props, but
 * nothing ever fetched those props from the contracts, so every proposal,
 * vote and stake on screen was fabricated local state. This container owns the
 * missing wiring: it reads real contract state through `useGovernance` and
 * forwards the resulting `on*` callbacks back into contract writes.
 *
 * Render it wherever the governance UI belongs:
 *
 *   <GovernancePanel network="testnet" />
 */

import React, { useState } from 'react';
import type { GovernanceProposal } from '../../sdk/src/governance';
import { DEFAULT_TOKEN_DECIMALS } from '../../sdk/src/governance';
import { useGovernance } from '../hooks/useGovernance';
import { describeNetworkConfig } from '../config/network';
import ProposalList from './ProposalList';
import VotingPanel from './VotingPanel';
import StakingModal from './StakingModal';

interface GovernancePanelProps {
  /** Overrides the network from the environment. */
  network?: 'testnet' | 'mainnet';
  /** Decimals of the governance token (7 for a Stellar Asset Contract token). */
  tokenDecimals?: number;
}

/**
 * `scValToNative` can surface voter maps as a JS `Map` or as a plain object
 * depending on the SDK version, so read both rather than assuming one shape.
 */
const hasVotedIn = (voters: unknown, address: string): boolean => {
  if (!address) return false;
  if (voters instanceof Map) return voters.has(address);
  if (typeof voters === 'object' && voters !== null) {
    return address in (voters as Record<string, unknown>);
  }
  return false;
};

export const GovernancePanel: React.FC<GovernancePanelProps> = ({
  network,
  tokenDecimals = DEFAULT_TOKEN_DECIMALS,
}) => {
  const governance = useGovernance({ network });
  const {
    proposals,
    totalSupply,
    tokenBalance,
    userVotingPower,
    lockInfo,
    loading,
    errors,
    unconfiguredRoles,
    walletAddress,
    walletConnected,
    connect,
    refresh,
    castVote,
    createLock,
    increaseLock,
    extendLock,
    withdrawFromEscrow,
  } = governance;

  const [selectedProposal, setSelectedProposal] = useState<GovernanceProposal | null>(null);
  const [isStakingOpen, setIsStakingOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const currentUser = walletAddress ?? '';

  // The active proposal may have been refreshed since it was selected.
  const activeProposal =
    selectedProposal && proposals.find((p) => p.id === selectedProposal.id)
      ? proposals.find((p) => p.id === selectedProposal.id)!
      : selectedProposal;

  const hasVoted = activeProposal
    ? hasVotedIn(activeProposal.forVoters, currentUser) ||
      hasVotedIn(activeProposal.againstVoters, currentUser)
    : false;
  const votedFor = activeProposal
    ? hasVotedIn(activeProposal.forVoters, currentUser)
      ? true
      : hasVotedIn(activeProposal.againstVoters, currentUser)
        ? false
        : null
    : null;

  /** Run a contract write and surface its failure next to the component. */
  const runAction = async (action: () => Promise<{ success: boolean; error?: string }>) => {
    setActionError(null);
    const result = await action();
    if (!result.success) {
      setActionError(result.error ?? 'Transaction failed');
      return;
    }
    await refresh();
  };

  const diagnostic = describeNetworkConfig(network);

  return (
    <div className="space-y-6">
      {/* Wallet / configuration status */}
      <div className="bg-gray-50 rounded-lg p-4 text-sm text-gray-700 space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-medium">{diagnostic}</span>
          {walletConnected ? (
            <span className="text-green-700">Wallet {walletAddress?.slice(0, 8)}…</span>
          ) : (
            <button
              onClick={() => connect()}
              className="px-3 py-1 rounded bg-purple-600 text-white hover:bg-purple-700"
            >
              Connect Freighter
            </button>
          )}
        </div>

        {unconfiguredRoles.length > 0 && (
          <p className="text-amber-700">
            Not configured: {unconfiguredRoles.join(', ')}. Set the matching
            NEXT_PUBLIC_*_CONTRACT_ID variables in ui/.env.
          </p>
        )}
        {errors.length > 0 && (
          <p className="text-red-700">Read errors: {errors.join(' | ')}</p>
        )}
        {actionError && <p className="text-red-700">{actionError}</p>}
      </div>

      {/* Proposals */}
      <ProposalList
        proposals={proposals}
        totalSupply={totalSupply}
        currentUser={currentUser || undefined}
        onSelectProposal={setSelectedProposal}
        loading={loading}
        error={errors.length > 0 ? errors.join(' | ') : undefined}
      />

      {/* Voting */}
      {activeProposal && (
        <VotingPanel
          proposal={activeProposal}
          userAddress={currentUser || undefined}
          userVotingPower={userVotingPower}
          totalSupply={totalSupply}
          hasVoted={hasVoted}
          votedFor={votedFor}
          tokenDecimals={tokenDecimals}
          onVote={(support, amount, reason) =>
            runAction(() => castVote(activeProposal.id, support, amount, reason))
          }
          onClose={() => setSelectedProposal(null)}
          loading={loading}
        />
      )}

      {/* Locking / staking */}
      <button
        onClick={() => setIsStakingOpen(true)}
        className="px-4 py-2 rounded-lg bg-purple-600 text-white hover:bg-purple-700"
      >
        Stake SYGT
      </button>

      <StakingModal
        isOpen={isStakingOpen}
        onClose={() => setIsStakingOpen(false)}
        tokenBalance={tokenBalance}
        tokenDecimals={tokenDecimals}
        lockInfo={lockInfo ?? undefined}
        onCreateLock={(amount, duration) => runAction(() => createLock(amount, duration))}
        onIncreaseLock={(amount) => runAction(() => increaseLock(amount))}
        onExtendLock={(newDuration) => runAction(() => extendLock(newDuration))}
        onWithdraw={() => runAction(() => withdrawFromEscrow())}
        loading={loading}
      />
    </div>
  );
};

export default GovernancePanel;
