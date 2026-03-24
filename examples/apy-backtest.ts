import { ApyHistoryTracker } from '../sdk/src/apyHistory';

/**
 * Example: APY History Backtest against Simulated Mainnet Data
 * 
 * Validates the oracle logic against 6 months of APY data,
 * retrieving standard deviation, TWAPs, and forecasting impermanent loss.
 */
async function runApyBacktest() {
    console.log("==========================================");
    console.log("   Dynamic APY Oracle Backtest Example   ");
    console.log("==========================================");

    // Using a mainnet RPC
    const rpcUrl = "https://soroban.stellar.org";
    const historyTracker = new ApyHistoryTracker(rpcUrl);

    // Example vault IDs for mainnet
    const usdcXlmVault = "CA_USDC_XLM_MAINNET_VAULT_EXAMPLE_1";
    const wethUsdcVault = "CA_WETH_USDC_MAINNET_VAULT_EXAMPLE_2";

    console.log("\n[1] Fetching 90-Day APY History for USDC-XLM Vault...");
    // Our oracle packs the circular buffer data. In a dry-run or mock environment,
    // this will utilize the fallback data with logical APY/Volume variables.
    const usdcXlmHistory = await historyTracker.getHistoricalAPY(usdcXlmVault, 90);
    
    console.log(`Successfully fetched ${usdcXlmHistory.length} hourly data points.`);
    if (usdcXlmHistory.length > 0) {
        console.log(`Latest APY: ${usdcXlmHistory[usdcXlmHistory.length - 1].apyBps / 100}%`);
        console.log(`Earliest APY (90d ago): ${usdcXlmHistory[0].apyBps / 100}%`);
    }

    console.log("\n[2] Analyzing Historical Volatility (Risk Adjustments)...");
    const volatility = await historyTracker.getAPYVolatility(usdcXlmVault);
    console.log(`Calculated APY Volatility (StdDev): ±${volatility.toFixed(2)}%`);

    console.log("\n[3] Calculating Predicted Impermanent Loss Risk...");
    // Assume 15% price volatility roughly for XLM over a month
    const priceVol = 15;
    const projectedIL = await historyTracker.predictImpermanentLoss(usdcXlmVault, priceVol);
    console.log(`Base Price Volatility Input: ${priceVol}%`);
    console.log(`Projected Impermanent Loss factoring in APY instability: ${projectedIL.toFixed(2)}%`);

    console.log("\n[4] Side-by-side Vault Comparison (30D Timeframe)...");
    const comparison = await historyTracker.compareVaults(usdcXlmVault, wethUsdcVault, 30);
    
    console.log("Vault A (USDC-XLM):");
    console.log(` - Average APY: ${comparison.vaultA.averageApy.toFixed(2)}%`);
    console.log(` - Volatility: ±${comparison.vaultA.volatility.toFixed(2)}%`);
    
    console.log("Vault B (WETH-USDC):");
    console.log(` - Average APY: ${comparison.vaultB.averageApy.toFixed(2)}%`);
    console.log(` - Volatility: ±${comparison.vaultB.volatility.toFixed(2)}%`);
    
    console.log(`\nWinner based on pure historical returns: ${comparison.winner === usdcXlmVault ? 'USDC-XLM' : 'WETH-USDC'}`);
    
    console.log("\n==========================================");
    console.log("             Backtest Complete            ");
    console.log("==========================================");
}

// Execute the backtest if run directly
if (require.main === module) {
    runApyBacktest().catch(console.error);
}
