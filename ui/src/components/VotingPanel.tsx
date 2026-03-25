/**
 * VotingPanel Component
 * 
 * Allows users to cast votes on governance proposals with power breakdown.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { GovernanceProposal, formatVotingPower, formatDuration, hasProposalPassed } from '../../sdk/src/governance';

interface VotingPanelProps {
  proposal: GovernanceProposal;
  userAddress?: string;
  userVotingPower: bigint;
  totalSupply: bigint;
  hasVoted: boolean;
  votedFor: boolean | null;
  onVote: (support: boolean, amount: bigint, reason: string) => Promise<void>;
  onClose: () => void;
  loading?: boolean;
}

const VotingPanel: React.FC<VotingPanelProps> = ({
  proposal,
  userAddress,
  userVotingPower,
  totalSupply,
  hasVoted,
  votedFor,
  onVote,
  onClose,
  loading = false
}) => {
  const [voteAmount, setVoteAmount] = useState<bigint>(userVotingPower);
  const [votePercentage, setVotePercentage] = useState<number>(100);
  const [voteReason, setVoteReason] = useState<string>('');
  const [selectedVote, setSelectedVote] = useState<'for' | 'against' | null>(
    votedFor === true ? 'for' : votedFor === false ? 'against' : null
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Calculate time remaining
  const timeRemaining = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const end = proposal.endTime;
    const remaining = end - now;
    return remaining > 0 ? formatDuration(remaining) : 'Ended';
  }, [proposal.endTime]);

  // Calculate quorum
  const quorumInfo = useMemo(() => {
    const totalVotes = proposal.votesFor + proposal.votesAgainst;
    const quorumRequired = (totalSupply * BigInt(400)) / BigInt(10000); // 4%
    const quorumPercentage = totalSupply > BigInt(0) 
      ? (Number(totalVotes) / Number(quorumRequired)) * 100 
      : 0;
    
    return {
      totalVotes,
      quorumRequired,
      quorumPercentage: Math.min(quorumPercentage, 100),
      quorumReached: totalVotes >= quorumRequired
    };
  }, [proposal.votesFor, proposal.votesAgainst, totalSupply]);

  // Calculate vote breakdown
  const voteBreakdown = useMemo(() => {
    const totalVotes = Number(proposal.votesFor) + Number(proposal.votesAgainst);
    const forPercent = totalVotes > 0 ? (Number(proposal.votesFor) / totalVotes) * 100 : 0;
    const againstPercent = totalVotes > 0 ? (Number(proposal.votesAgainst) / totalVotes) * 100 : 0;
    
    const proposalPassed = hasProposalPassed(
      proposal.votesFor,
      proposal.votesAgainst,
      totalSupply
    );

    return {
      forPercent,
      againstPercent,
      totalVotes,
      passed: proposalPassed.passed
    };
  }, [proposal, totalSupply]);

  // Handle percentage change
  const handlePercentageChange = (percentage: number) => {
    setVotePercentage(percentage);
    setVoteAmount((userVotingPower * BigInt(percentage)) / BigInt(100));
  };

  // Handle custom amount
  const handleAmountChange = (value: string) => {
    const numValue = parseFloat(value) * 1e7; // Assuming 7 decimals
    if (!isNaN(numValue) && numValue >= 0) {
      const amount = BigInt(Math.floor(numValue));
      setVoteAmount(amount);
      setVotePercentage(Number((amount * BigInt(100)) / userVotingPower));
    }
  };

  // Handle vote submission
  const handleSubmit = async () => {
    if (!selectedVote || voteAmount <= BigInt(0)) return;
    
    setIsSubmitting(true);
    try {
      await onVote(selectedVote === 'for', voteAmount, voteReason);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Check if voting is allowed
  const canVote = useMemo(() => {
    return (
      proposal.state === 'active' &&
      userAddress &&
      userVotingPower > BigInt(0) &&
      !hasVoted
    );
  }, [proposal.state, userAddress, userVotingPower, hasVoted]);

  return (
    <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Vote on Proposal #{proposal.id}</h2>
          <p className="text-sm text-gray-500">Status: <span className="capitalize">{proposal.state}</span></p>
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 p-2"
          aria-label="Close"
        >
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="p-6 space-y-6">
        {/* Description */}
        <div className="bg-gray-50 rounded-lg p-4">
          <h3 className="font-semibold text-gray-900 mb-2">Description</h3>
          <p className="text-gray-700 whitespace-pre-wrap">{proposal.description}</p>
        </div>

        {/* Time Remaining */}
        <div className="flex items-center justify-between bg-blue-50 rounded-lg p-4">
          <div>
            <p className="text-sm text-blue-600 font-medium">Voting Period</p>
            <p className="text-lg font-bold text-blue-900">{timeRemaining} remaining</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-gray-500">
              {new Date(proposal.startTime * 1000).toLocaleDateString()} - {new Date(proposal.endTime * 1000).toLocaleDateString()}
            </p>
          </div>
        </div>

        {/* Vote Progress */}
        <div className="bg-gray-50 rounded-lg p-4">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-semibold text-gray-900">Current Results</h3>
            <span className={`text-sm font-medium ${voteBreakdown.passed ? 'text-green-600' : 'text-red-600'}`}>
              {voteBreakdown.passed ? '✓ Passing' : '✗ Not Passing'}
            </span>
          </div>
          
          {/* Progress Bar */}
          <div className="h-8 bg-gray-200 rounded-full overflow-hidden flex">
            <div 
              className="bg-green-500 flex items-center justify-center transition-all"
              style={{ width: `${voteBreakdown.forPercent}%` }}
            >
              {voteBreakdown.forPercent > 15 && (
                <span className="text-white text-sm font-medium">{voteBreakdown.forPercent.toFixed(1)}%</span>
              )}
            </div>
            <div 
              className="bg-red-500 flex items-center justify-center transition-all"
              style={{ width: `${voteBreakdown.againstPercent}%` }}
            >
              {voteBreakdown.againstPercent > 15 && (
                <span className="text-white text-sm font-medium">{voteBreakdown.againstPercent.toFixed(1)}%</span>
              )}
            </div>
          </div>

          {/* Vote Counts */}
          <div className="flex justify-between mt-3 text-sm">
            <div>
              <span className="text-green-600 font-medium">For: </span>
              <span className="text-gray-700">{formatVotingPower(proposal.votesFor)}</span>
            </div>
            <div>
              <span className="text-red-600 font-medium">Against: </span>
              <span className="text-gray-700">{formatVotingPower(proposal.votesAgainst)}</span>
            </div>
            <div>
              <span className="text-gray-600">Total: </span>
              <span className="text-gray-700">{formatVotingPower(voteBreakdown.totalVotes)}</span>
            </div>
          </div>

          {/* Quorum Progress */}
          <div className="mt-4 pt-4 border-t border-gray-200">
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm text-gray-600">Quorum Progress</span>
              <span className={`text-sm font-medium ${quorumInfo.quorumReached ? 'text-green-600' : 'text-gray-600'}`}>
                {quorumInfo.quorumPercentage.toFixed(1)}% 
                {quorumInfo.quorumReached && ' (Reached)'}
              </span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div 
                className={`h-full transition-all ${quorumInfo.quorumReached ? 'bg-green-500' : 'bg-blue-500'}`}
                style={{ width: `${Math.min(quorumInfo.quorumPercentage, 100)}%` }}
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Required: {formatVotingPower(quorumInfo.quorumRequired)} (4% of total supply)
            </p>
          </div>
        </div>

        {/* User's Voting Power */}
        <div className="bg-purple-50 rounded-lg p-4">
          <h3 className="font-semibold text-purple-900 mb-2">Your Voting Power</h3>
          <div className="flex justify-between items-center">
            <div>
              <p className="text-2xl font-bold text-purple-900">
                {formatVotingPower(userVotingPower)}
              </p>
              <p className="text-sm text-purple-600">SYGT</p>
            </div>
            {userAddress && (
              <div className="text-right">
                <p className="text-xs text-gray-500 font-mono">{userAddress.slice(0, 8)}...{userAddress.slice(-4)}</p>
              </div>
            )}
          </div>
          {hasVoted && (
            <div className={`mt-3 p-2 rounded ${votedFor ? 'bg-green-100' : 'bg-red-100'}`}>
              <p className={`text-sm font-medium ${votedFor ? 'text-green-800' : 'text-red-800'}`}>
                You have already voted {votedFor ? 'in favor' : 'against'} this proposal
              </p>
            </div>
          )}
        </div>

        {/* Voting Actions */}
        {canVote && (
          <div className="border border-gray-200 rounded-lg p-4 space-y-4">
            <h3 className="font-semibold text-gray-900">Cast Your Vote</h3>
            
            {/* Vote Selection */}
            <div className="grid grid-cols-2 gap-4">
              <button
                onClick={() => setSelectedVote('for')}
                disabled={loading || isSubmitting}
                className={`p-4 rounded-lg border-2 transition-all ${
                  selectedVote === 'for'
                    ? 'border-green-500 bg-green-50 text-green-700'
                    : 'border-gray-200 hover:border-gray-300 text-gray-600'
                }`}
              >
                <div className="flex flex-col items-center">
                  <svg className="w-8 h-8 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
                  </svg>
                  <span className="font-semibold">Vote For</span>
                </div>
              </button>
              
              <button
                onClick={() => setSelectedVote('against')}
                disabled={loading || isSubmitting}
                className={`p-4 rounded-lg border-2 transition-all ${
                  selectedVote === 'against'
                    ? 'border-red-500 bg-red-50 text-red-700'
                    : 'border-gray-200 hover:border-gray-300 text-gray-600'
                }`}
              >
                <div className="flex flex-col items-center">
                  <svg className="w-8 h-8 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14H5.236a2 2 0 01-1.789-2.894l3.5-7A2 2 0 018.736 3h4.018a2 2 0 01.485.06l3.76.94m-7 10v5a2 2 0 002 2h.096c.5 0 .905-.405.905-.904 0-.715.211-1.413.608-2.008L17 13V4m-7 10h2m5-10h2a2 2 0 012 2v6a2 2 0 01-2 2h-2.5" />
                  </svg>
                  <span className="font-semibold">Vote Against</span>
                </div>
              </button>
            </div>

            {/* Vote Amount */}
            {selectedVote && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Amount to Vote With
                  </label>
                  <div className="flex gap-4 mb-3">
                    {[25, 50, 75, 100].map(percent => (
                      <button
                        key={percent}
                        onClick={() => handlePercentageChange(percent)}
                        className={`px-3 py-1 rounded text-sm font-medium transition-colors ${
                          votePercentage === percent
                            ? 'bg-blue-500 text-white'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        {percent}%
                      </button>
                    ))}
                  </div>
                  <div className="flex items-center gap-4">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={votePercentage}
                      onChange={(e) => handlePercentageChange(Number(e.target.value))}
                      className="flex-1 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                    />
                    <div className="w-32">
                      <input
                        type="number"
                        value={Number(voteAmount) / 1e7}
                        onChange={(e) => handleAmountChange(e.target.value)}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                        placeholder="Amount"
                      />
                    </div>
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    Voting with {formatVotingPower(voteAmount)} SYGT ({votePercentage.toFixed(0)}%)
                  </p>
                </div>

                {/* Vote Reason */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Reason (Optional)
                  </label>
                  <textarea
                    value={voteReason}
                    onChange={(e) => setVoteReason(e.target.value)}
                    placeholder="Explain your vote..."
                    maxLength={280}
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg resize-none"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    {voteReason.length}/280 characters
                  </p>
                </div>

                {/* Submit Button */}
                <button
                  onClick={handleSubmit}
                  disabled={!selectedVote || voteAmount <= BigInt(0) || isSubmitting}
                  className={`w-full py-3 rounded-lg font-semibold transition-colors ${
                    selectedVote === 'for'
                      ? 'bg-green-600 hover:bg-green-700 text-white'
                      : 'bg-red-600 hover:bg-red-700 text-white'
                  } disabled:opacity-50 disabled:cursor-not-allowed`}
                >
                  {isSubmitting ? (
                    <span className="flex items-center justify-center gap-2">
                      <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Submitting...
                    </span>
                  ) : (
                    `Submit ${selectedVote === 'for' ? 'For' : 'Against'} Vote`
                  )}
                </button>
              </>
            )}
          </div>
        )}

        {/* Call Data */}
        {proposal.callData && proposal.callData.length > 0 && (
          <div className="bg-gray-50 rounded-lg p-4">
            <h3 className="font-semibold text-gray-900 mb-2">
              Proposed Actions ({proposal.callData.length})
            </h3>
            <div className="space-y-2">
              {proposal.callData.map((call, index) => (
                <div key={index} className="bg-white rounded p-3 border border-gray-200">
                  <p className="text-sm font-mono text-gray-700 truncate">
                    {call.contractAddress}
                  </p>
                  <p className="text-sm font-semibold text-blue-600">
                    {call.functionName}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Voter List */}
        <div className="bg-gray-50 rounded-lg p-4">
          <h3 className="font-semibold text-gray-900 mb-2">Top Voters</h3>
          <div className="space-y-2 max-h-40 overflow-y-auto">
            {Object.entries(proposal.forVoters || {})
              .sort(([, a], [, b]) => Number(b) - Number(a))
              .slice(0, 5)
              .map(([voter, amount]) => (
                <div key={voter} className="flex justify-between items-center text-sm">
                  <span className="text-green-600 font-mono">
                    {voter.slice(0, 8)}...{voter.slice(-4)}
                  </span>
                  <span className="text-gray-700">
                    {formatVotingPower(BigInt(amount as any))} FOR
                  </span>
                </div>
              ))}
            {Object.entries(proposal.againstVoters || {})
              .sort(([, a], [, b]) => Number(b) - Number(a))
              .slice(0, 5)
              .map(([voter, amount]) => (
                <div key={voter} className="flex justify-between items-center text-sm">
                  <span className="text-red-600 font-mono">
                    {voter.slice(0, 8)}...{voter.slice(-4)}
                  </span>
                  <span className="text-gray-700">
                    {formatVotingPower(BigInt(amount as any))} AGAINST
                  </span>
                </div>
              ))}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="border-t border-gray-200 px-6 py-4 bg-gray-50">
        <p className="text-xs text-gray-500 text-center">
          Voting is permanent and cannot be changed once submitted.
        </p>
      </div>
    </div>
  );
};

export default VotingPanel;
