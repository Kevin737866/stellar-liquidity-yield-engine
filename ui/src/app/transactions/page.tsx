import { TransactionHistory } from '@/components/TransactionHistory';
import { sampleTransactions } from '@/lib/sampleTransactions';

export default function TransactionsPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-3xl font-bold tracking-tight text-slate-900">Transactions</h1>
        <p className="mt-1 text-sm text-slate-600">
          Filter the account transaction history by status and operation.
        </p>
        <div className="mt-8">
          <TransactionHistory transactions={sampleTransactions} />
        </div>
      </main>
    </div>
  );
}
