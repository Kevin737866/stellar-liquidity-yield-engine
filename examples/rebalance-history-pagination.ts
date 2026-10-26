import { RebalancerClient, TESTNET_CONFIG } from '../sdk/src';

async function showHistoryPages(): Promise<void> {
  const client = new RebalancerClient(TESTNET_CONFIG);
  const pageSize = 50;
  const total = await client.getHistoryCount();

  for (let offset = 0; offset < total; offset += pageSize) {
    const page = await client.getHistoryPage(pageSize, offset);
    console.log(`History ${offset + 1}-${offset + page.length} of ${total}`, page);
  }
}

void showHistoryPages().catch((error: unknown) => {
  console.error('Failed to load rebalance history:', error);
  process.exitCode = 1;
});
