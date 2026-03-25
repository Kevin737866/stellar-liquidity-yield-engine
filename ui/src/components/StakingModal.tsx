/**
 * StakingModal Component
 * 
 * Modal for locking governance tokens to earn voting power and boosted yields.
 */

import React, { useState, useMemo, useEffect } from 'react';
import { LockInfo, formatVotingPower, formatDuration, calculateBoostMultiplier } from '../../sdk/src/governance';

interface StakingModalProps {
  isOpen: boolean;
  onClose: () => void;
  tokenBalance: bigint;
  lockInfo?: LockInfo;
  onCreateLock: (amount: bigint, duration: number) => Promise<void>;
  onIncreaseLock: (amount: bigint) => Promise<void>;
  onExtendLock: (newDuration: number) => Promise<void>;
  onWithdraw: () => Promise<void>;
  loading?: boolean;
}

const StakingModal: React.FC<StakingModalProps> = ({
  isOpen,
  onClose,
  tokenBalance,
  lockInfo,
  onCreateLock,
  onIncreaseLock,
  onExtendLock,
  onWithdraw,
  loading = false
}) => {
  const [activeTab, setActiveTab] = useState<'create' | 'increase' | 'extend' | 'withdraw'>('create');
  const [amount, setAmount] = useState<string>('');
  const [duration, setDuration] = useState<number>(4 * 365 * 24 * 60 * 60); // Default 4 years
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Calculate boost multiplier based on duration
  const boostMultiplier = useMemo(() => {
    return calculateBoostMultiplier(duration);
  }, [duration]);

  // Calculate voting power for given amount and duration
  const estimatedVotingPower = useMemo(() => {
    const amountNum = parseFloat(amount) * 1e7 || 0; // 7 decimals
    if (amountNum <= 0) return BigInt(0);
    
    const maxDuration = 4 * 365 * 24 * 60 * 60;
    const remainingTime = duration;
    const power = BigInt(Math.floor(amountNum)) * BigInt(remainingTime) / BigInt(maxDuration);
    return power;
  }, [amount, duration]);

  // Duration options
  const durationOptions = [
    { label: '1 Week', value: 7 * 24 * 60 * 60, boost: '1.00x' },
    { label: '1 Month', value: 30 * 24 * 60 * 60, boost: '1.03x' },
    { label: '3 Months', value: 90 * 24 * 60 * 60, boost: '1.08x' },
    { label: '6 Months', value: 180 * 24 * 60 * 60, boost: '1.16x' },
    { label: '1 Year', value: 365 * 24 * 60 * 60, boost: '1.32x' },
    { label: '2 Years', value: 2 * 365 * 24 * 60 * 60, boost: '1.65x' },
    { label: '4 Years', value: 4 * 365 * 24 * 60 * 60, boost: '2.50x' },
  ];

  // Quick duration selection
  const selectDuration = (durationValue: number) => {
    setDuration(durationValue);
  };

  // Handle amount change with validation
  const handleAmountChange = (value: string) => {
    // Only allow valid number input
    if (value === '' || /^\d*\.?\d*$/.test(value)) {
      setAmount(value);
    }
  };

  // Set max amount
  const setMaxAmount = () => {
    const balanceNum = Number(tokenBalance) / 1e7;
    setAmount(balanceNum.toFixed(7).replace(/\.?0+$/, ''));
  };

  // Handle submit
  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 1e7));
      
      switch (activeTab) {
        case 'create':
          await onCreateLock(amountBigInt, duration);
          break;
        case 'increase':
          await onIncreaseLock(amountBigInt);
          break;
        case 'extend':
          await onExtendLock(duration);
          break;
        case 'withdraw':
          await onWithdraw();
          break;
      }
      
      // Reset form on success
      setAmount('');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Check if form is valid
  const isFormValid = useMemo(() => {
    const amountNum = parseFloat(amount) * 1e7;
    
    switch (activeTab) {
      case 'create':
        return amountNum > 0 && amountNum <= Number(tokenBalance);
      case 'increase':
        return amountNum > 0 && amountNum <= Number(tokenBalance);
      case 'extend':
        return duration > 0;
      case 'withdraw':
        return lockInfo && lockInfo.endTime * 1000 <= Date.now();
      default:
        return false;
    }
  }, [activeTab, amount, duration, tokenBalance, lockInfo]);

  // Time until lock expiry
  const timeUntilExpiry = useMemo(() => {
    if (!lockInfo) return null;
    const remaining = lockInfo.endTime * 1000 - Date.now();
    if (remaining <= 0) return null;
    return formatDuration(Math.floor(remaining / 1000));
  }, [lockInfo]);

  // Effect to reset state when modal opens
  useEffect(() => {
    if (isOpen) {
      setActiveTab('create');
      setAmount('');
      setDuration(4 * 365 * 24 * 60 * 60);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-black bg-opacity-50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative bg-white rounded-xl shadow-2xl max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-gradient-to-r from-purple-600 to-blue-600 px-6 py-4 flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold text-white">Lock SYGT Tokens</h2>
            <p className="text-sm text-purple-100">Earn voting power & boosted yields</p>
          </div>
          <button
            onClick={onClose}
            className="text-white hover:text-purple-200 p-2"
            aria-label="Close"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Current Lock Info */}
          {lockInfo && lockInfo.amount > BigInt(0) && (
            <div className="bg-purple-50 rounded-lg p-4">
              <div className="flex justify-between items-center">
                <div>
                  <p className="text-sm text-purple-600 font-medium">Current Lock</p>
                  <p className="text-2xl font-bold text-purple-900">
                    {formatVotingPower(lockInfo.amount)}
                  </p>
                  <p className="text-sm text-purple-600">SYGT</p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-purple-600">Boost</p>
                  <p className="text-lg font-bold text-purple-900">
                    {(lockInfo.boostMultiplier / 100).toFixed(2)}x
                  </p>
                  {timeUntilExpiry && (
                    <p className="text-xs text-gray-500">
                      Expires in {timeUntilExpiry}
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-3 pt-3 border-t border-purple-200">
                <p className="text-sm text-gray-600">
                  Voting Power: <span className="font-semibold">{formatVotingPower(lockInfo.votingPower)}</span>
                </p>
                <p className="text-xs text-gray-500 mt-1">
                  Locked until: {new Date(lockInfo.endTime * 1000).toLocaleDateString()}
                </p>
              </div>
            </div>
          )}

          {/* Tabs */}
          <div className="flex border-b border-gray-200">
            <button
              onClick={() => setActiveTab('create')}
              className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === 'create'
                  ? 'border-b-2 border-purple-500 text-purple-600'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Create Lock
            </button>
            {lockInfo && lockInfo.amount > BigInt(0) && (
              <>
                <button
                  onClick={() => setActiveTab('increase')}
                  className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                    activeTab === 'increase'
                      ? 'border-b-2 border-purple-500 text-purple-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Increase
                </button>
                <button
                  onClick={() => setActiveTab('extend')}
                  className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                    activeTab === 'extend'
                      ? 'border-b-2 border-purple-500 text-purple-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Extend
                </button>
                <button
                  onClick={() => setActiveTab('withdraw')}
                  className={`flex-1 px-4 py-2 text-sm font-medium transition-colors ${
                    activeTab === 'withdraw'
                      ? 'border-b-2 border-purple-500 text-purple-600'
                      : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  Withdraw
                </button>
              </>
            )}
          </div>

          {/* Tab Content */}
          <div className="space-y-4">
            {/* Create Lock Tab */}
            {activeTab === 'create' && (
              <>
                {/* Amount Input */}
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-sm font-medium text-gray-700">
                      Amount to Lock
                    </label>
                    <button
                      onClick={setMaxAmount}
                      className="text-xs text-purple-600 hover:text-purple-700"
                    >
                      Max: {Number(tokenBalance) / 1e7}
                    </button>
                  </div>
                  <div className="relative">
                    <input
                      type="text"
                      value={amount}
                      onChange={(e) => handleAmountChange(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-lg"
                    />
                    <span className="absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-500">
                      SYGT
                    </span>
                  </div>
                </div>

                {/* Duration Selection */}
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Lock Duration
                  </label>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    {durationOptions.map(option => (
                      <button
                        key={option.value}
                        onClick={() => selectDuration(option.value)}
                        className={`p-2 rounded-lg border text-sm transition-colors ${
                          duration === option.value
                            ? 'border-purple-500 bg-purple-50 text-purple-700'
                            : 'border-gray-200 hover:border-gray-300'
                        }`}
                      >
                        <div className="font-medium">{option.label}</div>
                        <div className="text-xs text-gray-500">{option.boost} boost</div>
                      </button>
                    ))}
                  </div>
                  <input
                    type="range"
                    min={7 * 24 * 60 * 60}
                    max={4 * 365 * 24 * 60 * 60}
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                    className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>1 Week</span>
                    <span>4 Years</span>
                  </div>
                </div>

                {/* Preview */}
                <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Lock Duration</span>
                    <span className="font-medium">{formatDuration(duration)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Boost Multiplier</span>
                    <span className="font-medium text-purple-600">
                      {(boostMultiplier / 100).toFixed(2)}x
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Voting Power</span>
                    <span className="font-medium text-blue-600">
                      {formatVotingPower(estimatedVotingPower)}
                    </span>
                  </div>
                </div>
              </>
            )}

            {/* Increase Lock Tab */}
            {activeTab === 'increase' && lockInfo && (
              <>
                <p className="text-sm text-gray-600">
                  Add more SYGT to your existing lock to increase voting power.
                </p>
                
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <label className="text-sm font-medium text-gray-700">
                      Additional Amount
                    </label>
                    <button
                      onClick={setMaxAmount}
                      className="text-xs text-purple-600 hover:text-purple-700"
                    >
                      Max: {Number(tokenBalance) / 1e7}
                    </button>
                  </div>
                  <div className="relative">
                    <input
                      type="text"
                      value={amount}
                      onChange={(e) => handleAmountChange(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-transparent text-lg"
                    />
                    <span className="absolute right-4 top-1/2 transform -translate-y-1/2 text-gray-500">
                      SYGT
                    </span>
                  </div>
                </div>

                <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Current Lock</span>
                    <span className="font-medium">{formatVotingPower(lockInfo.amount)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">After Increase</span>
                    <span className="font-medium text-purple-600">
                      {formatVotingPower(
                        lockInfo.amount + BigInt(Math.floor(parseFloat(amount || '0') * 1e7))
                      )}
                    </span>
                  </div>
                </div>
              </>
            )}

            {/* Extend Lock Tab */}
            {activeTab === 'extend' && lockInfo && (
              <>
                <p className="text-sm text-gray-600">
                  Extend your lock duration to increase boost multiplier.
                </p>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    New Lock Duration
                  </label>
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    {durationOptions
                      .filter(opt => opt.value > (lockInfo.endTime - lockInfo.startTime))
                      .map(option => (
                        <button
                          key={option.value}
                          onClick={() => selectDuration(option.value)}
                          className={`p-2 rounded-lg border text-sm transition-colors ${
                            duration === option.value
                              ? 'border-purple-500 bg-purple-50 text-purple-700'
                              : 'border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <div className="font-medium">{option.label}</div>
                          <div className="text-xs text-gray-500">{option.boost} boost</div>
                        </button>
                      ))}
                  </div>
                </div>

                <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Current Boost</span>
                    <span className="font-medium">{(lockInfo.boostMultiplier / 100).toFixed(2)}x</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">New Boost</span>
                    <span className="font-medium text-purple-600">
                      {(boostMultiplier / 100).toFixed(2)}x
                    </span>
                  </div>
                </div>
              </>
            )}

            {/* Withdraw Tab */}
            {activeTab === 'withdraw' && lockInfo && (
              <>
                {timeUntilExpiry ? (
                  <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                    <p className="text-yellow-800 font-medium">
                      Your lock has not expired yet.
                    </p>
                    <p className="text-sm text-yellow-600 mt-1">
                      Time remaining: {timeUntilExpiry}
                    </p>
                  </div>
                ) : (
                  <>
                    <p className="text-sm text-gray-600">
                      Your lock has expired. You can now withdraw your SYGT tokens.
                    </p>
                    
                    <div className="bg-gray-50 rounded-lg p-4">
                      <div className="flex justify-between text-sm">
                        <span className="text-gray-600">Tokens to Withdraw</span>
                        <span className="font-medium">{formatVotingPower(lockInfo.amount)}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-2">
                        Note: You will lose your voting power and boost multiplier.
                      </p>
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          {/* Submit Button */}
          <button
            onClick={handleSubmit}
            disabled={!isFormValid || isSubmitting || loading}
            className={`w-full py-3 rounded-lg font-semibold transition-colors ${
              activeTab === 'withdraw' && timeUntilExpiry
                ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                : 'bg-purple-600 hover:bg-purple-700 text-white'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {isSubmitting || loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Processing...
              </span>
            ) : (
              <>
                {activeTab === 'create' && 'Create Lock'}
                {activeTab === 'increase' && 'Increase Lock'}
                {activeTab === 'extend' && 'Extend Lock'}
                {activeTab === 'withdraw' && 'Withdraw Tokens'}
              </>
            )}
          </button>

          {/* Info */}
          <div className="bg-blue-50 rounded-lg p-4">
            <h4 className="text-sm font-semibold text-blue-900 mb-2">How Locking Works</h4>
            <ul className="text-xs text-blue-700 space-y-1">
              <li>• Lock SYGT for up to 4 years to earn voting power</li>
              <li>• Longer locks get higher boost multipliers (up to 2.5x)</li>
              <li>• Boosted balances earn higher vault yields</li>
              <li>• You cannot withdraw early - tokens are locked until expiry</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StakingModal;
