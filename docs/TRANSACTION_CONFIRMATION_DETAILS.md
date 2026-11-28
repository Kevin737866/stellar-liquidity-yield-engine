# Transaction confirmation details

The Dashboard transactions page (`/transactions`) lets users review which vault
and pool were selected for each transaction in the history.

## User-visible behavior

- Every history row has a **View details** button. Opening it reveals a
  **Transaction confirmation details** panel with a **Vault** and a **Pool**
  value, alongside the operation, amount, status, and hash shown in the row.
- Only one transaction's details are open at a time. **Hide details** closes
  the panel.
- The disclosure button exposes `aria-expanded` and `aria-controls`, and the
  panel is a labelled group with a definition list, so the values are available
  to assistive technology.
- Changing the status or operation filters keeps the details tied to the
  matching transaction shown in the filtered table.

## Data contract

`TransactionRecord` in `ui/src/lib/transactionFilters.ts` accepts two optional
fields:

```ts
{
  vault?: string | null;
  pool?: string | null;
}
```

They are optional so existing producers of transaction records do not need to
change. `ui/src/lib/transactionConfirmation.ts` resolves the values for
display:

| Input | Displayed value |
| --- | --- |
| Non-empty string | Trimmed string |
| Missing field, `null`, `undefined`, whitespace-only, or non-string | `Not recorded` |

An explicit fallback is used instead of a blank label so users can tell that
the confirmation data was not captured. Invalid values never block rendering
the rest of the transaction history.

The sample history in `ui/src/lib/sampleTransactions.ts` includes vault and
pool values for local development and tests.

## Verification

Run from the repository root:

```bash
cd ui
npm install
npm test -- --runInBand
npm run build
```

Coverage includes the normal case, trimming, legacy records without the new
fields, blank/malformed values, collapsing the panel, and behavior after
filtering. No new environment variables or operational steps are required.
