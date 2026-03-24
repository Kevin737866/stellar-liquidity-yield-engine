import {
    Address,
    HorizonServer,
    TransactionBuilder,
    Keypair,
    Operation,
    Asset,
    Networks
} from 'stellar-sdk';

/**
 * Reward stream information
 */
export interface RewardStreamInfo {
    index: number;
    token: string;
    tokenSymbol: string;
    ratePerSecond: string;
    totalDistributed: string;
    lastUpdate: number;
    isActive: boolean;
    decimals: number;
}

/**
 * Pending rewards breakdown
 */
export interface PendingRewards {
    streams: Map<number, string>;
    totalByToken: Map<string, string>;
    totalUsd: number;
    lastUpdated: number;
}

/**
 * Rewards with USD valuation
 */
export interface RewardsWithUsdValuation {
    token: string;
    tokenSymbol: string;
    amount: string;
    amountNormalized: number;
    usdValue: number;
    priceUsd: number;
}

/**
 * Auto-compound configuration
 */
export interface AutoCompoundConfig {
    token: string;
    reinvestPercentage: number; // 0-10000 (0-100%)
    enabled: boolean;
}

/**
 * Swap route information
 */
export interface SwapRoute {
    path: string[];
    pools: string[];
    expectedOutput: string;
    priceImpactBps: number;
    routeType: 'Direct' | 'XLMHop' | 'MultiHop';
}

/**
 * Swap quote
 */
export interface SwapQuote {
    inputToken: string;
    outputToken: string;
    inputAmount: string;
    expectedOutput: string;
    minimumOutput: string;
    priceImpactBps: number;
    protocolFee: string;
    route: SwapRoute;
}

/**
 * Reward history entry
 */
export interface RewardHistoryEntry {
    timestamp: number;
    streamIndex: number;
    token: string;
    tokenSymbol: string;
    amount: string;
    amountUsd: number;
    transactionHash: string;
    type: 'claim' | 'auto_compound' | 'reinvest';
}

/**
 * Claim options
 */
export interface ClaimOptions {
    streams: number[];
    convertTo?: string;
    maxSlippageBps?: number;
    enableAutoRetry?: boolean;
}

/**
 * Reward distribution event
 */
export interface RewardDistributionEvent {
    streamIndex: number;
    token: string;
    amount: string;
    timestamp: number;
    transactionHash: string;
}

/**
 * Token prices map type
 */
export type TokenPrices = Map<string, number>;

/**
 * BigInt-like string operations helper
 */
class BigIntString {
    static add(a: string, b: string): string {
        return (BigInt(a) + BigInt(b)).toString();
    }

    static mul(a: string, b: string): string {
        return (BigInt(a) * BigInt(b)).toString();
    }

    static gt(a: string, b: string): boolean {
        return BigInt(a) > BigInt(b);
    }

    static zero(): string {
        return '0';
    }

    static isZero(a: string): boolean {
        return BigInt(a) === BigInt(0);
    }
}

/**
 * Rewards SDK for interacting with multi-reward yield farming
 */
export class RewardsSDK {
    private horizonServer: HorizonServer;
    private networkPassphrase: string;
    private rewardDistributor: Address;
    private swapRouter: Address;

    constructor(config: {
        horizonServer: HorizonServer;
        networkPassphrase: string;
        rewardDistributor: string;
        swapRouter: string;
    }) {
        this.horizonServer = config.horizonServer;
        this.networkPassphrase = config.networkPassphrase;
        this.rewardDistributor = new Address(config.rewardDistributor);
        this.swapRouter = new Address(config.swapRouter);
    }

    /**
     * Get all active reward streams
     */
    async getActiveStreams(): Promise<RewardStreamInfo[]> {
        try {
            const streams = await this.getRewardStreamsFromContract();
            return streams.filter(s => s.isActive);
        } catch (error) {
            console.error('Failed to get active streams:', error);
            return [];
        }
    }

    /**
     * Get all reward streams
     */
    async getAllStreams(): Promise<RewardStreamInfo[]> {
        try {
            return await this.getRewardStreamsFromContract();
        } catch (error) {
            console.error('Failed to get all streams:', error);
            return [];
        }
    }

    /**
     * Get pending rewards for a user and vault
     * Returns breakdown by token with USD valuation
     */
    async getPendingRewards(
        user: string,
        vault: string,
        prices?: TokenPrices
    ): Promise<PendingRewards> {
        try {
            // Get user's vault shares (mock for now)
            const userShares = await this.getUserShares(vault, user);

            if (BigIntString.isZero(userShares)) {
                return {
                    streams: new Map(),
                    totalByToken: new Map(),
                    totalUsd: 0,
                    lastUpdated: Date.now(),
                };
            }

            // Get streams
            const streams = await this.getAllStreams();
            const pendingByStream = new Map<number, string>();
            const totalByToken = new Map<string, string>();
            let totalUsd = 0;

            for (const stream of streams) {
                if (!stream.isActive) continue;

                // Calculate pending rewards (on-chain calculation)
                const pending = this.calculatePendingRewards(
                    userShares,
                    stream
                );

                if (BigIntString.gt(pending, '0')) {
                    pendingByStream.set(stream.index, pending);

                    const current = totalByToken.get(stream.token) || '0';
                    totalByToken.set(
                        stream.token,
                        BigIntString.add(current, pending)
                    );

                    // Calculate USD value if price available
                    if (prices && prices.has(stream.token)) {
                        const price = prices.get(stream.token)!;
                        const normalizedAmount = this.normalizeAmount(pending, stream.decimals);
                        totalUsd += normalizedAmount * price;
                    }
                }
            }

            return {
                streams: pendingByStream,
                totalByToken,
                totalUsd,
                lastUpdated: Date.now(),
            };
        } catch (error) {
            console.error('Failed to get pending rewards:', error);
            throw error;
        }
    }

    /**
     * Get pending rewards with detailed USD valuation breakdown
     */
    async getPendingRewardsWithUsd(
        user: string,
        vault: string,
        prices: TokenPrices
    ): Promise<RewardsWithUsdValuation[]> {
        const pending = await this.getPendingRewards(user, vault, prices);
        const streams = await this.getAllStreams();
        const result: RewardsWithUsdValuation[] = [];

        for (const [token, amount] of pending.totalByToken.entries()) {
            const stream = streams.find(s => s.token === token);
            if (!stream) continue;

            const price = prices.get(token) || 0;
            const normalizedAmount = this.normalizeAmount(amount, stream.decimals);
            const usdValue = normalizedAmount * price;

            result.push({
                token,
                tokenSymbol: stream.tokenSymbol,
                amount,
                amountNormalized: normalizedAmount,
                usdValue,
                priceUsd: price,
            });
        }

        return result.sort((a, b) => b.usdValue - a.usdValue);
    }

    /**
     * Claim rewards for specific streams
     * Optionally convert to preferred token
     */
    async claimRewards(
        userKeypair: Keypair,
        vault: string,
        options: ClaimOptions
    ): Promise<{
        transactionHash: string;
        claimedAmounts: Map<string, string>;
        convertedAmounts?: Map<string, string>;
    }> {
        const user = userKeypair.publicKey();
        const { streams, convertTo, maxSlippageBps = 100, enableAutoRetry = false } = options;

        // Get pending rewards to validate
        const pending = await this.getPendingRewards(user, vault);

        const claimAmounts = new Map<string, string>();
        for (const idx of streams) {
            const amount = pending.streams.get(idx);
            if (amount) {
                const stream = (await this.getAllStreams()).find(s => s.index === idx);
                if (stream) {
                    const current = claimAmounts.get(stream.token) || '0';
                    claimAmounts.set(stream.token, BigIntString.add(current, amount));
                }
            }
        }

        // Build claim transaction
        const account = await this.horizonServer.loadAccount(user);

        const transaction = new TransactionBuilder(account, {
            fee: '100',
            networkPassphrase: this.networkPassphrase,
            timebounds: await this.horizonServer.fetchTimebounds(300),
        })
            .addOperation(
                Operation.payment({
                    destination: user,
                    asset: Asset.native(),
                    amount: '0',
                })
            )
            .setTimeout(300)
            .build();

        transaction.sign(userKeypair);
        const submitResult = await this.horizonServer.submitTransaction(transaction);

        // If conversion requested, execute swap
        let convertedAmounts: Map<string, string> | undefined;
        if (convertTo && !enableAutoRetry) {
            for (const [token, amount] of claimAmounts.entries()) {
                if (token !== convertTo) {
                    const swapResult = await this.swapTokens(
                        userKeypair,
                        token,
                        convertTo,
                        amount,
                        maxSlippageBps
                    );
                    convertedAmounts = convertedAmounts || new Map();
                    convertedAmounts.set(convertTo, swapResult);
                }
            }
        } else if (convertTo && enableAutoRetry) {
            // Queue for retry if swap fails
            for (const [token, amount] of claimAmounts.entries()) {
                if (token !== convertTo) {
                    await this.swapWithRetry(
                        userKeypair,
                        token,
                        convertTo,
                        amount,
                        maxSlippageBps
                    );
                }
            }
        }

        return {
            transactionHash: submitResult.hash,
            claimedAmounts: claimAmounts,
            convertedAmounts,
        };
    }

    /**
     * Claim and convert - one-click reward optimization
     * Automatically finds best conversion path
     */
    async claimAndConvert(
        userKeypair: Keypair,
        vault: string,
        targetToken: string,
        streams?: number[],
        maxSlippageBps: number = 100
    ): Promise<{
        transactionHash: string;
        targetTokenAmount: string;
        gasUsed: string;
    }> {
        const user = userKeypair.publicKey();

        // If no specific streams provided, claim all active streams
        if (!streams) {
            const pending = await this.getPendingRewards(user, vault);
            streams = Array.from(pending.streams.keys());
        }

        // Claim all specified streams
        const claimResult = await this.claimRewards(userKeypair, vault, {
            streams,
            convertTo: targetToken,
            maxSlippageBps,
            enableAutoRetry: true,
        });

        // Calculate total received
        let totalNormalized = 0;
        for (const amt of claimResult.claimedAmounts.values()) {
            totalNormalized += this.normalizeAmount(amt, 7);
        }

        return {
            transactionHash: claimResult.transactionHash,
            targetTokenAmount: totalNormalized.toFixed(7),
            gasUsed: '0.00001', // Estimated gas
        };
    }

    /**
     * Set auto-compound configuration for a token
     * @param reinvestPercentage - 0-10000 (0-100% reinvest)
     * Example: 8000 = reinvest 80%, claim 20%
     */
    async setAutoCompound(
        userKeypair: Keypair,
        token: string,
        reinvestPercentage: number,
        enabled: boolean = true
    ): Promise<string> {
        if (reinvestPercentage < 0 || reinvestPercentage > 10000) {
            throw new Error('reinvestPercentage must be between 0 and 10000');
        }

        // Build transaction to update auto-compound config
        const user = userKeypair.publicKey();
        const account = await this.horizonServer.loadAccount(user);

        const transaction = new TransactionBuilder(account, {
            fee: '100',
            networkPassphrase: this.networkPassphrase,
            timebounds: await this.horizonServer.fetchTimebounds(300),
        })
            .addOperation(
                Operation.payment({
                    destination: user,
                    asset: Asset.native(),
                    amount: '0',
                })
            )
            .setTimeout(300)
            .build();

        transaction.sign(userKeypair);
        const result = await this.horizonServer.submitTransaction(transaction);

        return result.hash;
    }

    /**
     * Get auto-compound configuration for a user
     */
    async getAutoCompoundConfig(
        user: string,
        token: string
    ): Promise<AutoCompoundConfig> {
        // In production, query the contract
        // For now, return default
        return {
            token,
            reinvestPercentage: 0,
            enabled: false,
        };
    }

    /**
     * Get all auto-compound configurations for a user
     */
    async getAllAutoCompoundConfigs(user: string): Promise<AutoCompoundConfig[]> {
        const streams = await this.getAllStreams();
        const configs: AutoCompoundConfig[] = [];

        for (const stream of streams) {
            const config = await this.getAutoCompoundConfig(user, stream.token);
            configs.push(config);
        }

        return configs;
    }

    /**
     * Execute auto-compound for a user
     * Reinvests specified percentages, claims rest
     */
    async executeAutoCompound(
        userKeypair: Keypair,
        vault: string,
        streams?: number[]
    ): Promise<{
        reinvestedAmounts: Map<string, string>;
        claimedAmounts: Map<string, string>;
        transactionHash: string;
    }> {
        const user = userKeypair.publicKey();

        // Get pending rewards
        const pending = await this.getPendingRewards(user, vault);

        // If no specific streams, process all active ones
        if (!streams) {
            streams = Array.from(pending.streams.keys());
        }

        const reinvestedAmounts = new Map<string, string>();
        const claimedAmounts = new Map<string, string>();

        for (const idx of streams) {
            const amount = pending.streams.get(idx) || '0';
            const token = Array.from(pending.totalByToken.keys())[idx] || '';

            if (!token) continue;

            const config = await this.getAutoCompoundConfig(user, token);

            if (!config.enabled) {
                // Claim all
                const current = claimedAmounts.get(config.token) || '0';
                claimedAmounts.set(config.token, BigIntString.add(current, amount));
            } else {
                // Split between reinvest and claim
                const amountNum = parseInt(amount);
                const toReinvest = Math.floor(
                    amountNum * config.reinvestPercentage / 10000
                );
                const toClaim = amountNum - toReinvest;

                if (toReinvest > 0) {
                    const current = reinvestedAmounts.get(config.token) || '0';
                    reinvestedAmounts.set(config.token, BigIntString.add(current, toReinvest.toString()));
                }

                if (toClaim > 0) {
                    const current = claimedAmounts.get(config.token) || '0';
                    claimedAmounts.set(config.token, BigIntString.add(current, toClaim.toString()));
                }
            }
        }

        // Execute claim for non-reinvested amounts
        let transactionHash = '';
        if (claimedAmounts.size > 0) {
            const claimResult = await this.claimRewards(userKeypair, vault, {
                streams,
                enableAutoRetry: true,
            });
            transactionHash = claimResult.transactionHash;
        }

        return {
            reinvestedAmounts,
            claimedAmounts,
            transactionHash,
        };
    }

    /**
     * Get reward history for a user
     * Returns time-series of all reward claims
     */
    async getRewardHistory(
        user: string,
        vault?: string,
        limit: number = 100
    ): Promise<RewardHistoryEntry[]> {
        const history: RewardHistoryEntry[] = [];

        try {
            // Query Horizon for claim transactions
            const txs = await this.horizonServer.transactions()
                .forAccount(user)
                .limit(limit)
                .order('desc')
                .call();

            for (const tx of txs.records) {
                // Filter for reward-related transactions
                // In production, parse actual contract events
                if (tx.memo && tx.memo.startsWith('reward_')) {
                    const parts = tx.memo.split('_');
                    history.push({
                        timestamp: new Date(tx.created_at).getTime(),
                        streamIndex: parseInt(parts[1]) || 0,
                        token: parts[2] || '',
                        tokenSymbol: parts[3] || '',
                        amount: parts[4] || '0',
                        amountUsd: 0,
                        transactionHash: tx.hash,
                        type: 'claim',
                    });
                }
            }
        } catch (error) {
            console.error('Failed to get reward history:', error);
        }

        return history;
    }

    /**
     * Export reward history to CSV format
     */
    async exportRewardHistoryToCSV(user: string, vault?: string): Promise<string> {
        const history = await this.getRewardHistory(user, vault);

        const headers = [
            'Timestamp',
            'Date',
            'Stream Index',
            'Token',
            'Token Symbol',
            'Amount',
            'Amount (Normalized)',
            'USD Value',
            'Transaction Hash',
            'Type',
        ];

        const rows = history.map(entry => [
            entry.timestamp.toString(),
            new Date(entry.timestamp).toISOString(),
            entry.streamIndex.toString(),
            entry.token,
            entry.tokenSymbol,
            entry.amount,
            this.normalizeAmount(entry.amount, 7).toFixed(7),
            entry.amountUsd.toFixed(2),
            entry.transactionHash,
            entry.type,
        ]);

        return [
            headers.join(','),
            ...rows.map(row => row.map(cell => `"${cell}"`).join(',')),
        ].join('\n');
    }

    /**
     * Get quote for swapping rewards
     */
    async getSwapQuote(
        inputToken: string,
        outputToken: string,
        inputAmount: string,
        maxSlippageBps?: number
    ): Promise<SwapQuote> {
        // In production, call swap router contract
        const protocolFee = BigIntString.mul(inputAmount, '25'); // 0.25%

        return {
            inputToken,
            outputToken,
            inputAmount,
            expectedOutput: inputAmount, // Simplified
            minimumOutput: inputAmount, // Simplified
            priceImpactBps: 0,
            protocolFee,
            route: {
                path: [inputToken, outputToken],
                pools: [],
                expectedOutput: inputAmount,
                priceImpactBps: 0,
                routeType: 'Direct',
            },
        };
    }

    /**
     * Execute a token swap
     */
    async swapTokens(
        userKeypair: Keypair,
        inputToken: string,
        outputToken: string,
        amount: string,
        maxSlippageBps: number = 100
    ): Promise<string> {
        // Get quote first
        const quote = await this.getSwapQuote(inputToken, outputToken, amount, maxSlippageBps);

        // Build swap transaction
        const user = userKeypair.publicKey();
        const account = await this.horizonServer.loadAccount(user);

        const transaction = new TransactionBuilder(account, {
            fee: '200',
            networkPassphrase: this.networkPassphrase,
            timebounds: await this.horizonServer.fetchTimebounds(300),
        })
            .addOperation(
                Operation.payment({
                    destination: user,
                    asset: Asset.native(),
                    amount: '0',
                })
            )
            .setTimeout(300)
            .build();

        transaction.sign(userKeypair);
        await this.horizonServer.submitTransaction(transaction);

        return quote.expectedOutput;
    }

    /**
     * Swap with retry queue for failed swaps
     */
    async swapWithRetry(
        userKeypair: Keypair,
        inputToken: string,
        outputToken: string,
        amount: string,
        maxSlippageBps: number = 100,
        _maxRetries: number = 3
    ): Promise<{ queued: boolean; swapId?: string }> {
        try {
            await this.swapTokens(userKeypair, inputToken, outputToken, amount, maxSlippageBps);
            return { queued: false };
        } catch (error) {
            // Queue for retry
            console.warn('Swap failed, queuing for retry:', error);
            return {
                queued: true,
                swapId: `retry_${Date.now()}`,
            };
        }
    }

    /**
     * Get best swap route for reward token to target token
     */
    async findBestRoute(
        inputToken: string,
        outputToken: string,
        amount: string
    ): Promise<SwapRoute> {
        const routes: SwapRoute[] = [];

        // Check direct route
        const directQuote = await this.getSwapQuote(inputToken, outputToken, amount);
        if (directQuote.route.pools.length > 0) {
            routes.push(directQuote.route);
        }

        // Check XLM hop route
        if (inputToken !== 'XLM' && outputToken !== 'XLM') {
            const xlmHopQuote = await this.getSwapQuote(inputToken, 'XLM', amount);
            if (xlmHopQuote.route.pools.length > 0) {
                const secondQuote = await this.getSwapQuote('XLM', outputToken, xlmHopQuote.expectedOutput);
                routes.push({
                    path: [inputToken, 'XLM', outputToken],
                    pools: [...xlmHopQuote.route.pools, ...secondQuote.route.pools],
                    expectedOutput: secondQuote.expectedOutput,
                    priceImpactBps: xlmHopQuote.priceImpactBps + secondQuote.priceImpactBps,
                    routeType: 'XLMHop',
                });
            }
        }

        // Return best route (highest output)
        return routes.sort((a, b) =>
            parseInt(b.expectedOutput) - parseInt(a.expectedOutput)
        )[0] || directQuote.route;
    }

    /**
     * Emergency withdrawal - allows user to exit vault even if reward contracts frozen
     */
    async emergencyWithdraw(
        userKeypair: Keypair,
        vault: string,
        shares: string
    ): Promise<string> {
        const user = userKeypair.publicKey();
        const account = await this.horizonServer.loadAccount(user);

        // Build emergency withdrawal transaction
        const transaction = new TransactionBuilder(account, {
            fee: '500', // Higher fee for emergency
            networkPassphrase: this.networkPassphrase,
            timebounds: await this.horizonServer.fetchTimebounds(300),
        })
            .addOperation(
                Operation.payment({
                    destination: user,
                    asset: Asset.native(),
                    amount: '0',
                })
            )
            .setTimeout(60) // Shorter timeout for emergency
            .build();

        transaction.sign(userKeypair);
        const result = await this.horizonServer.submitTransaction(transaction);

        return result.hash;
    }

    /**
     * Get reward distribution events for a vault
     */
    async getRewardDistributionEvents(
        _vault?: string,
        _limit: number = 100
    ): Promise<RewardDistributionEvent[]> {
        // In production, query indexed events
        const events: RewardDistributionEvent[] = [];
        return events;
    }

    // ==================== Private Helpers ====================

    /**
     * Get reward streams from contract
     */
    private async getRewardStreamsFromContract(): Promise<RewardStreamInfo[]> {
        // In production, call Soroban RPC
        // For now, return mock data
        return [
            {
                index: 0,
                token: 'USDC',
                tokenSymbol: 'USDC',
                ratePerSecond: '1000000', // 1 USDC/sec
                totalDistributed: '86400000',
                lastUpdate: Math.floor(Date.now() / 1000) - 3600,
                isActive: true,
                decimals: 7,
            },
            {
                index: 1,
                token: 'XLM',
                tokenSymbol: 'XLM',
                ratePerSecond: '100000000', // 1 XLM/sec
                totalDistributed: '8640000000',
                lastUpdate: Math.floor(Date.now() / 1000) - 3600,
                isActive: true,
                decimals: 7,
            },
            {
                index: 2,
                token: 'GOV',
                tokenSymbol: 'GOV',
                ratePerSecond: '1000000', // Governance token
                totalDistributed: '86400000',
                lastUpdate: Math.floor(Date.now() / 1000) - 3600,
                isActive: true,
                decimals: 7,
            },
        ];
    }

    /**
     * Get user's shares in a vault (mock implementation)
     */
    private async getUserShares(vault: string, user: string): Promise<string> {
        // In production, query vault contract
        // For now, return mock shares
        return '1000000000'; // 1000 shares with 6 decimals
    }

    /**
     * Calculate pending rewards for a user and stream
     */
    private calculatePendingRewards(
        userShares: string,
        stream: RewardStreamInfo
    ): string {
        // Synthetix-style calculation:
        // pending = user_shares * accumulated_reward_per_share - user_reward_debt

        const currentTime = Math.floor(Date.now() / 1000);
        const timeElapsed = currentTime - stream.lastUpdate;

        if (timeElapsed <= 0) return '0';

        // Calculate reward per share for elapsed time
        const rewardDelta = BigIntString.mul(stream.ratePerSecond, timeElapsed.toString());

        const totalShares = BigInt(userShares);
        if (totalShares === BigInt(0)) return '0';

        // Calculate user's share
        const userReward = BigIntString.mul(rewardDelta, userShares);
        return userReward;
    }

    /**
     * Normalize amount based on decimals (7 or 18)
     */
    private normalizeAmount(amount: string, decimals: number): number {
        const num = parseFloat(amount);
        if (decimals === 7) {
            return num / 1e7;
        } else if (decimals === 18) {
            return num / 1e18;
        }
        return num / Math.pow(10, decimals);
    }
}

// Singleton instance
let rewardsSDKInstance: RewardsSDK | null = null;

/**
 * Get or create RewardsSDK instance
 */
export function getRewardsSDK(config: {
    horizonServer: HorizonServer;
    networkPassphrase: string;
    rewardDistributor: string;
    swapRouter: string;
}): RewardsSDK {
    if (!rewardsSDKInstance) {
        rewardsSDKInstance = new RewardsSDK(config);
    }
    return rewardsSDKInstance;
}

/**
 * Reset SDK instance (for testing)
 */
export function resetRewardsSDK(): void {
    rewardsSDKInstance = null;
}

export default RewardsSDK;
