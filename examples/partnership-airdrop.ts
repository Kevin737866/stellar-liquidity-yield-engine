/**
 * Partnership Airdrop Example
 * 
 * This example demonstrates how a protocol can distribute governance tokens
 * to liquidity providers as part of a partnership or incentive program.
 * 
 * Usage:
 * npx ts-node examples/partnership-airdrop.ts
 */

import { Keypair, Networks, TransactionBuilder, Operation, Asset, HorizonServer } from 'stellar-sdk';
import { RewardsSDK, RewardStreamInfo, PendingRewards } from '../sdk/src/rewards';
import { VaultClient } from '../sdk/src/vaultClient';

// Configuration
const CONFIG = {
    // Horizon server
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,

    // Contract addresses (placeholder - replace with actual addresses)
    rewardDistributor: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    swapRouter: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    governanceToken: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',

    // Partnership configuration
    partnership: {
        name: 'DeFi Alliance Partnership',
        duration: 90 * 24 * 60 * 60, // 90 days in seconds
        totalAllocation: '10000000000000', // 10M tokens (7 decimals)
        dailyRate: Math.floor(10000000000000 / 90).toString(), // Tokens per second
    },

    // Merkle tree root for snapshot
    merkleRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
};

// Types
interface AirdropRecipient {
    address: string;
    amount: string;
    proof: string[];
}

interface AirdropSnapshot {
    merkleRoot: string;
    totalRecipients: number;
    totalAmount: string;
    timestamp: number;
    recipients: Map<string, string>;
}

interface PartnershipStats {
    totalDistributed: string;
    activeRecipients: number;
    totalClaimed: string;
    remainingAllocation: string;
}

/**
 * Partnership Airdrop Manager
 */
class PartnershipAirdrop {
    private rewardsSDK: RewardsSDK;
    private vaultClient: VaultClient;
    private snapshot: AirdropSnapshot | null = null;

    constructor() {
        const horizonServer = new HorizonServer(CONFIG.horizonUrl, CONFIG.networkPassphrase);

        this.rewardsSDK = new RewardsSDK({
            horizonServer,
            networkPassphrase: CONFIG.networkPassphrase,
            rewardDistributor: CONFIG.rewardDistributor,
            swapRouter: CONFIG.swapRouter,
        });

        this.vaultClient = new VaultClient({
            horizonServer,
            networkPassphrase: CONFIG.networkPassphrase,
        });
    }

    /**
     * Generate a Merkle tree from recipients
     * In production, use a proper Merkle tree library
     */
    async generateMerkleTree(recipients: AirdropRecipient[]): Promise<string> {
        // Sort recipients by address
        const sorted = recipients.sort((a, b) => a.address.localeCompare(b.address));

        // Build tree bottom-up (simplified)
        // In production, use proper hashing
        let currentLevel = sorted.map(r => this.hashLeaf(r));

        while (currentLevel.length > 1) {
            const nextLevel: string[] = [];
            for (let i = 0; i < currentLevel.length; i += 2) {
                const left = currentLevel[i];
                const right = currentLevel[i + 1] || left;
                nextLevel.push(this.hashPair(left, right));
            }
            currentLevel = nextLevel;
        }

        return currentLevel[0] || '0x0';
    }

    /**
     * Hash a leaf node
     */
    private hashLeaf(recipient: AirdropRecipient): string {
        const data = `${recipient.address}:${recipient.amount}`;
        return this.hash(data);
    }

    /**
     * Hash a pair of nodes
     */
    private hashPair(left: string, right: string): string {
        const data = `${left}:${right}`;
        return this.hash(data);
    }

    /**
     * Simple hash function (use proper crypto in production)
     */
    private hash(data: string): string {
        // In production, use proper cryptographic hash
        let hash = 0;
        for (let i = 0; i < data.length; i++) {
            const char = data.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return '0x' + Math.abs(hash).toString(16).padStart(64, '0');
    }

    /**
     * Create proof for a recipient
     */
    async createProof(recipient: AirdropRecipient, allRecipients: AirdropRecipient[]): Promise<string[]> {
        const sorted = allRecipients.sort((a, b) => a.address.localeCompare(b.address));
        const index = sorted.findIndex(r => r.address === recipient.address);

        const proof: string[] = [];
        let currentIndex = index;

        // Build proof path
        while (currentIndex > 0) {
            const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
            if (siblingIndex < sorted.length) {
                proof.push(this.hashLeaf(sorted[siblingIndex]));
            }
            currentIndex = Math.floor(currentIndex / 2);
        }

        return proof;
    }

    /**
     * Create airdrop snapshot from vault depositors
     */
    async createSnapshot(vaultAddress: string, minDeposit: string = '10000000'): Promise<AirdropSnapshot> {
        console.log('Creating airdrop snapshot from vault depositors...');

        // In production, query actual vault depositors
        const vaultInfo = await this.vaultClient.getVaultInfo(vaultAddress);

        // Mock recipients based on vault shares
        const recipients: AirdropRecipient[] = [];
        const totalShares = BigInt(vaultInfo.totalShares.toString());

        // Simulate recipients (in production, query actual depositors)
        const mockRecipients = [
            { address: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1', shares: '3000000000' },
            { address: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX2', shares: '2000000000' },
            { address: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX3', shares: '1500000000' },
            { address: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX4', shares: '1000000000' },
            { address: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX5', shares: '2500000000' },
        ];

        for (const mock of mockRecipients) {
            const sharePercentage = (BigInt(mock.shares) * BigInt('1000000')) / totalShares;
            const allocation = (BigInt(CONFIG.partnership.totalAllocation) * sharePercentage) / BigInt('1000000');

            recipients.push({
                address: mock.address,
                amount: allocation.toString(),
                proof: [], // Will be generated
            });
        }

        // Generate proofs
        for (const recipient of recipients) {
            recipient.proof = await this.createProof(recipient, recipients);
        }

        // Generate Merkle root
        const merkleRoot = await this.generateMerkleTree(recipients);

        // Build snapshot
        const recipientMap = new Map<string, string>();
        let totalAmount = BigInt(0);

        for (const r of recipients) {
            recipientMap.set(r.address, r.amount);
            totalAmount += BigInt(r.amount);
        }

        this.snapshot = {
            merkleRoot,
            totalRecipients: recipients.length,
            totalAmount: totalAmount.toString(),
            timestamp: Date.now(),
            recipients: recipientMap,
        };

        console.log(`Snapshot created:`);
        console.log(`  - Total recipients: ${this.snapshot.totalRecipients}`);
        console.log(`  - Total allocation: ${this.formatAmount(this.snapshot.totalAmount)} GOV`);
        console.log(`  - Merkle root: ${this.snapshot.merkleRoot.slice(0, 16)}...`);

        return this.snapshot;
    }

    /**
     * Initialize governance token reward stream
     */
    async initializeGovernanceStream(adminKeypair: Keypair): Promise<RewardStreamInfo> {
        console.log('Initializing governance token reward stream...');

        // Add reward stream to distributor
        const streamIndex = await this.rewardsSDK.getAllStreams().then(streams => {
            // Find next available index
            return streams.length;
        });

        console.log(`Governance stream initialized at index ${streamIndex}`);

        return {
            index: streamIndex,
            token: CONFIG.governanceToken,
            tokenSymbol: 'GOV',
            ratePerSecond: CONFIG.partnership.dailyRate,
            totalDistributed: '0',
            lastUpdate: Math.floor(Date.now() / 1000),
            isActive: true,
            decimals: 7,
        };
    }

    /**
     * Distribute governance tokens to recipients
     */
    async distributeAirdrop(
        adminKeypair: Keypair,
        vaultAddress: string
    ): Promise<{ transactionHash: string; recipientsProcessed: number }> {
        console.log('Distributing governance tokens...');

        if (!this.snapshot) {
            throw new Error('No snapshot created. Run createSnapshot first.');
        }

        // In production, this would interact with the contract
        // For now, simulate distribution

        let processed = 0;
        for (const [address, amount] of this.snapshot.recipients.entries()) {
            // In production: call contract to credit tokens
            console.log(`  Credited ${this.formatAmount(amount)} GOV to ${address.slice(0, 8)}...`);
            processed++;
        }

        console.log(`Distributed to ${processed} recipients`);

        return {
            transactionHash: '0x' + '0'.repeat(64), // Mock hash
            recipientsProcessed: processed,
        };
    }

    /**
     * Check eligibility for airdrop
     */
    async checkEligibility(address: string): Promise<{
        eligible: boolean;
        amount: string;
        claimed: boolean;
    }> {
        if (!this.snapshot) {
            throw new Error('No snapshot created. Run createSnapshot first.');
        }

        const amount = this.snapshot.recipients.get(address);

        if (!amount) {
            return {
                eligible: false,
                amount: '0',
                claimed: false,
            };
        }

        // Check if already claimed
        const pending = await this.rewardsSDK.getPendingRewards(address, CONFIG.rewardDistributor);
        const claimed = pending.totalByToken.has(CONFIG.governanceToken);

        return {
            eligible: true,
            amount,
            claimed,
        };
    }

    /**
     * Claim airdrop rewards
     */
    async claimAirdrop(userKeypair: Keypair): Promise<{
        success: boolean;
        transactionHash?: string;
        amount?: string;
    }> {
        console.log(`Processing airdrop claim for ${userKeypair.publicKey()}`);

        const eligibility = await this.checkEligibility(userKeypair.publicKey());

        if (!eligibility.eligible) {
            return { success: false };
        }

        if (eligibility.claimed) {
            console.log('Already claimed');
            return { success: false };
        }

        // Get streams and find governance stream
        const streams = await this.rewardsSDK.getAllStreams();
        const govStream = streams.find(s => s.tokenSymbol === 'GOV');

        if (!govStream) {
            throw new Error('Governance stream not found');
        }

        // Claim from governance stream
        const result = await this.rewardsSDK.claimRewards(userKeypair, CONFIG.rewardDistributor, {
            streams: [govStream.index],
            enableAutoRetry: true,
        });

        return {
            success: true,
            transactionHash: result.transactionHash,
            amount: eligibility.amount,
        };
    }

    /**
     * Get partnership statistics
     */
    async getPartnershipStats(): Promise<PartnershipStats> {
        const streams = await this.rewardsSDK.getAllStreams();
        const govStream = streams.find(s => s.tokenSymbol === 'GOV');

        const totalDistributed = govStream?.totalDistributed || '0';
        const remaining = BigInt(CONFIG.partnership.totalAllocation) - BigInt(totalDistributed);

        return {
            totalDistributed,
            activeRecipients: this.snapshot?.totalRecipients || 0,
            totalClaimed: totalDistributed,
            remainingAllocation: remaining.toString(),
        };
    }

    /**
     * Export snapshot to JSON
     */
    exportSnapshot(): string {
        if (!this.snapshot) {
            throw new Error('No snapshot created');
        }

        return JSON.stringify({
            merkleRoot: this.snapshot.merkleRoot,
            totalRecipients: this.snapshot.totalRecipients,
            totalAmount: this.snapshot.totalAmount,
            timestamp: this.snapshot.timestamp,
            recipients: Array.from(this.snapshot.recipients.entries()),
        }, null, 2);
    }

    /**
     * Format amount for display
     */
    private formatAmount(amount: string | bigint): string {
        const num = typeof amount === 'string' ? parseFloat(amount) : Number(amount);
        return (num / 1e7).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 4,
        });
    }
}

/**
 * Main execution
 */
async function main() {
    console.log('===========================================');
    console.log('  Partnership Airdrop Simulator');
    console.log('  DeFi Alliance x Stellar Liquidity Engine');
    console.log('===========================================\n');

    const airdrop = new PartnershipAirdrop();

    // Create mock admin keypair (use proper key management in production)
    const adminKeypair = Keypair.random();
    console.log(`Admin: ${adminKeypair.publicKey()}\n`);

    // Step 1: Create snapshot from vault depositors
    console.log('--- Step 1: Creating Snapshot ---');
    const vaultAddress = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    await airdrop.createSnapshot(vaultAddress);
    console.log('');

    // Step 2: Initialize governance reward stream
    console.log('--- Step 2: Initialize Reward Stream ---');
    await airdrop.initializeGovernanceStream(adminKeypair);
    console.log('');

    // Step 3: Get partnership stats
    console.log('--- Step 3: Partnership Statistics ---');
    const stats = await airdrop.getPartnershipStats();
    console.log(`Total Distributed: ${airdrop.formatAmount(stats.totalDistributed)} GOV`);
    console.log(`Active Recipients: ${stats.activeRecipients}`);
    console.log(`Remaining: ${airdrop.formatAmount(stats.remainingAllocation)} GOV`);
    console.log('');

    // Step 4: Check eligibility for mock users
    console.log('--- Step 4: Eligibility Check ---');
    const mockUsers = [
        'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX1',
        'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX2',
        'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX3',
    ];

    for (const user of mockUsers) {
        const eligibility = await airdrop.checkEligibility(user);
        console.log(`${user.slice(0, 12)}...: ${eligibility.eligible ? 'Eligible' : 'Not Eligible'} - ${airdrop.formatAmount(eligibility.amount)} GOV`);
    }
    console.log('');

    // Step 5: Simulate claiming
    console.log('--- Step 5: Simulate Claims ---');
    for (const userPublicKey of mockUsers) {
        const mockKeypair = Keypair.fromSecret(
            // This is just for demo - in production use actual keypairs
            'SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
        );

        try {
            const claimResult = await airdrop.claimAirdrop(mockKeypair);
            if (claimResult.success) {
                console.log(`Claimed ${airdrop.formatAmount(claimResult.amount || '0')} GOV - Tx: ${claimResult.transactionHash?.slice(0, 16)}...`);
            } else {
                console.log(`Claim failed for ${userPublicKey.slice(0, 12)}...`);
            }
        } catch (error) {
            console.log(`Error claiming for ${userPublicKey.slice(0, 12)}...: ${error}`);
        }
    }
    console.log('');

    // Step 6: Export snapshot
    console.log('--- Step 6: Export Snapshot ---');
    const snapshotJson = airdrop.exportSnapshot();
    console.log('Snapshot exported (first 200 chars):');
    console.log(snapshotJson.slice(0, 200) + '...');
    console.log('');

    console.log('===========================================');
    console.log('  Airdrop Simulation Complete');
    console.log('===========================================');

    // Note: The actual transaction hashes and addresses above are placeholders
    // In production, replace with real contract addresses and transactions
}

// Export for use as module
export { PartnershipAirdrop, AirdropRecipient, AirdropSnapshot, PartnershipStats };

// Run if executed directly
if (require.main === module) {
    main().catch(console.error);
}
