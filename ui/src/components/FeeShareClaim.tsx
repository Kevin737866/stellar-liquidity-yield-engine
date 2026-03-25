/**
 * FeeShareClaim Component
 * 
 * Displays claimable protocol revenue for stakers and handles fee claims.
 */

import React, { useState, useMemo, useEffect } from 'react';

interface WeekData {
  week: number;
  startDate: Date;
  endDate: Date;
  totalFees: bigint;
  userShare: bigint;
  claimed: boolean;
}

interface FeeShareClaimProps {
  userAddress?: string;
  stakeBalance: bigint;
  totalStaked: bigint;
  claimableFees: bigint;
  weeklyData: WeekData[];
  onClaimWeek: (week: number) => Promise<void>;
  onClaimAll: () => Promise<void>;
  loading?: boolean;
  lastDistributionTime?: number;
}

const FeeShareClaim: React.FC<FeeShareClaimProps> = ({
  userAddress,
  stakeBalance,
  totalStaked,
  claimableFees,
  weeklyData,
  onClaimWeek,
  onClaimAll,
  loading = false,
  lastDistributionTime
}) => {
  const [selectedWeeks, setSelectedWeeks] = useState<Set<number>>(new Set());
  const [isClaiming, setIsClaiming] = useState(false);

  // Calculate user's share percentage
  const sharePercentage = useMemo(() => {
    if (totalStaked === BigInt(0)) return 0;
    return (Number(stakeBalance) / Number(totalStaked)) * 100;
  }, [stakeBalance, totalStaked]);

  // Get unclaimed weeks
  const unclaimedWeeks = useMemo(() => {
    return weeklyData.filter(w => !w.claimed);
  }, [weeklyData]);

  // Calculate total claimable
  const totalClaimable = useMemo(() => {
    return unclaimedWeeks.reduce((sum, week) => sum + week.userShare, BigInt(0));
  }, [unclaimedWeeks]);

  // Toggle week selection
  const toggleWeek = (week: number) => {
    const newSelected = new Set(selectedWeeks);
    if (newSelected.has(week)) {
      newSelected.delete(week);
    } else {
      newSelected.add(week);
    }
    setSelectedWeeks(newSelected);
  };

  // Select all unclaimed weeks
  const selectAll = () => {
    setSelectedWeeks(new Set(unclaimedWeeks.map(w => w.week)));
  };

  // Deselect all
  const deselectAll = () => {
    setSelectedWeeks(new Set());
  };

  // Handle individual claim
  const handleClaimWeek = async (week: number) => {
    setIsClaiming(true);
    try {
      await onClaimWeek(week);
    } finally {
      setIsClaiming(false);
    }
  };

  // Handle claim all
  const handleClaimAll = async () => {
    if (selectedWeeks.size === 0) return;
    
    setIsClaiming(true);
    try {
      await onClaimAll();
      setSelectedWeeks(new Set());
    } finally {
      setIsClaiming(false);
    }
  };

  // Format week number to date range
  const formatWeekRange = (week: number): string => {
    const weekStart = new Date(week * 604800 * 1000);
    const weekEnd = new Date((week + 1) * 604800 * 1000);
    return `${weekStart.toLocaleDateString()} - ${weekEnd.toLocaleDateString()}`;
  };

  // Format amount for display
  const formatAmount = (amount: bigint): string => {
    const num = Number(amount) / 1e7;
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(2)}M`;
    } else if (num >= 1000) {
      return `${(num / 1000).toFixed(2)}K`;
    }
    return num.toFixed(2);
  };

  // Get current week
  const currentWeek = Math.floor(Date.now() / 1000 / 604800);

  // Time until next distribution
  const timeUntilNextDistribution = useMemo(() => {
    if (!lastDistributionTime) return null;
    const nextWeek = (Math.floor(Date.now() / 1000 / 604800) + 1) * 604800;
    const remaining = nextWeek - Date.now() / 1000;
    if (remaining <= 0) return 'Soon';
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }, [lastDistributionTime]);

  return (
    <div className="bg-white rounded-lg shadow-md p-6">
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 mb-1">Fee Share</h2>
          <p className="text-gray-600">Claim your share of protocol revenue</p>
        </div>
        <div className="text-right">
          <p className="text-sm text-gray-500">Your Stake</p>
          <p className="text-xl font-bold text-purple-600">
            {formatAmount(stakeBalance)} SYGT
          </p>
          <p className="text-xs text-gray-500">
            {sharePercentage.toFixed(4)}% of total
          </p>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {/* Total Claimable */}
        <div className="bg-gradient-to-br from-green-500 to-emerald-600 rounded-lg p-4 text-white">
          <p className="text-sm opacity-80">Total Claimable</p>
          <p className="text-2xl font-bold mt-1">
            {formatAmount(totalClaimable > BigInt(0) ? totalClaimable : claimableFees)}
          </p>
          <p className="text-xs opacity-80 mt-1">XLM/USDC</p>
        </div>

        {/* Unclaimed Weeks */}
        <div className="bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg p-4 text-white">
          <p className="text-sm opacity-80">Unclaimed Weeks</p>
          <p className="text-2xl font-bold mt-1">{unclaimedWeeks.length}</p>
          <p className="text-xs opacity-80 mt-1">Available to claim</p>
        </div>

        {/* Next Distribution */}
        <div className="bg-gradient-to-br from-orange-500 to-red-500 rounded-lg p-4 text-white">
          <p className="text-sm opacity-80">Next Distribution</p>
          <p className="text-2xl font-bold mt-1">
            {timeUntilNextDistribution || 'Soon'}
          </p>
          <p className="text-xs opacity-80 mt-1">Protocol fees</p>
        </div>
      </div>

      {/* Weekly Breakdown */}
      <div className="mb-6">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-semibold text-gray-900">Weekly Distributions</h3>
          <div className="flex gap-2">
            <button
              onClick={selectAll}
              className="text-xs text-blue-600 hover:text-blue-700"
            >
              Select All
            </button>
            <button
              onClick={deselectAll}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              Deselect All
            </button>
          </div>
        </div>

        {weeklyData.length === 0 ? (
          <div className="bg-gray-50 rounded-lg p-8 text-center">
            <p className="text-gray-500">No fee distributions available yet</p>
            <p className="text-sm text-gray-400 mt-1">
              Protocol fees are distributed weekly to stakers
            </p>
          </div>
        ) : (
          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Select
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Week
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Total Fees
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Your Share
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Status
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {weeklyData.slice(0, 12).map((week) => (
                  <tr 
                    key={week.week} 
                    className={`${
                      week.claimed ? 'bg-gray-50' : 'hover:bg-blue-50'
                    } ${selectedWeeks.has(week.week) ? 'bg-blue-100' : ''}`}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedWeeks.has(week.week)}
                        onChange={() => !week.claimed && toggleWeek(week.week)}
                        disabled={week.claimed}
                        className="h-4 w-4 text-blue-600 rounded border-gray-300"
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-gray-900">
                        Week {week.week}
                      </div>
                      <div className="text-xs text-gray-500">
                        {formatWeekRange(week.week)}
                      </div>
                      {week.week >= currentWeek && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800 mt-1">
                          Current
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="text-sm font-medium text-gray-900">
                        {formatAmount(week.totalFees)}
                      </div>
                      <div className="text-xs text-gray-500">XLM/USDC</div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className={`text-sm font-medium ${
                        week.userShare > BigInt(0) ? 'text-green-600' : 'text-gray-500'
                      }`}>
                        {formatAmount(week.userShare)}
                      </div>
                      <div className="text-xs text-gray-500">
                        {sharePercentage.toFixed(4)}%
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {week.claimed ? (
                        <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-800">
                          Claimed
                        </span>
                      ) : week.userShare > BigInt(0) ? (
                        <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-blue-100 text-blue-800">
                          Claimable
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-800">
                          None
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {!week.claimed && week.userShare > BigInt(0) && (
                        <button
                          onClick={() => handleClaimWeek(week.week)}
                          disabled={isClaiming}
                          className="text-sm text-blue-600 hover:text-blue-700 font-medium disabled:opacity-50"
                        >
                          Claim
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Claim Selected Button */}
      {selectedWeeks.size > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
          <div className="flex justify-between items-center">
            <div>
              <p className="text-sm font-medium text-blue-900">
                {selectedWeeks.size} week{selectedWeeks.size > 1 ? 's' : ''} selected
              </p>
              <p className="text-xs text-blue-600">
                Total: {formatAmount(
                  weeklyData
                    .filter(w => selectedWeeks.has(w.week))
                    .reduce((sum, w) => sum + w.userShare, BigInt(0))
                )} XLM/USDC
              </p>
            </div>
            <button
              onClick={handleClaimAll}
              disabled={isClaiming || loading}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isClaiming ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Claiming...
                </span>
              ) : (
                'Claim Selected'
              )}
            </button>
          </div>
        </div>
      )}

      {/* Info Section */}
      <div className="bg-gray-50 rounded-lg p-4">
        <h4 className="text-sm font-semibold text-gray-900 mb-2">How Fee Sharing Works</h4>
        <ul className="text-xs text-gray-600 space-y-1">
          <li>• Protocol collects fees from performance, withdrawals, and swaps</li>
          <li>• Fees are distributed weekly to SYGT stakers</li>
          <li>• Your share is proportional to your stake vs. total staked</li>
          <li>• Locked SYGT earns higher yields through boost multiplier</li>
          <li>• Claims do not affect your staking position or voting power</li>
        </ul>
      </div>

      {/* Empty State - No Stake */}
      {stakeBalance === BigInt(0) && (
        <div className="mt-6 bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg className="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-yellow-800">
                No SYGT Staked
              </h3>
              <p className="text-sm text-yellow-600 mt-1">
                Stake SYGT tokens to start earning your share of protocol revenue.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default FeeShareClaim;
