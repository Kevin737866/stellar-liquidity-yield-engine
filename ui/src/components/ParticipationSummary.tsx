/**
 * ParticipationSummary Component
 *
 * Issue #481: gives an account a governance participation summary on the
 * analytics/reporting surface instead of making voters add up their own votes
 * from the proposal list. The numbers come from
 * `summarizeGovernanceParticipation`, which is pure, so this component reuses
 * the proposal list already loaded by `useGovernance` rather than reading the
 * contracts a second time.
 */

import React, { useMemo } from 'react';
import {
  formatVotingPower,
  summarizeGovernanceParticipation,
  type GovernanceParticipationSummary,
  type GovernanceProposal,
} from 'stellar-liquidity-yield-engine-sdk';

interface ParticipationSummaryProps {
  /** Account to summarize. Without one, the component renders a prompt. */
  account?: string;
  /** Proposal history already loaded by the governance hook. */
  proposals: GovernanceProposal[];
  /** Decimals of the governance token (7 for a Stellar Asset Contract token). */
  tokenDecimals?: number;
}

const Stat: React.FC<{ label: string; value: string; hint?: string }> = ({
  label,
  value,
  hint,
}) => (
  <div>
    <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
    <dd className="text-lg font-semibold text-gray-900">{value}</dd>
    {hint && <p className="text-xs text-gray-500">{hint}</p>}
  </div>
);

export const ParticipationSummary: React.FC<ParticipationSummaryProps> = ({
  account,
  proposals,
  tokenDecimals,
}) => {
  const summary = useMemo<GovernanceParticipationSummary | null>(() => {
    if (!account) return null;
    try {
      return summarizeGovernanceParticipation(account, proposals);
    } catch {
      // An unreadable account is reported as "nothing to show" rather than
      // taking down the proposals list around this card.
      return null;
    }
  }, [account, proposals]);

  if (!account) {
    return (
      <div className="bg-white rounded-lg shadow-md p-6">
        <h2 className="text-lg font-bold text-gray-900 mb-2">Your participation</h2>
        <p className="text-sm text-gray-600">
          Connect a wallet to see your governance participation summary.
        </p>
      </div>
    );
  }

  if (!summary) return null;

  const rateWidth = Math.min(100, Math.max(0, summary.participationRate));

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      <div className="mb-4">
        <h2 className="text-lg font-bold text-gray-900">Your participation</h2>
        <p className="text-sm text-gray-600 font-mono break-all">{summary.account}</p>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4 mb-4">
        <Stat
          label="Participation"
          value={`${summary.participationRate.toFixed(1)}%`}
          hint={`${summary.proposalsVoted} of ${summary.eligibleProposals} open votes`}
        />
        <Stat label="Voted for" value={String(summary.votesFor)} />
        <Stat label="Voted against" value={String(summary.votesAgainst)} />
        <Stat
          label="Voting power used"
          value={formatVotingPower(summary.votingPowerUsed, tokenDecimals)}
          hint={`${summary.proposalsCreated} proposal(s) authored`}
        />
      </dl>

      <div
        className="h-2 bg-gray-200 rounded-full overflow-hidden"
        role="progressbar"
        aria-label="Governance participation rate"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={summary.participationRate}
      >
        <div className="h-full bg-purple-500 transition-all" style={{ width: `${rateWidth}%` }} />
      </div>

      {summary.totalProposals === 0 && (
        <p className="text-sm text-gray-500 mt-3">
          No proposals have been created yet, so there is nothing to participate in.
        </p>
      )}
    </div>
  );
};

export default ParticipationSummary;
