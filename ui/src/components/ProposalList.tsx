/**
 * ProposalList Component
 * 
 * Displays active, pending, and executed governance proposals
 * with filtering and sorting capabilities.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  ProposalState, 
  GovernanceProposal, 
  formatVotingPower, 
  formatDuration,
  hasProposalPassed 
} from '../../sdk/src/governance';

interface ProposalListProps {
  proposals: GovernanceProposal[];
  totalSupply: bigint;
  currentUser?: string;
  onSelectProposal: (proposal: GovernanceProposal) => void;
  loading?: boolean;
  error?: string;
}

type FilterTab = 'all' | 'active' | 'pending' | 'executed' | 'defeated';

const ProposalList: React.FC<ProposalListProps> = ({
  proposals,
  totalSupply,
  currentUser,
  onSelectProposal,
  loading = false,
  error
}) => {
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [sortBy, setSortBy] = useState<'time' | 'votes' | 'id'>('time');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [searchQuery, setSearchQuery] = useState('');

  // Filter proposals by tab
  const filteredProposals = useMemo(() => {
    let filtered = proposals;

    // Filter by tab
    switch (activeTab) {
      case 'active':
        filtered = filtered.filter(p => p.state === ProposalState.Active);
        break;
      case 'pending':
        filtered = filtered.filter(p => p.state === ProposalState.Pending);
        break;
      case 'executed':
        filtered = filtered.filter(p => p.state === ProposalState.Executed);
        break;
      case 'defeated':
        filtered = filtered.filter(p => 
          p.state === ProposalState.Defeated || 
          p.state === ProposalState.Expired ||
          p.state === ProposalState.Canceled
        );
        break;
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(p => 
        p.description.toLowerCase().includes(query) ||
        p.proposer.toLowerCase().includes(query) ||
        p.id.toString().includes(query)
      );
    }

    // Sort proposals
    filtered.sort((a, b) => {
      let comparison = 0;
      
      switch (sortBy) {
        case 'time':
          comparison = a.endTime - b.endTime;
          break;
        case 'votes':
          comparison = Number(a.votesFor + a.votesAgainst - (b.votesFor + b.votesAgainst));
          break;
        case 'id':
          comparison = a.id - b.id;
          break;
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

    return filtered;
  }, [proposals, activeTab, searchQuery, sortBy, sortOrder]);

  // Count proposals by state
  const proposalCounts = useMemo(() => ({
    all: proposals.length,
    active: proposals.filter(p => p.state === ProposalState.Active).length,
    pending: proposals.filter(p => p.state === ProposalState.Pending).length,
    executed: proposals.filter(p => p.state === ProposalState.Executed).length,
    defeated: proposals.filter(p => 
      p.state === ProposalState.Defeated || 
      p.state === ProposalState.Expired ||
      p.state === ProposalState.Canceled
    ).length
  }), [proposals]);

  // Get state badge color
  const getStateBadgeColor = (state: ProposalState): string => {
    switch (state) {
      case ProposalState.Pending:
        return 'bg-yellow-100 text-yellow-800';
      case ProposalState.Active:
        return 'bg-green-100 text-green-800';
      case ProposalState.Succeeded:
      case ProposalState.Queued:
        return 'bg-blue-100 text-blue-800';
      case ProposalState.Executed:
        return 'bg-purple-100 text-purple-800';
      case ProposalState.Defeated:
      case ProposalState.Expired:
      case ProposalState.Canceled:
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  // Format state label
  const formatStateLabel = (state: ProposalState): string => {
    switch (state) {
      case ProposalState.Pending:
        return 'Pending';
      case ProposalState.Active:
        return 'Active';
      case ProposalState.Canceled:
        return 'Canceled';
      case ProposalState.Defeated:
        return 'Defeated';
      case ProposalState.Succeeded:
        return 'Succeeded';
      case ProposalState.Queued:
        return 'Queued';
      case ProposalState.Expired:
        return 'Expired';
      case ProposalState.Executed:
        return 'Executed';
      default:
        return 'Unknown';
    }
  };

  // Calculate time remaining
  const getTimeRemaining = (endTime: number): string => {
    const now = Math.floor(Date.now() / 1000);
    const remaining = endTime - now;
    
    if (remaining <= 0) return 'Ended';
    return formatDuration(remaining);
  };

  // Calculate vote percentages
  const getVotePercentages = (proposal: GovernanceProposal) => {
    const total = Number(proposal.votesFor) + Number(proposal.votesAgainst);
    if (total === 0) return { for: 0, against: 0 };
    
    return {
      for: (Number(proposal.votesFor) / total) * 100,
      against: (Number(proposal.votesAgainst) / total) * 100
    };
  };

  // Check if user has voted
  const hasUserVoted = (proposal: GovernanceProposal): boolean => {
    if (!currentUser) return false;
    return (
      (proposal.forVoters && currentUser in proposal.forVoters) ||
      (proposal.againstVoters && currentUser in proposal.againstVoters)
    );
  };

  // Check if user voted for
  const didUserVoteFor = (proposal: GovernanceProposal): boolean | null => {
    if (!currentUser) return null;
    if (proposal.forVoters && currentUser in proposal.forVoters) return true;
    if (proposal.againstVoters && currentUser in proposal.againstVoters) return false;
    return null;
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Governance Proposals</h2>
        <p className="text-gray-600">
          Participate in protocol governance by voting on active proposals
        </p>
      </div>

      {/* Filters and Search */}
      <div className="mb-6">
        {/* Tabs */}
        <div className="flex border-b border-gray-200 mb-4">
          {(['all', 'active', 'pending', 'executed', 'defeated'] as FilterTab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 font-medium capitalize transition-colors ${
                activeTab === tab
                  ? 'border-b-2 border-blue-500 text-blue-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab}
              <span className="ml-2 text-xs bg-gray-200 px-2 py-0.5 rounded-full">
                {proposalCounts[tab]}
              </span>
            </button>
          ))}
        </div>

        {/* Search and Sort */}
        <div className="flex gap-4 items-center">
          {/* Search */}
          <div className="flex-1">
            <input
              type="text"
              placeholder="Search proposals..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          {/* Sort */}
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">Sort by:</label>
            <select
              value={`${sortBy}-${sortOrder}`}
              onChange={(e) => {
                const [by, order] = e.target.value.split('-');
                setSortBy(by as 'time' | 'votes' | 'id');
                setSortOrder(order as 'asc' | 'desc');
              }}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
            >
              <option value="time-desc">Time (Newest)</option>
              <option value="time-asc">Time (Oldest)</option>
              <option value="votes-desc">Votes (Highest)</option>
              <option value="votes-asc">Votes (Lowest)</option>
              <option value="id-desc">ID (Highest)</option>
              <option value="id-asc">ID (Lowest)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-500"></div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
          <p className="text-red-800">{error}</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && !error && filteredProposals.length === 0 && (
        <div className="text-center py-12">
          <div className="text-gray-400 text-lg mb-2">No proposals found</div>
          <p className="text-gray-500">
            {activeTab === 'all' 
              ? 'No governance proposals have been created yet.'
              : `No ${activeTab} proposals at the moment.`}
          </p>
        </div>
      )}

      {/* Proposal List */}
      <div className="space-y-4">
        {!loading && !error && filteredProposals.map(proposal => {
          const { for: forPercent, against: againstPercent } = getVotePercentages(proposal);
          const userVoted = hasUserVoted(proposal);
          const userVotedFor = didUserVoteFor(proposal);
          const proposalPassed = hasProposalPassed(
            proposal.votesFor,
            proposal.votesAgainst,
            totalSupply
          );

          return (
            <div
              key={proposal.id}
              onClick={() => onSelectProposal(proposal)}
              className="border border-gray-200 rounded-lg p-4 hover:border-blue-300 hover:shadow-md transition-all cursor-pointer"
            >
              {/* Header Row */}
              <div className="flex justify-between items-start mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg font-semibold text-gray-900">
                      Proposal #{proposal.id}
                    </span>
                    <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${getStateBadgeColor(proposal.state)}`}>
                      {formatStateLabel(proposal.state)}
                    </span>
                    {userVoted && (
                      <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${
                        userVotedFor 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-red-100 text-red-800'
                      }`}>
                        You voted {userVotedFor ? 'for' : 'against'}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-600">
                    Proposed by <span className="font-mono text-xs">{proposal.proposer.slice(0, 8)}...</span>
                  </p>
                </div>
                <div className="text-right">
                  {proposal.state === ProposalState.Active && (
                    <div className="text-sm text-gray-600">
                      Ends in <span className="font-semibold text-gray-900">{getTimeRemaining(proposal.endTime)}</span>
                    </div>
                  )}
                  {proposal.state === ProposalState.Queued && (
                    <div className="text-sm text-blue-600">
                      Executes in <span className="font-semibold">{getTimeRemaining(proposal.eta)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Description */}
              <p className="text-gray-800 mb-4 line-clamp-2">
                {proposal.description}
              </p>

              {/* Vote Progress */}
              {proposal.state === ProposalState.Active && (
                <div className="mb-3">
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-green-600">
                      For: {forPercent.toFixed(1)}%
                    </span>
                    <span className="text-red-600">
                      Against: {againstPercent.toFixed(1)}%
                    </span>
                  </div>
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div className="flex h-full">
                      <div 
                        className="bg-green-500 transition-all"
                        style={{ width: `${forPercent}%` }}
                      />
                      <div 
                        className="bg-red-500 transition-all"
                        style={{ width: `${againstPercent}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>{formatVotingPower(proposal.votesFor)} votes for</span>
                    <span>{formatVotingPower(proposal.votesAgainst)} votes against</span>
                  </div>
                </div>
              )}

              {/* Footer Info */}
              <div className="flex justify-between items-center text-sm text-gray-500">
                <div className="flex items-center gap-4">
                  <span>
                    Start: {new Date(proposal.startTime * 1000).toLocaleDateString()}
                  </span>
                  <span>
                    End: {new Date(proposal.endTime * 1000).toLocaleDateString()}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {proposalPassed.quorumReached && (
                    <span className="text-green-600">✓ Quorum</span>
                  )}
                  {proposalPassed.passed && (
                    <span className="text-green-600 font-medium">✓ Passed</span>
                  )}
                </div>
              </div>

              {/* Call Data Info */}
              {proposal.callData && proposal.callData.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-xs text-gray-500">
                    Actions: {proposal.callData.length} contract call(s)
                  </p>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {!loading && !error && filteredProposals.length > 0 && (
        <div className="mt-6 flex justify-center">
          <p className="text-sm text-gray-500">
            Showing {filteredProposals.length} of {proposals.length} proposals
          </p>
        </div>
      )}
    </div>
  );
};

export default ProposalList;
