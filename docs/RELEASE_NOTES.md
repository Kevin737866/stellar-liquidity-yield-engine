# Release Notes Requirements

Integrators and operators read release notes to decide whether they can
upgrade, and what they must do when they do. Contract and SDK changes are
therefore documented **in the pull request that makes them**, not
reconstructed at release time. The `Release Notes` workflow
(`.github/workflows/release-notes.yml`) enforces this.

## When release notes are required

A pull request needs a `## Release notes` section in its description when it
changes a shipped surface:

| Surface | Paths that trigger the requirement |
|---------|------------------------------------|
| Contract | `src/**/*.rs`, `Cargo.toml` |
| SDK | `sdk/src/**` except tests (`*.test.ts`, `*.spec.ts`, `__tests__/`, `test/`, `tests/`), and `package.json` |

Pull requests that touch none of those paths do **not** need a section, for example changes limited to `docs/`,
`tests/`, `examples/`, `ui/`, CI workflows, `package-lock.json`, and other
non-shipped files. The check passes with
`release notes: not required` for them.

A shipped change that users will not notice still needs a section. Mark it
`Change type: internal`. This records that someone made the call on purpose,
rather than forgot.

## The section

Copy this into the PR description and fill it in:

```markdown
## Release notes

- **Component:** contract | sdk | both
- **Change type:** breaking | feature | fix | security | internal
- **Summary:** <one line an integrator can act on>
- **Migration:** <steps for integrators/operators; required for breaking changes, otherwise n/a>
- **Storage/ABI impact:** <none, or what changed in storage layout, entrypoints, events or errors; required for contract changes>
```

A `### Release notes` heading also works. The section ends at the next
heading of the same or a higher level.

### Fields

| Field | Required | Allowed values / rules |
|-------|----------|------------------------|
| `Component` | Always | `contract`, `sdk` or `both`. It must cover every surface the diff touches: a PR that changes `src/lib.rs` cannot say `sdk`. |
| `Change type` | Always | `breaking`, `feature`, `fix`, `security` or `internal` (see below). |
| `Summary` | Always | One line, written for someone who uses the contract or SDK, not for a reviewer. Say what changed for them, not how it was implemented. |
| `Migration` | When `Change type` is `breaking` | What integrators or operators must do: new arguments to pass, a `migrate` call to run, config to change. `n/a`, `none`, `-`, `tbd` and `todo` are rejected for breaking changes. |
| `Storage/ABI impact` | When `Component` is `contract` or `both`, or the diff touches contract files | `none`, or the storage layout, entrypoint, event or error changes. If the stored layout changed, say how `STORAGE_VERSION` moved (see [UPGRADING.md](UPGRADING.md#version-policy)). |

Field names are case-insensitive. Bullets (`-`, `*`, `+`) and bold
(`**Field:**` or `**Field**:`) are optional. To write a value over several
lines, indent the continuation lines.

### Choosing a change type

| Type | Use when |
|------|----------|
| `breaking` | Existing callers break or behave differently without changing their code. Examples: an entrypoint signature, a return type, an event payload or an error code changes; an SDK export is removed or renamed; storage needs a migration before the new code is safe to use. |
| `feature` | New capability that existing callers can ignore: a new entrypoint, an optional argument, a new SDK method. |
| `fix` | Corrects behavior to match what was documented or intended, with no change to the interface. |
| `security` | Fixes a vulnerability or hardens authorization, pause or fund-movement paths. Coordinate disclosure with the maintainers before you describe the vulnerability in detail. |
| `internal` | No observable change for integrators: refactors, dependency or build tweaks, comments. |

If you are unsure whether a change is breaking, treat it as breaking and
write the migration. Over-warning costs a reader a minute. A missed break
costs an operator a failed upgrade.

### Examples

A contract change that needs a migration:

```markdown
## Release notes

- **Component:** both
- **Change type:** breaking
- **Summary:** `deposit` now takes a `min_shares` argument and rejects deposits that would mint fewer shares.
- **Migration:** Upgrade the wasm, then call `migrate` once (admin).
  SDK callers must pass `minShares` to `VaultClient.deposit`; pass `0n` to keep the old behavior.
- **Storage/ABI impact:** `deposit(user, amount)` becomes `deposit(user, amount, min_shares)`.
  New error `SlippageExceeded = 14`. STORAGE_VERSION 3 -> 4.
```

An SDK-only fix:

```markdown
## Release notes

- **Component:** sdk
- **Change type:** fix
- **Summary:** `RewardsClient.pending()` no longer throws for accounts that have never claimed.
- **Migration:** n/a
```

## What the check reports

`scripts/check-release-notes.js` compares the PR's changed files with its
description.

| Situation | Result |
|-----------|--------|
| No contract or SDK file changed | Passes: `release notes: not required` |
| Section present and valid | Passes: `release notes: ok (<component>, <change type>)` |
| Section missing, or the description is empty | Fails |
| A field is missing, empty, or still the template text (`contract \| sdk \| both`, `<...>`) | Fails, naming the field |
| `Component` or `Change type` has a value that is not allowed | Fails, listing the allowed values |
| `Component` does not cover a changed surface | Fails, listing the files |
| Breaking change with no real `Migration` | Fails |
| Contract change with no `Storage/ABI impact` | Fails |
| Check cannot run (unknown argument, base ref missing) | Exit code `2` |

Template hints inside HTML comments (`<!-- ... -->`) are ignored.

When the check fails, it prints the files that triggered it, each problem
(also shown as an annotation on the PR), and the block above to copy. Editing
the PR description re-runs the check. You do not need to push a new commit.

### Running it locally

```bash
# Against your branch, with the description saved to a file:
node scripts/check-release-notes.js --base origin/main --body-file pr-body.md

# Without git, for an explicit list of files:
node scripts/check-release-notes.js --files src/lib.rs,sdk/src/index.ts --body-file pr-body.md
```

With no arguments (as in CI, or via `npm run check:release-notes`) the script
reads the description from the `PR_BODY` environment variable and diffs against
`origin/$BASE_REF`, defaulting to `origin/main`.

## Compiling a release

At release time, a maintainer builds the release notes from the merged PRs:

1. List the PRs merged since the previous tag.
2. Copy each `## Release notes` section, grouped by `Change type` in this
   order: breaking, security, feature, fix. Leave out `internal` entries, or
   collapse them into one line.
3. Put the `Migration` steps for every breaking change at the top, in merge
   order, because operators apply them in that order.
4. For contract releases, list every `Storage/ABI impact` that is not `none`,
   and check the final `STORAGE_VERSION` against
   [UPGRADING.md](UPGRADING.md#version-policy).
