import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
    PieChart,
    Pie,
    Cell,
    ResponsiveContainer,
    Tooltip,
    Legend
} from 'recharts';
import {
    FaCoins,
    FaSync,
    FaDownload,
    FaCog,
    FaExclamationTriangle,
    FaCheck,
    FaClock,
    FaExchangeAlt,
    FaUndo,
    FaChartPie,
    FaHistory,
    FaCog as FaSettings,
    FaChevronDown,
    FaChevronUp,
    FaInfoCircle
} from 'react-icons/fa';

// Types
interface RewardStream {
    index: number;
    token: string;
    tokenSymbol: string;
    ratePerSecond: string;
    totalDistributed: string;
    lastUpdate: number;
    isActive: boolean;
    decimals: number;
}

interface PendingReward {
    token: string;
    tokenSymbol: string;
    amount: string;
    amountNormalized: number;
    usdValue: number;
    priceUsd: number;
}

interface AutoCompoundConfig {
    token: string;
    reinvestPercentage: number;
    enabled: boolean;
}

interface RewardHistoryEntry {
    timestamp: number;
    streamIndex: number;
    token: string;
    tokenSymbol: string;
    amount: string;
    amountUsd: number;
    transactionHash: string;
    type: 'claim' | 'auto_compound' | 'reinvest';
}

interface SwapQuote {
    inputToken: string;
    outputToken: string;
    inputAmount: string;
    expectedOutput: string;
    minimumOutput: string;
    priceImpactBps: number;
    protocolFee: string;
}

interface ClaimResult {
    success: boolean;
    transactionHash?: string;
    error?: string;
}

// Token colors for pie chart
const TOKEN_COLORS: Record<string, string> = {
    'USDC': '#2775CA',
    'XLM': '#14B6E7',
    'GOV': '#6B5B95',
    'USDT': '#26A17B',
    'BTC': '#F7931A',
    'ETH': '#627EEA',
    'EUR': '#003399',
    'default': '#8884d8'
};

// Chart configuration
const CHART_CONFIG = {
    innerRadius: 60,
    outerRadius: 100,
    paddingAngle: 2,
    cornerRadius: 4
};

export const RewardDashboard: React.FC<RewardDashboardProps> = ({
    user,
    vault,
    rewardStreams,
    pendingRewards,
    onClaim,
    onSetAutoCompound,
    onClaimAndConvert,
    onEmergencyWithdraw,
    horizonServer,
    networkPassphrase,
}) => {
    // State
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [showConvertModal, setShowConvertModal] = useState<boolean>(false);
    const [showAutoCompoundPanel, setShowAutoCompoundPanel] = useState<boolean>(false);
    const [showHistoryPanel, setShowHistoryPanel] = useState<boolean>(false);
    const [selectedStreams, setSelectedStreams] = useState<Set<number>>(new Set());
    const [convertToToken, setConvertToToken] = useState<string>('USDC');
    const [autoCompoundConfigs, setAutoCompoundConfigs] = useState<Map<string, AutoCompoundConfig>>(new Map());
    const [rewardHistory, setRewardHistory] = useState<RewardHistoryEntry[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);
    const [swapQuote, setSwapQuote] = useState<SwapQuote | null>(null);
    const [isLoadingQuote, setIsLoadingQuote] = useState<boolean>(false);

    // Calculate total USD value
    const totalUsdValue = useMemo(() => {
        return pendingRewards.reduce((sum, reward) => sum + reward.usdValue, 0);
    }, [pendingRewards]);

    // Prepare pie chart data
    const pieChartData = useMemo(() => {
        return pendingRewards
            .filter(reward => reward.amountNormalized > 0)
            .map(reward => ({
                name: reward.tokenSymbol,
                value: reward.amountNormalized,
                usdValue: reward.usdValue,
                token: reward.token,
                fill: TOKEN_COLORS[reward.tokenSymbol] || TOKEN_COLORS.default
            }));
    }, [pendingRewards]);

    // Handle stream selection
    const handleStreamToggle = useCallback((index: number) => {
        setSelectedStreams(prev => {
            const newSet = new Set(prev);
            if (newSet.has(index)) {
                newSet.delete(index);
            } else {
                newSet.add(index);
            }
            return newSet;
        });
    }, []);

    // Handle select all
    const handleSelectAll = useCallback(() => {
        if (selectedStreams.size === pendingRewards.length) {
            setSelectedStreams(new Set());
        } else {
            setSelectedStreams(new Set(pendingRewards.map((_, idx) => idx)));
        }
    }, [pendingRewards, selectedStreams]);

    // Handle claim
    const handleClaim = useCallback(async () => {
        if (selectedStreams.size === 0) return;

        setIsLoading(true);
        setError(null);
        setSuccess(null);

        try {
            const streamIndices = Array.from(selectedStreams);
            const result = await onClaim(streamIndices);

            if (result.success) {
                setSuccess(`Successfully claimed rewards! Tx: ${result.transactionHash?.slice(0, 8)}...`);
                setSelectedStreams(new Set());
            } else {
                setError(result.error || 'Failed to claim rewards');
            }
        } catch (err: any) {
            setError(err.message || 'An error occurred while claiming rewards');
        } finally {
            setIsLoading(false);
        }
    }, [selectedStreams, onClaim]);

    // Handle claim and convert
    const handleClaimAndConvert = useCallback(async () => {
        if (selectedStreams.size === 0 || !convertToToken) return;

        setIsLoading(true);
        setError(null);
        setSuccess(null);

        try {
            const streamIndices = Array.from(selectedStreams);
            const result = await onClaimAndConvert(streamIndices, convertToToken);

            if (result.success) {
                setSuccess(`Successfully claimed and converted to ${convertToToken}! Tx: ${result.transactionHash?.slice(0, 8)}...`);
                setSelectedStreams(new Set());
                setShowConvertModal(false);
            } else {
                setError(result.error || 'Failed to claim and convert rewards');
            }
        } catch (err: any) {
            setError(err.message || 'An error occurred while claiming rewards');
        } finally {
            setIsLoading(false);
        }
    }, [selectedStreams, convertToToken, onClaimAndConvert]);

    // Get swap quote
    const handleGetQuote = useCallback(async (targetToken: string) => {
        if (selectedStreams.size === 0) return;

        setIsLoadingQuote(true);
        try {
            // Calculate total selected amount
            const totalAmount = pendingRewards
                .filter((_, idx) => selectedStreams.has(idx))
                .reduce((sum, reward) => sum + reward.amount, '0');

            // In production, call SDK's getSwapQuote
            const quote: SwapQuote = {
                inputToken: 'multiple',
                outputToken: targetToken,
                inputAmount: totalAmount,
                expectedOutput: totalAmount, // Simplified
                minimumOutput: totalAmount,
                priceImpactBps: 0,
                protocolFee: String(BigInt(totalAmount) * BigInt(25) / BigInt(10000))
            };

            setSwapQuote(quote);
        } catch (err) {
            console.error('Failed to get quote:', err);
        } finally {
            setIsLoadingQuote(false);
        }
    }, [selectedStreams, pendingRewards]);

    // Handle auto-compound config change
    const handleAutoCompoundChange = useCallback(async (token: string, percentage: number, enabled: boolean) => {
        try {
            await onSetAutoCompound(token, percentage, enabled);

            setAutoCompoundConfigs(prev => {
                const newMap = new Map(prev);
                newMap.set(token, { token, reinvestPercentage: percentage, enabled });
                return newMap;
            });

            setSuccess(`Auto-compound settings updated for ${token}`);
        } catch (err: any) {
            setError(err.message || 'Failed to update auto-compound settings');
        }
    }, [onSetAutoCompound]);

    // Handle emergency withdrawal
    const handleEmergencyWithdraw = useCallback(async () => {
        if (!confirm('Are you sure you want to emergency withdraw? This will forfeit any pending rewards.')) {
            return;
        }

        setIsLoading(true);
        setError(null);

        try {
            const result = await onEmergencyWithdraw();

            if (result.success) {
                setSuccess(`Emergency withdrawal successful! Tx: ${result.transactionHash?.slice(0, 8)}...`);
            } else {
                setError(result.error || 'Failed to emergency withdraw');
            }
        } catch (err: any) {
            setError(err.message || 'An error occurred');
        } finally {
            setIsLoading(false);
        }
    }, [onEmergencyWithdraw]);

    // Export history to CSV
    const handleExportCSV = useCallback(() => {
        const headers = [
            'Timestamp',
            'Date',
            'Stream Index',
            'Token',
            'Token Symbol',
            'Amount',
            'USD Value',
            'Transaction Hash',
            'Type'
        ];

        const rows = rewardHistory.map(entry => [
            entry.timestamp.toString(),
            new Date(entry.timestamp).toISOString(),
            entry.streamIndex.toString(),
            entry.token,
            entry.tokenSymbol,
            entry.amount,
            entry.amountUsd.toFixed(2),
            entry.transactionHash,
            entry.type
        ]);

        const csv = [
            headers.join(','),
            ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
        ].join('\n');

        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `reward-history-${user}-${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }, [rewardHistory, user]);

    // Format amount
    const formatAmount = useCallback((amount: string | number, decimals: number = 7) => {
        const num = typeof amount === 'string' ? parseFloat(amount) : amount;
        return num.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: decimals > 7 ? 8 : 2
        });
    }, []);

    // Format USD
    const formatUsd = useCallback((value: number) => {
        return value.toLocaleString(undefined, {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        });
    }, []);

    return (
        <div className="reward-dashboard">
            {/* Header */}
            <div className="dashboard-header">
                <div className="header-title">
                    <FaCoins className="header-icon" />
                    <h2>Reward Dashboard</h2>
                </div>
                <div className="header-actions">
                    <button
                        className="btn btn-secondary"
                        onClick={() => setShowAutoCompoundPanel(!showAutoCompoundPanel)}
                    >
                        <FaCog />
                        Auto-Compound
                    </button>
                    <button
                        className="btn btn-secondary"
                        onClick={() => setShowHistoryPanel(!showHistoryPanel)}
                    >
                        <FaHistory />
                        History
                    </button>
                    <button
                        className="btn btn-danger"
                        onClick={handleEmergencyWithdraw}
                        disabled={isLoading}
                    >
                        <FaExclamationTriangle />
                        Emergency Withdraw
                    </button>
                </div>
            </div>

            {/* Error/Success Messages */}
            {error && (
                <div className="alert alert-error">
                    <FaExclamationTriangle />
                    {error}
                    <button onClick={() => setError(null)}>×</button>
                </div>
            )}
            {success && (
                <div className="alert alert-success">
                    <FaCheck />
                    {success}
                    <button onClick={() => setSuccess(null)}>×</button>
                </div>
            )}

            <div className="dashboard-content">
                {/* Left Column - Pie Chart and Summary */}
                <div className="dashboard-left">
                    {/* Pie Chart */}
                    <div className="card chart-card">
                        <div className="card-header">
                            <FaChartPie />
                            <h3>Reward Distribution</h3>
                        </div>
                        <div className="chart-container">
                            {pieChartData.length > 0 ? (
                                <ResponsiveContainer width="100%" height={250}>
                                    <PieChart>
                                        <Pie
                                            data={pieChartData}
                                            cx="50%"
                                            cy="50%"
                                            innerRadius={CHART_CONFIG.innerRadius}
                                            outerRadius={CHART_CONFIG.outerRadius}
                                            paddingAngle={CHART_CONFIG.paddingAngle}
                                            dataKey="value"
                                        >
                                            {pieChartData.map((entry, index) => (
                                                <Cell
                                                    key={`cell-${index}`}
                                                    fill={entry.fill}
                                                    stroke="#fff"
                                                    strokeWidth={2}
                                                />
                                            ))}
                                        </Pie>
                                        <Tooltip
                                            formatter={(value: any, name: string, props: any) => [
                                                `${formatAmount(value)} ${name}`,
                                                formatUsd(props.payload.usdValue)
                                            ]}
                                            contentStyle={{
                                                backgroundColor: '#1a1a2e',
                                                border: '1px solid #333',
                                                borderRadius: '8px'
                                            }}
                                        />
                                        <Legend
                                            verticalAlign="bottom"
                                            height={36}
                                            formatter={(value, entry: any) => (
                                                <span style={{ color: '#fff' }}>
                                                    {value} ({formatUsd(entry.payload.usdValue)})
                                                </span>
                                            )}
                                        />
                                    </PieChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="no-rewards">
                                    <FaCoins />
                                    <p>No pending rewards</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Total Summary */}
                    <div className="card summary-card">
                        <div className="card-header">
                            <FaCoins />
                            <h3>Total Pending Rewards</h3>
                        </div>
                        <div className="summary-content">
                            <div className="total-usd">
                                {formatUsd(totalUsdValue)}
                            </div>
                            <div className="reward-count">
                                {pendingRewards.length} active stream{pendingRewards.length !== 1 ? 's' : ''}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Column - Reward Streams Table */}
                <div className="dashboard-right">
                    <div className="card rewards-card">
                        <div className="card-header">
                            <FaCoins />
                            <h3>Pending Rewards by Stream</h3>
                            <div className="header-actions-inline">
                                <button
                                    className="btn btn-small"
                                    onClick={handleSelectAll}
                                >
                                    {selectedStreams.size === pendingRewards.length ? 'Deselect All' : 'Select All'}
                                </button>
                            </div>
                        </div>

                        <div className="rewards-table-container">
                            <table className="rewards-table">
                                <thead>
                                    <tr>
                                        <th className="checkbox-col"></th>
                                        <th>Token</th>
                                        <th>Amount</th>
                                        <th>USD Value</th>
                                        <th>Rate/sec</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {pendingRewards.map((reward, index) => (
                                        <tr
                                            key={reward.token}
                                            className={selectedStreams.has(index) ? 'selected' : ''}
                                        >
                                            <td className="checkbox-col">
                                                <input
                                                    type="checkbox"
                                                    checked={selectedStreams.has(index)}
                                                    onChange={() => handleStreamToggle(index)}
                                                />
                                            </td>
                                            <td>
                                                <div className="token-cell">
                                                    <span
                                                        className="token-badge"
                                                        style={{ backgroundColor: TOKEN_COLORS[reward.tokenSymbol] || TOKEN_COLORS.default }}
                                                    >
                                                        {reward.tokenSymbol}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="amount-cell">
                                                {formatAmount(reward.amountNormalized)} {reward.tokenSymbol}
                                            </td>
                                            <td className="usd-cell">
                                                {formatUsd(reward.usdValue)}
                                            </td>
                                            <td className="rate-cell">
                                                {reward.priceUsd > 0
                                                    ? `${(reward.priceUsd / 86400 * 10000000 / 1e7).toFixed(6)}/sec`
                                                    : 'N/A'
                                                }
                                            </td>
                                            <td className="actions-cell">
                                                <button
                                                    className="btn btn-small btn-icon"
                                                    title="Claim"
                                                    onClick={() => {
                                                        setSelectedStreams(new Set([index]));
                                                    }}
                                                >
                                                    <FaCoins />
                                                </button>
                                                <button
                                                    className="btn btn-small btn-icon"
                                                    title="Claim & Convert"
                                                    onClick={() => {
                                                        setSelectedStreams(new Set([index]));
                                                        setShowConvertModal(true);
                                                    }}
                                                >
                                                    <FaExchangeAlt />
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {/* Claim Actions */}
                        {selectedStreams.size > 0 && (
                            <div className="claim-actions">
                                <div className="selected-summary">
                                    {selectedStreams.size} stream{selectedStreams.size !== 1 ? 's' : ''} selected
                                </div>
                                <div className="action-buttons">
                                    <button
                                        className="btn btn-primary"
                                        onClick={handleClaim}
                                        disabled={isLoading}
                                    >
                                        {isLoading ? 'Claiming...' : 'Claim Selected'}
                                    </button>
                                    <button
                                        className="btn btn-secondary"
                                        onClick={() => setShowConvertModal(true)}
                                        disabled={isLoading}
                                    >
                                        <FaExchangeAlt />
                                        Claim & Convert
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Auto-Compound Panel */}
            {showAutoCompoundPanel && (
                <div className="modal-overlay">
                    <div className="modal auto-compound-panel">
                        <div className="modal-header">
                            <FaCog />
                            <h3>Auto-Compound Configuration</h3>
                            <button className="close-btn" onClick={() => setShowAutoCompoundPanel(false)}>×</button>
                        </div>
                        <div className="modal-content">
                            <p className="info-text">
                                <FaInfoCircle />
                                Configure automatic reinvestment for each reward token.
                                Set percentage to reinvest (remaining is claimed).
                            </p>

                            <div className="auto-compound-list">
                                {rewardStreams.map(stream => {
                                    const config = autoCompoundConfigs.get(stream.token) || {
                                        token: stream.token,
                                        reinvestPercentage: 0,
                                        enabled: false
                                    };

                                    return (
                                        <div key={stream.token} className="auto-compound-item">
                                            <div className="token-info">
                                                <span
                                                    className="token-badge"
                                                    style={{ backgroundColor: TOKEN_COLORS[stream.tokenSymbol] || TOKEN_COLORS.default }}
                                                >
                                                    {stream.tokenSymbol}
                                                </span>
                                            </div>
                                            <div className="slider-container">
                                                <input
                                                    type="range"
                                                    min="0"
                                                    max="100"
                                                    value={config.reinvestPercentage / 100}
                                                    onChange={(e) => handleAutoCompoundChange(
                                                        stream.token,
                                                        parseInt(e.target.value) * 100,
                                                        config.enabled
                                                    )}
                                                    disabled={!config.enabled}
                                                />
                                                <span className="slider-value">
                                                    {config.reinvestPercentage / 100}% reinvest
                                                </span>
                                            </div>
                                            <div className="toggle-container">
                                                <label className="toggle">
                                                    <input
                                                        type="checkbox"
                                                        checked={config.enabled}
                                                        onChange={(e) => handleAutoCompoundChange(
                                                            stream.token,
                                                            config.reinvestPercentage,
                                                            e.target.checked
                                                        )}
                                                    />
                                                    <span className="slider"></span>
                                                </label>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Convert Modal */}
            {showConvertModal && (
                <div className="modal-overlay">
                    <div className="modal convert-modal">
                        <div className="modal-header">
                            <FaExchangeAlt />
                            <h3>Claim & Convert Rewards</h3>
                            <button className="close-btn" onClick={() => setShowConvertModal(false)}>×</button>
                        </div>
                        <div className="modal-content">
                            <div className="convert-summary">
                                <div className="summary-row">
                                    <span>Selected Streams:</span>
                                    <span>{selectedStreams.size}</span>
                                </div>
                                <div className="summary-row">
                                    <span>Total Value:</span>
                                    <span>
                                        {formatUsd(
                                            pendingRewards
                                                .filter((_, idx) => selectedStreams.has(idx))
                                                .reduce((sum, r) => sum + r.usdValue, 0)
                                        )}
                                    </span>
                                </div>
                            </div>

                            <div className="target-token-select">
                                <label>Convert to:</label>
                                <select
                                    value={convertToToken}
                                    onChange={(e) => {
                                        setConvertToToken(e.target.value);
                                        handleGetQuote(e.target.value);
                                    }}
                                >
                                    <option value="USDC">USDC</option>
                                    <option value="XLM">XLM</option>
                                    <option value="USDT">USDT</option>
                                </select>
                            </div>

                            {swapQuote && (
                                <div className="quote-details">
                                    <div className="quote-row">
                                        <span>Expected Output:</span>
                                        <span>{formatAmount(swapQuote.expectedOutput)} {convertToToken}</span>
                                    </div>
                                    <div className="quote-row">
                                        <span>Minimum Output:</span>
                                        <span>{formatAmount(swapQuote.minimumOutput)} {convertToToken}</span>
                                    </div>
                                    <div className="quote-row fee">
                                        <span>Protocol Fee (0.25%):</span>
                                        <span>{formatAmount(swapQuote.protocolFee)} {convertToToken}</span>
                                    </div>
                                    <div className="quote-row">
                                        <span>Price Impact:</span>
                                        <span>{swapQuote.priceImpactBps / 100}%</span>
                                    </div>
                                </div>
                            )}

                            <div className="modal-actions">
                                <button
                                    className="btn btn-secondary"
                                    onClick={() => setShowConvertModal(false)}
                                >
                                    Cancel
                                </button>
                                <button
                                    className="btn btn-primary"
                                    onClick={handleClaimAndConvert}
                                    disabled={isLoading}
                                >
                                    {isLoading ? 'Processing...' : 'Confirm & Convert'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* History Panel */}
            {showHistoryPanel && (
                <div className="modal-overlay">
                    <div className="modal history-panel">
                        <div className="modal-header">
                            <FaHistory />
                            <h3>Reward History</h3>
                            <button className="close-btn" onClick={() => setShowHistoryPanel(false)}>×</button>
                        </div>
                        <div className="modal-content">
                            <div className="history-actions">
                                <button
                                    className="btn btn-secondary"
                                    onClick={handleExportCSV}
                                    disabled={rewardHistory.length === 0}
                                >
                                    <FaDownload />
                                    Export CSV
                                </button>
                            </div>

                            <div className="history-table-container">
                                <table className="history-table">
                                    <thead>
                                        <tr>
                                            <th>Date</th>
                                            <th>Type</th>
                                            <th>Token</th>
                                            <th>Amount</th>
                                            <th>USD Value</th>
                                            <th>Tx Hash</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {rewardHistory.length === 0 ? (
                                            <tr>
                                                <td colSpan={6} className="no-history">
                                                    No reward history available
                                                </td>
                                            </tr>
                                        ) : (
                                            rewardHistory.map((entry, idx) => (
                                                <tr key={idx}>
                                                    <td>{new Date(entry.timestamp).toLocaleDateString()}</td>
                                                    <td>
                                                        <span className={`type-badge ${entry.type}`}>
                                                            {entry.type.replace('_', ' ')}
                                                        </span>
                                                    </td>
                                                    <td>{entry.tokenSymbol}</td>
                                                    <td>{formatAmount(entry.amount)}</td>
                                                    <td>{formatUsd(entry.amountUsd)}</td>
                                                    <td>
                                                        <a
                                                            href={`https://stellar.expert/explorer/testnet/tx/${entry.transactionHash}`}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                        >
                                                            {entry.transactionHash.slice(0, 8)}...
                                                        </a>
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Loading Overlay */}
            {isLoading && (
                <div className="loading-overlay">
                    <div className="spinner"></div>
                    <p>Processing...</p>
                </div>
            )}

            <style>{`
        .reward-dashboard {
          padding: 24px;
          background: #0f0f1a;
          min-height: 100vh;
          color: #fff;
        }

        .dashboard-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 24px;
          padding-bottom: 16px;
          border-bottom: 1px solid #333;
        }

        .header-title {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .header-title h2 {
          margin: 0;
          font-size: 24px;
          font-weight: 600;
        }

        .header-icon {
          font-size: 28px;
          color: #ffd700;
        }

        .header-actions {
          display: flex;
          gap: 12px;
        }

        .btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px;
          border: none;
          border-radius: 8px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-primary {
          background: #4c1d95;
          color: #fff;
        }

        .btn-primary:hover {
          background: #6d28d9;
        }

        .btn-secondary {
          background: #374151;
          color: #fff;
        }

        .btn-secondary:hover {
          background: #4b5563;
        }

        .btn-danger {
          background: #dc2626;
          color: #fff;
        }

        .btn-danger:hover {
          background: #ef4444;
        }

        .btn-small {
          padding: 6px 12px;
          font-size: 12px;
        }

        .btn-icon {
          padding: 6px;
        }

        .btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .alert {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          border-radius: 8px;
          margin-bottom: 16px;
        }

        .alert-error {
          background: rgba(220, 38, 38, 0.2);
          border: 1px solid #dc2626;
          color: #fca5a5;
        }

        .alert-success {
          background: rgba(16, 185, 129, 0.2);
          border: 1px solid #10b981;
          color: #6ee7b7;
        }

        .alert button {
          margin-left: auto;
          background: none;
          border: none;
          color: inherit;
          font-size: 18px;
          cursor: pointer;
        }

        .dashboard-content {
          display: grid;
          grid-template-columns: 350px 1fr;
          gap: 24px;
        }

        .dashboard-left {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }

        .card {
          background: #1a1a2e;
          border-radius: 12px;
          padding: 20px;
          border: 1px solid #333;
        }

        .card-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 16px;
          padding-bottom: 12px;
          border-bottom: 1px solid #333;
        }

        .card-header h3 {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
        }

        .chart-container {
          min-height: 250px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .no-rewards {
          text-align: center;
          color: #888;
        }

        .no-rewards svg {
          font-size: 48px;
          margin-bottom: 12px;
        }

        .summary-content {
          text-align: center;
        }

        .total-usd {
          font-size: 32px;
          font-weight: 700;
          color: #ffd700;
          margin-bottom: 8px;
        }

        .reward-count {
          color: #888;
          font-size: 14px;
        }

        .rewards-table-container {
          overflow-x: auto;
        }

        .rewards-table {
          width: 100%;
          border-collapse: collapse;
        }

        .rewards-table th,
        .rewards-table td {
          padding: 12px;
          text-align: left;
          border-bottom: 1px solid #333;
        }

        .rewards-table th {
          font-size: 12px;
          font-weight: 600;
          color: #888;
          text-transform: uppercase;
        }

        .rewards-table tr:hover {
          background: rgba(255, 255, 255, 0.05);
        }

        .rewards-table tr.selected {
          background: rgba(76, 29, 149, 0.3);
        }

        .checkbox-col {
          width: 40px;
        }

        .token-cell {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .token-badge {
          display: inline-block;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 600;
          color: #fff;
        }

        .amount-cell {
          font-weight: 600;
        }

        .usd-cell {
          color: #10b981;
        }

        .rate-cell {
          color: #888;
          font-size: 12px;
        }

        .claim-actions {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 16px;
          margin-top: 16px;
          background: rgba(76, 29, 149, 0.2);
          border-radius: 8px;
        }

        .selected-summary {
          color: #888;
        }

        .action-buttons {
          display: flex;
          gap: 12px;
        }

        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 1000;
        }

        .modal {
          background: #1a1a2e;
          border-radius: 12px;
          padding: 24px;
          width: 90%;
          max-width: 500px;
          max-height: 80vh;
          overflow-y: auto;
          border: 1px solid #333;
        }

        .modal-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 20px;
          padding-bottom: 16px;
          border-bottom: 1px solid #333;
        }

        .modal-header h3 {
          margin: 0;
          flex: 1;
        }

        .close-btn {
          background: none;
          border: none;
          color: #888;
          font-size: 24px;
          cursor: pointer;
        }

        .close-btn:hover {
          color: #fff;
        }

        .info-text {
          display: flex;
          align-items: flex-start;
          gap: 8px;
          padding: 12px;
          background: rgba(59, 130, 246, 0.1);
          border-radius: 8px;
          font-size: 14px;
          color: #93c5fd;
          margin-bottom: 20px;
        }

        .auto-compound-list {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .auto-compound-item {
          display: flex;
          align-items: center;
          gap: 16px;
          padding: 16px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 8px;
        }

        .slider-container {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .slider-container input[type="range"] {
          width: 100%;
        }

        .slider-value {
          font-size: 14px;
          color: #888;
        }

        .toggle {
          position: relative;
          display: inline-block;
          width: 48px;
          height: 24px;
        }

        .toggle input {
          opacity: 0;
          width: 0;
          height: 0;
        }

        .toggle .slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: #374151;
          transition: 0.3s;
          border-radius: 24px;
        }

        .toggle .slider:before {
          position: absolute;
          content: "";
          height: 18px;
          width: 18px;
          left: 3px;
          bottom: 3px;
          background-color: white;
          transition: 0.3s;
          border-radius: 50%;
        }

        .toggle input:checked + .slider {
          background-color: #4c1d95;
        }

        .toggle input:checked + .slider:before {
          transform: translateX(24px);
        }

        .convert-summary {
          background: rgba(255, 255, 255, 0.05);
          padding: 16px;
          border-radius: 8px;
          margin-bottom: 20px;
        }

        .summary-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .summary-row:last-child {
          margin-bottom: 0;
        }

        .target-token-select {
          margin-bottom: 20px;
        }

        .target-token-select label {
          display: block;
          margin-bottom: 8px;
          font-weight: 500;
        }

        .target-token-select select {
          width: 100%;
          padding: 12px;
          background: #374151;
          border: 1px solid #4b5563;
          border-radius: 8px;
          color: #fff;
          font-size: 16px;
        }

        .quote-details {
          background: rgba(76, 29, 149, 0.2);
          padding: 16px;
          border-radius: 8px;
          margin-bottom: 20px;
        }

        .quote-row {
          display: flex;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .quote-row.fee {
          color: #f59e0b;
        }

        .modal-actions {
          display: flex;
          gap: 12px;
          justify-content: flex-end;
        }

        .history-actions {
          margin-bottom: 16px;
        }

        .history-table-container {
          overflow-x: auto;
        }

        .history-table {
          width: 100%;
          border-collapse: collapse;
        }

        .history-table th,
        .history-table td {
          padding: 12px;
          text-align: left;
          border-bottom: 1px solid #333;
        }

        .type-badge {
          display: inline-block;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 11px;
          text-transform: uppercase;
        }

        .type-badge.claim {
          background: rgba(16, 185, 129, 0.2);
          color: #10b981;
        }

        .type-badge.auto_compound {
          background: rgba(59, 130, 246, 0.2);
          color: #3b82f6;
        }

        .type-badge.reinvest {
          background: rgba(245, 158, 11, 0.2);
          color: #f59e0b;
        }

        .no-history {
          text-align: center;
          color: #888;
        }

        .loading-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.8);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          z-index: 2000;
        }

        .spinner {
          width: 48px;
          height: 48px;
          border: 4px solid #333;
          border-top-color: #4c1d95;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        .loading-overlay p {
          margin-top: 16px;
          color: #fff;
        }

        @media (max-width: 768px) {
          .dashboard-content {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
        </div>
    );
};

export interface RewardDashboardProps {
    user: string;
    vault: string;
    rewardStreams: RewardStream[];
    pendingRewards: PendingReward[];
    onClaim: (streamIndices: number[]) => Promise<ClaimResult>;
    onSetAutoCompound: (token: string, percentage: number, enabled: boolean) => Promise<void>;
    onClaimAndConvert: (streamIndices: number[], targetToken: string) => Promise<ClaimResult>;
    onEmergencyWithdraw: () => Promise<ClaimResult>;
    horizonServer: any;
    networkPassphrase: string;
}

export default RewardDashboard;
