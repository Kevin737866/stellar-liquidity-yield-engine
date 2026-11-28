# Storage-migration compatibility checks

Issue: [#500](https://github.com/Kevin737866/stellar-liquidity-yield-engine/issues/500).

An in-place upgrade replaces a contract's code but keeps its storage
(`docs/UPGRADING.md`). A build that changes a stored shape therefore has to
migrate data it did not write, and the only way to know the migration still
understands *old* storage is to run it against captured state.

`sdk/src/storageMigrationCompat.ts` is that harness. It runs a migration ladder
on a deep copy of a captured fixture and reports whether the fixture reaches the
shipping build's `STORAGE_VERSION` intact. It is a pure function: no RPC, no
signing, no writes.

The on-chain half — `upgrade`, `migrate` returning the replaced version,
idempotency of `migrate`, admin-only auth and the real code swap — stays covered
by `tests/upgrade_tests.rs` (`cargo test --test upgrade_tests`).

## The three inputs

| Input | Where it comes from |
| --- | --- |
| `fixture` | Storage read out of a deployed contract, one `{ key, value }` per entry, plus the `get_storage_version()` it was read at. `version: 0` means the contract predates the version key. |
| `targetVersion` | `STORAGE_VERSION` in `src/upgrade.rs` for the build that contains your migration work. |
| ladder | One `MigrationStep` per version hop (`from`, `to`, `description`, `migrate(entries)`). |

A fixture is a **test artefact**: commit the one you captured (redact addresses
if the repository is public) next to the contract's tests, so the next layout
change runs against real data instead of invented data.

## Usage

```ts
import {
  assertMigrationCompatible,
  checkMigrationCompatibility,
} from '../sdk/src';
import { capturedVaultV0 } from './fixtures/yieldVaultV0';

// Mirrors STORAGE_VERSION in src/upgrade.rs for the shipping build.
const TARGET_STORAGE_VERSION = 1;

const result = checkMigrationCompatibility(capturedVaultV0, TARGET_STORAGE_VERSION, [
  {
    from: 0,
    to: 1,
    description: 'add UserPosition.last_claim_ledger (defaults to the position ledger)',
    migrate: (entries) =>
      entries.map((entry) =>
        entry.key.startsWith('UserPosition:')
          ? {
              key: entry.key,
              value: { ...(entry.value as object), last_claim_ledger: 0 },
            }
          : entry,
      ),
  },
]);

result.compatible;   // false if any blocker was found
result.appliedSteps; // [{ from: 0, to: 1, description: '…' }]
result.lostKeys;     // keys the ladder dropped — usually a bug
console.log(formatMigrationCompatibilityReport(result));
```

In CI, `assertMigrationCompatible(...)` throws `MigrationCompatibilityError`
with every blocker in the message, which is usually all a failing build needs to
print.

## What is checked

| Check | Normal | Boundary | Failure |
| --- | --- | --- | --- |
| Version walk | Fixture `0`/`n` climbs the ladder to the target | Fixture already at target → compatible, no steps, warning that `migrate` is a no-op | Target below the fixture (`downgrade`) is refused |
| Ladder shape | Each step moves forward once | Two steps starting at the same version, or `to <= from` | Missing start version → `missing_step` blocker naming the gap |
| Step execution | Entries are carried through and returned | A step that jumps past the target (`1 → 3` for target `2`) is refused | A step that throws, returns a non-array, or returns an entry without a key → `migration_failed` |
| Data preservation | Unrelated and unknown keys pass through untouched | Removing keys is a blocker unless `allowKeyRemoval: true`, then a warning | Dropped keys are listed in `lostKeys` |
| Idempotency | Ladder replayed on the fixture produces the same entries | Key order is ignored when comparing (not storage semantics) | Replay differs → `not_idempotent` blocker |

Idempotency is the check that matters most in practice: `migrate` is retried
after a timeout, and an operator who is unsure whether the first call landed
will call it again. The harness applies the whole ladder to its own output and
compares, so a step that appends to a vector, adds to a counter, or renames a
field without checking whether the old one is still there passes a single run
and fails this check. Guard such a step on what it produces
(`if (!('fee_bps' in value)) return entry`) rather than disabling the check.

Input validation is strict on purpose — a fixture with duplicate keys or a
non-serialisable value is a capture bug, and a harness that silently normalised
it would hide a corrupt read.

## When you bump `STORAGE_VERSION`

1. Capture a fixture from a contract at the *live* version (testnet mirrors
   mainnet shapes well enough for this; capture mainnet for a mainnet upgrade).
2. Add the `from → to` step to the contract's ladder, in the same change as the
   `STORAGE_VERSION` bump in `src/upgrade.rs`.
3. Run the compatibility check against the captured fixture and against a
   synthetic fixture at every intermediate version the ladder supports.
4. Keep the check in CI. It is a plain jest test, so it runs with
   `npx jest sdk/src/storageMigrationCompat.test.ts`.

Boundary fixtures worth keeping permanently: version `0` (pre-versioning
storage), the immediately previous version, and one fixture with an empty entry
list (a freshly deployed contract has nothing to migrate).

## Failure handling

A blocked check means: do not upgrade yet. The blocker names the version hop and
why it failed. If the migration is wrong, fix it and re-run — the harness never
touches a live contract. If the fixture is wrong, re-capture it; do not edit the
fixture to make the check pass, because the deployed data is the input that
matters.

If a migration was already applied and only then found to be incompatible, the
recovery procedure is the one in `docs/UPGRADING.md`: prefer a forward fix that
understands both layouts, and restore the pre-upgrade snapshot only when the
older code can still read what the newer `migrate` wrote.
