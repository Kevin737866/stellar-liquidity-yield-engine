#!/usr/bin/env node
/**
 * Fails when environment secrets are committed to the repository.
 *
 * Checks every file tracked by git (or the paths passed as arguments) for:
 *
 *   1. committed-env-file  A real dotenv file (`.env`, `.env.local`,
 *                          `ui/.env.production`, `prod.env`, ...) is tracked.
 *                          Only templates (`*.example`, `*.sample`,
 *                          `*.template`, `*.dist`) may be committed.
 *   2. template-secret     A template assigns a non-placeholder value to a
 *                          secret-looking key (`BOT_PRIVATE_KEY=...`,
 *                          `API_TOKEN=...`). Secret keys must be left empty or
 *                          use an obvious placeholder such as `<your-key>`.
 *   3. stellar-secret-seed A Stellar secret seed (`S...`, 56 chars) with a
 *                          valid StrKey checksum appears in any text file.
 *   4. private-key-block   A PEM private key block appears in any text file.
 *   5. github-token / aws-access-key  Well-known credential formats.
 *
 * A finding on a line containing `secret-scan:allow` is ignored. Use it only
 * for deliberately fake fixtures, and say why on the same line.
 *
 * Usage:
 *   node scripts/check-env-secrets.js            # scan all tracked files
 *   node scripts/check-env-secrets.js a.env b.ts # scan only these paths
 *
 * Exit codes: 0 = clean, 1 = findings, 2 = the scan itself could not run.
 *
 * See docs/SECRET_SCANNING.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ALLOW_PRAGMA = 'secret-scan:allow';

/** Files larger than this are skipped; secrets live in small text files. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template', '.dist'];

/** Key names that hold credentials. Matched against the upper-cased key. */
const SECRET_KEY_PATTERN =
  /(PRIVATE_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE_SECRET|MNEMONIC|SEED|API_KEY|APIKEY|CREDENTIAL|AUTH_KEY|SIGNING_KEY)/;

/**
 * Key names that match SECRET_KEY_PATTERN but are public by design.
 * NEXT_PUBLIC_* values are inlined into the browser bundle, so they cannot be
 * secrets; anything secret there is already a bug the template comment warns
 * about, and the content rules below still catch real seeds/keys.
 */
const PUBLIC_KEY_PATTERN = /^NEXT_PUBLIC_/;

/** Values that are obviously not real secrets. */
const PLACEHOLDER_PATTERNS = [
  /^$/,
  /^<[^>]*>$/, // <your-key>
  /^\$\{[^}]*\}$/, // ${FROM_CI}
  /^(your|my|insert|replace|change|enter|put)[-_ ]?/i, // your-secret-here
  /^(changeme|change_me|replace_me|todo|tbd|placeholder|example|dummy|redacted|none|null|n\/a)$/i,
  /^x{3,}$/i, // xxxx
  /^\*{3,}$/, // ****
  /^\.{3,}$/, // ...
];

/** Content rules applied to every scanned text file. */
const CONTENT_RULES = [
  {
    rule: 'private-key-block',
    pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g,
    message: 'PEM private key block',
  },
  {
    rule: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    message: 'GitHub access token',
  },
  {
    rule: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    message: 'AWS access key ID',
  },
  {
    rule: 'stellar-secret-seed',
    pattern: /\bS[A-Z2-7]{55}\b/g,
    message: 'Stellar secret seed',
    // Only a checksum-valid seed counts; random 56-char upper-case strings
    // (hashes, contract IDs written oddly) do not.
    validate: isStellarSecretSeed,
  },
];

// ---------------------------------------------------------------------------
// Stellar StrKey validation
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** StrKey version byte for an ed25519 secret seed (18 << 3). */
const SEED_VERSION_BYTE = 18 << 3;

function base32Decode(input) {
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of input) {
    const value = BASE32_ALPHABET.indexOf(ch);
    if (value === -1) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function crc16Xmodem(bytes) {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** True when `candidate` is a checksum-valid Stellar secret seed. */
function isStellarSecretSeed(candidate) {
  if (typeof candidate !== 'string' || candidate.length !== 56) return false;
  const decoded = base32Decode(candidate);
  // version (1) + ed25519 seed (32) + crc16 (2)
  if (!decoded || decoded.length !== 35) return false;
  if (decoded[0] !== SEED_VERSION_BYTE) return false;
  const expected = crc16Xmodem(decoded.subarray(0, 33));
  const actual = decoded[33] | (decoded[34] << 8); // little-endian
  return expected === actual;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** True for dotenv templates that are meant to be committed. */
function isEnvTemplate(filePath) {
  const base = path.posix.basename(toPosix(filePath)).toLowerCase();
  return TEMPLATE_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

/**
 * True for any dotenv-style file name: `.env`, `.env.local`,
 * `.env.production.local`, `prod.env`, and their templates.
 */
function isEnvFile(filePath) {
  let base = path.posix.basename(toPosix(filePath)).toLowerCase();
  for (const suffix of TEMPLATE_SUFFIXES) {
    if (base.endsWith(suffix)) base = base.slice(0, -suffix.length);
  }
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.env');
}

function isPlaceholder(value) {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value));
}

/** Strips quotes and a trailing ` # comment` from a dotenv value. */
function normaliseEnvValue(raw) {
  let value = raw.trim();
  const quoted = value.match(/^(['"])(.*)\1\s*(?:#.*)?$/);
  if (quoted) return quoted[2];
  // `KEY=   # note` (value already trimmed to `# note`) or `KEY=abc # note`
  const hash = value.startsWith('#') ? 0 : value.search(/\s#/);
  if (hash !== -1) value = value.slice(0, hash);
  return value.trim();
}

/** Findings for secret-looking keys that carry real values in a template. */
function scanEnvTemplate(filePath, content) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes(ALLOW_PRAGMA)) return;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) return;
    const key = match[1].toUpperCase();
    if (!SECRET_KEY_PATTERN.test(key) || PUBLIC_KEY_PATTERN.test(key)) return;
    const value = normaliseEnvValue(match[2]);
    if (isPlaceholder(value)) return;
    findings.push({
      file: filePath,
      line: index + 1,
      rule: 'template-secret',
      message: `${match[1]} has a value in a committed template; leave it empty or use a placeholder like <your-value>`,
    });
  });
  return findings;
}

/** Findings for credential-shaped strings anywhere in a text file. */
function scanContent(filePath, content) {
  const findings = [];
  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes(ALLOW_PRAGMA)) return;
    for (const { rule, pattern, message, validate } of CONTENT_RULES) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(line)) !== null) {
        if (validate && !validate(match[0])) continue;
        findings.push({ file: filePath, line: index + 1, rule, message });
        break; // one finding per rule per line is enough
      }
    }
  });
  return findings;
}

/**
 * Scans one file. `content` is null when the file could not be read as text
 * (binary, too large, or missing); only the file-name rule applies then.
 */
function scanFile(filePath, content) {
  const findings = [];
  if (isEnvFile(filePath) && !isEnvTemplate(filePath)) {
    findings.push({
      file: filePath,
      line: 0,
      rule: 'committed-env-file',
      message:
        'environment file is tracked by git; remove it with `git rm --cached` and commit a *.example template instead',
    });
  }
  if (content === null) return findings;
  if (isEnvFile(filePath) && isEnvTemplate(filePath)) {
    findings.push(...scanEnvTemplate(filePath, content));
  }
  findings.push(...scanContent(filePath, content));
  return findings;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function toPosix(filePath) {
  return filePath.split(path.sep).join('/').replace(/\\/g, '/');
}

/** Reads a file as text, or returns null for binary/oversized/missing files. */
function readText(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null; // deleted in the working tree but still in the index
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
  const buffer = fs.readFileSync(absPath);
  if (buffer.includes(0)) return null; // binary
  return buffer.toString('utf8');
}

function listTrackedFiles(cwd) {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' });
  return output.split('\0').filter(Boolean);
}

/** Scans `files` (repo-relative) under `cwd` and returns all findings. */
function scanFiles(files, cwd) {
  const findings = [];
  for (const file of files) {
    findings.push(...scanFile(toPosix(file), readText(path.resolve(cwd, file))));
  }
  return findings;
}

function formatFinding({ file, line, rule, message }) {
  const location = line > 0 ? `${file}:${line}` : file;
  return `${location}: [${rule}] ${message}`;
}

function main(argv, cwd = process.cwd()) {
  let files;
  try {
    files = argv.length > 0 ? argv : listTrackedFiles(cwd);
  } catch (err) {
    console.error(`secret scan could not list tracked files: ${err.message}`);
    return 2;
  }

  const findings = scanFiles(files, cwd);
  if (findings.length === 0) {
    console.log(`secret scan: ${files.length} file(s) checked, no committed secrets found`);
    return 0;
  }

  for (const finding of findings) {
    console.error(formatFinding(finding));
    if (process.env.GITHUB_ACTIONS === 'true') {
      // Annotate the PR diff. The secret value itself is never printed.
      const lineArg = finding.line > 0 ? `,line=${finding.line}` : '';
      console.log(`::error file=${finding.file}${lineArg}::[${finding.rule}] ${finding.message}`);
    }
  }
  console.error(
    `\nsecret scan: ${findings.length} finding(s). If a value was ever pushed, rotate it: ` +
      'removing it from the tree does not remove it from git history. See docs/SECRET_SCANNING.md.'
  );
  return 1;
}

module.exports = {
  ALLOW_PRAGMA,
  isEnvFile,
  isEnvTemplate,
  isPlaceholder,
  isStellarSecretSeed,
  scanFile,
  scanFiles,
  formatFinding,
  main,
  // exported for tests
  _internal: { base32Decode, crc16Xmodem, SEED_VERSION_BYTE, BASE32_ALPHABET },
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
