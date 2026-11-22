#!/usr/bin/env node
/**
 * Enforces the release-notes requirements in docs/RELEASE_NOTES.md.
 *
 * A pull request that changes a shipped surface (the Soroban contracts or the
 * TypeScript SDK) must carry a `## Release notes` section in its description
 * with these fields:
 *
 *   Component:            contract | sdk | both
 *   Change type:          breaking | feature | fix | security | internal
 *   Summary:              one line, written for integrators
 *   Migration:            required when Change type is `breaking`
 *   Storage/ABI impact:   required when Component covers the contract
 *
 * Pull requests that touch neither surface pass without a section.
 *
 * Usage (CI sets PR_BODY and BASE_REF from the pull_request event):
 *   node scripts/check-release-notes.js
 *   node scripts/check-release-notes.js --base origin/main --body-file pr.md
 *   node scripts/check-release-notes.js --files src/lib.rs,sdk/src/index.ts --body-file pr.md
 *
 * Exit codes: 0 = ok or not required, 1 = notes missing or invalid,
 *             2 = the check could not run (bad arguments, git failure).
 */
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const COMPONENTS = ['contract', 'sdk', 'both'];
const CHANGE_TYPES = ['breaking', 'feature', 'fix', 'security', 'internal'];
/** Values that do not count as a migration guide for a breaking change. */
const EMPTY_VALUES = ['', 'n/a', 'na', 'none', '-', 'tbd', 'todo'];

const FIELDS = {
  component: 'Component',
  changeType: 'Change type',
  summary: 'Summary',
  migration: 'Migration',
  storageAbi: 'Storage/ABI impact',
};

const TEMPLATE = `## Release notes

- **Component:** contract | sdk | both
- **Change type:** breaking | feature | fix | security | internal
- **Summary:** <one line an integrator can act on>
- **Migration:** <steps for integrators/operators; required for breaking changes, otherwise n/a>
- **Storage/ABI impact:** <none, or what changed in storage layout, entrypoints, events or errors; required for contract changes>`;

// ---------------------------------------------------------------------------
// Which files are shipped surfaces
// ---------------------------------------------------------------------------

function isTestPath(file) {
  return /(^|\/)(__tests__|test|tests)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

/** Contract source: the crate in src/ and its manifest. tests/ is not shipped. */
function isContractFile(file) {
  return file === 'Cargo.toml' || (file.startsWith('src/') && file.endsWith('.rs'));
}

/** SDK source shipped to npm: sdk/src (minus tests) and the package manifest. */
function isSdkFile(file) {
  if (file === 'package.json') return true;
  return file.startsWith('sdk/src/') && !isTestPath(file);
}

/** Classifies changed files into the surfaces that need release notes. */
function classifyChanges(files) {
  const contract = [];
  const sdk = [];
  for (const raw of files) {
    const file = raw.trim().replace(/\\/g, '/');
    if (!file) continue;
    if (isContractFile(file)) contract.push(file);
    else if (isSdkFile(file)) sdk.push(file);
  }
  return { contract, sdk };
}

// ---------------------------------------------------------------------------
// Parsing the PR description
// ---------------------------------------------------------------------------

/**
 * Returns the body of the `Release notes` section (heading level 2 or 3), or
 * null when there is none. HTML comments are removed first, so template hints
 * inside `<!-- -->` never count as content.
 */
function extractSection(body) {
  if (typeof body !== 'string') return null;
  const text = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^#{2,3}\s+release\s+notes\s*#*\s*$/i.test(line.trim()));
  if (start === -1) return null;
  const level = lines[start].trim().match(/^#+/)[0].length;
  const rest = [];
  for (const line of lines.slice(start + 1)) {
    const heading = line.trim().match(/^(#+)\s/);
    if (heading && heading[1].length <= level) break;
    rest.push(line);
  }
  return rest.join('\n');
}

/**
 * Parses `Field: value` lines. Accepts list bullets and markdown emphasis:
 * `- **Component:** sdk`, `* Component: sdk`, `**Component**: sdk`.
 * Continuation lines (indented, not a new field) are appended to the
 * previous field, so a multi-line Migration is read in full.
 */
function parseFields(section) {
  const names = Object.entries(FIELDS);
  const fields = {};
  let current = null;
  for (const rawLine of section.split('\n')) {
    const line = rawLine.replace(/\*\*|__/g, '');
    const match = line.match(/^\s*(?:[-*+]\s+)?([A-Za-z/ ]+?)\s*:\s*(.*)$/);
    const entry = match && names.find(([, label]) => label.toLowerCase() === match[1].trim().toLowerCase());
    if (entry) {
      current = entry[0];
      fields[current] = match[2].trim();
    } else if (current && /^\s+\S/.test(rawLine)) {
      fields[current] = `${fields[current]} ${line.trim()}`.trim();
    } else if (!line.trim()) {
      continue;
    } else {
      current = null;
    }
  }
  return fields;
}

const TEMPLATE_CHOICES = [COMPONENTS, CHANGE_TYPES].map((list) => list.join(' | '));

/** True when `value` is still the unedited template text (`a | b | c` or `<hint>`). */
function isTemplateText(value) {
  return /^<[^>]*>$/.test(value) || TEMPLATE_CHOICES.includes(value.toLowerCase());
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks a PR description against the changed files.
 * Returns { required, ok, errors, surfaces, fields }.
 */
function checkReleaseNotes({ changedFiles, body }) {
  const surfaces = classifyChanges(changedFiles || []);
  const touchesContract = surfaces.contract.length > 0;
  const touchesSdk = surfaces.sdk.length > 0;
  const required = touchesContract || touchesSdk;
  const result = { required, ok: true, errors: [], surfaces, fields: {} };
  if (!required) return result;

  const section = extractSection(body);
  if (section === null) {
    result.errors.push('the PR description has no "## Release notes" section');
    result.ok = false;
    return result;
  }

  const fields = parseFields(section);
  result.fields = fields;
  const err = (message) => result.errors.push(message);
  const value = (key) => (fields[key] || '').trim();
  const missing = (key) => {
    const v = value(key);
    return v === '' || isTemplateText(v);
  };

  // Component
  const component = value('component').toLowerCase();
  if (missing('component')) {
    err(`"${FIELDS.component}" is missing; use one of: ${COMPONENTS.join(', ')}`);
  } else if (!COMPONENTS.includes(component)) {
    err(`"${FIELDS.component}" is "${value('component')}"; use one of: ${COMPONENTS.join(', ')}`);
  } else {
    if (touchesContract && component === 'sdk') {
      err(`"${FIELDS.component}" is sdk, but contract files changed (${surfaces.contract.join(', ')}); use contract or both`);
    }
    if (touchesSdk && component === 'contract') {
      err(`"${FIELDS.component}" is contract, but SDK files changed (${surfaces.sdk.join(', ')}); use sdk or both`);
    }
  }

  // Change type
  const changeType = value('changeType').toLowerCase();
  if (missing('changeType')) {
    err(`"${FIELDS.changeType}" is missing; use one of: ${CHANGE_TYPES.join(', ')}`);
  } else if (!CHANGE_TYPES.includes(changeType)) {
    err(`"${FIELDS.changeType}" is "${value('changeType')}"; use one of: ${CHANGE_TYPES.join(', ')}`);
  }

  // Summary
  if (missing('summary')) err(`"${FIELDS.summary}" is missing; describe the change in one line for integrators`);

  // Migration: mandatory for breaking changes.
  if (changeType === 'breaking') {
    const migration = value('migration').toLowerCase();
    if (missing('migration') || EMPTY_VALUES.includes(migration)) {
      err(`"${FIELDS.migration}" is required for a breaking change; explain what integrators or operators must do`);
    }
  }

  // Storage/ABI impact: mandatory whenever the contract is covered.
  const coversContract = touchesContract || component === 'contract' || component === 'both';
  if (coversContract && missing('storageAbi')) {
    err(`"${FIELDS.storageAbi}" is required for contract changes; write "none" if storage, entrypoints, events and errors are unchanged`);
  }

  result.ok = result.errors.length === 0;
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--base') args.base = next();
    else if (flag === '--body-file') args.bodyFile = next();
    else if (flag === '--files') args.files = next().split(',');
    else throw new Error(`unknown argument: ${flag}`);
  }
  return args;
}

function changedFilesFromGit(base, cwd) {
  const output = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd, encoding: 'utf8' });
  return output.split('\n').filter(Boolean);
}

function main(argv, env = process.env, cwd = process.cwd()) {
  let changedFiles;
  let body;
  try {
    const args = parseArgs(argv);
    body = args.bodyFile !== undefined ? fs.readFileSync(args.bodyFile, 'utf8') : env.PR_BODY || '';
    if (args.files) {
      changedFiles = args.files;
    } else {
      const base = args.base || (env.BASE_REF ? `origin/${env.BASE_REF}` : 'origin/main');
      changedFiles = changedFilesFromGit(base, cwd);
    }
  } catch (err) {
    console.error(`release notes check could not run: ${err.message}`);
    return 2;
  }

  const result = checkReleaseNotes({ changedFiles, body });
  if (!result.required) {
    console.log('release notes: not required (no contract or SDK source changed)');
    return 0;
  }

  const touched = [...result.surfaces.contract, ...result.surfaces.sdk];
  if (result.ok) {
    console.log(
      `release notes: ok (${result.fields.component}, ${result.fields.changeType}) for ${touched.length} changed file(s)`
    );
    return 0;
  }

  console.error(`release notes: required because these files changed:\n  ${touched.join('\n  ')}\n`);
  for (const message of result.errors) {
    console.error(`  - ${message}`);
    if (env.GITHUB_ACTIONS === 'true') console.log(`::error title=Release notes::${message}`);
  }
  console.error(
    `\nAdd or fix this section in the PR description, then save it to re-run the check ` +
      `(see docs/RELEASE_NOTES.md):\n\n${TEMPLATE}\n`
  );
  return 1;
}

module.exports = {
  COMPONENTS,
  CHANGE_TYPES,
  TEMPLATE,
  classifyChanges,
  extractSection,
  parseFields,
  checkReleaseNotes,
  main,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
