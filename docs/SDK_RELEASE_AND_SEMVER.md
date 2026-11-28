# SDK Release and Semantic-Versioning Policy

The TypeScript SDK package is
`stellar-liquidity-yield-engine-sdk`. It follows Semantic Versioning 2.0.0
(`MAJOR.MINOR.PATCH`) and is published from the repository root.

## Version policy

- **Patch** (`x.y.Z`): backward-compatible bug fixes, documentation-only SDK
  fixes, test changes, and dependency updates that do not change the public API.
- **Minor** (`x.Y.0`): backward-compatible additions such as a new exported
  function, class, option, or result field.
- **Major** (`X.0.0`): an incompatible public API change, removal or rename of
  an export, changed return semantics, or a required Node.js/TypeScript runtime
  change. Major releases require a migration section in the release notes.
- **Prerelease** (`-alpha.N`, `-beta.N`, or `-rc.N`): an opt-in preview of the
  next release. It must not be assumed stable and may change before the stable
  version. Published preview tags use the npm `next` dist-tag.

Build metadata (`+build.N`) does not affect compatibility or release ordering.
Versions with a missing component, leading zero, or invalid prerelease identifier
are rejected.

## Backward compatibility

Patch and minor releases must preserve existing exported declarations and runtime
behavior unless behavior is documented as a bug fix. New fields and optional
arguments are preferred over breaking changes. Deprecations require a
replacement, deprecation notice, and at least one subsequent minor or major
release before removal.

## Release preparation

1. Update `CHANGELOG.md` under `Unreleased` with user-visible changes.
2. Update the SDK package version from the repository root:
   ```bash
   npm version patch|minor|major
   ```
3. Run the release checks:
   ```bash
   npm test
   npm run build
   npm run lint
   npm run release:check
   npm run release:dry-run
   ```
   `release:check` rejects malformed versions and tags that already exist.
   `release:dry-run` builds and creates a package preview without publishing.
4. Commit and push the version change and create a GitHub Pull Request.
5. Merge only after CI passes. Maintainers create the matching `vX.Y.Z` tag on
   `main`.

For a prerelease, run `npm version prerelease --preid=beta` (or `--preid=rc`)
and publish with npm's `next` dist-tag. Stable releases publish with `latest`.

## Automated publishing

The `.github/workflows/sdk-release.yml` workflow runs on `v*` tags. It verifies
the SDK tests, build, lint, package contents, and tag/version match. Publishing
requires an npm automation token in the `NPM_TOKEN` GitHub Actions secret.
The workflow never publishes on a Pull Request or a normal branch push.

Failure behavior:

- A malformed package version stops the release check.
- A tag that already exists stops the release check.
- A tag such as `v1.2.3` does not publish if `package.json` contains `1.2.4`.
- A missing `NPM_TOKEN` or npm authentication failure stops the publish step;
  no partial stable package should be considered published.
- CI or package validation failure prevents creation of release artifacts.

## Rollback

Do not rewrite or move published tags. If a release is faulty, publish a new
patch or prerelease that clearly describes the regression, then deprecate the
affected npm version when appropriate. Contract and SDK releases should be
versioned independently; an SDK patch does not imply a contract upgrade.
