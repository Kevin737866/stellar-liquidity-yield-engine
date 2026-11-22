/* eslint-disable @typescript-eslint/no-var-requires */
// Fixtures that look like real credentials are assembled at runtime so this
// file never contains a literal secret the scanner (or GitHub) would flag.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const scanner = require('./check-env-secrets');
const { base32Decode, crc16Xmodem, SEED_VERSION_BYTE, BASE32_ALPHABET } = scanner._internal;

function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32_ALPHABET[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** Builds a checksum-valid Stellar secret seed from a fill byte. */
function makeSeed(fill = 7): string {
  const payload = new Uint8Array(33);
  payload[0] = SEED_VERSION_BYTE;
  payload.fill(fill, 1);
  const crc = crc16Xmodem(payload);
  const full = new Uint8Array(35);
  full.set(payload);
  full[33] = crc & 0xff;
  full[34] = (crc >> 8) & 0xff;
  return base32Encode(full);
}

const fakeGithubToken = () => ['gh', 'p_', 'a'.repeat(36)].join('');
const fakeAwsKey = () => ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('');
const pemHeader = () => ['-----BEGIN', 'RSA PRIVATE', 'KEY-----'].join(' ');

const rules = (findings: Array<{ rule: string }>) => findings.map((f) => f.rule);

describe('isStellarSecretSeed', () => {
  it('accepts a checksum-valid seed', () => {
    const seed = makeSeed();
    expect(seed).toHaveLength(56);
    expect(seed.startsWith('S')).toBe(true);
    expect(base32Decode(seed)).toHaveLength(35);
    expect(scanner.isStellarSecretSeed(seed)).toBe(true);
  });

  it('rejects a seed with a corrupted checksum', () => {
    const seed = makeSeed();
    const last = seed[seed.length - 1] === 'A' ? 'B' : 'A';
    expect(scanner.isStellarSecretSeed(seed.slice(0, -1) + last)).toBe(false);
  });

  it('rejects look-alikes: wrong length, wrong alphabet, wrong version', () => {
    expect(scanner.isStellarSecretSeed('S' + 'A'.repeat(55))).toBe(false);
    expect(scanner.isStellarSecretSeed(makeSeed().slice(0, 55))).toBe(false);
    expect(scanner.isStellarSecretSeed(makeSeed().replace(/.$/, '1'))).toBe(false);
    expect(scanner.isStellarSecretSeed(undefined)).toBe(false);
  });
});

describe('env file classification', () => {
  it.each([
    ['.env', true, false],
    ['.env.local', true, false],
    ['ui/.env.production.local', true, false],
    ['deploy/prod.env', true, false],
    ['.env.example', true, true],
    ['ui/.env.example', true, true],
    ['.env.sample', true, true],
    ['config.env.template', true, true],
    ['.envrc', false, false],
    ['src/config/env.ts', false, false],
    ['environment.md', false, false],
  ])('%s -> env=%s template=%s', (file, env, template) => {
    expect(scanner.isEnvFile(file)).toBe(env);
    if (env) expect(scanner.isEnvTemplate(file)).toBe(template);
  });
});

describe('scanFile', () => {
  it('flags a committed .env file even when it cannot be read', () => {
    expect(rules(scanner.scanFile('.env', null))).toEqual(['committed-env-file']);
    expect(rules(scanner.scanFile('ui/.env.local', 'FOO=bar'))).toEqual(['committed-env-file']);
  });

  it('accepts the shape of the repository templates', () => {
    const template = [
      '# Copy this file to .env',
      'STELLAR_NETWORK=testnet',
      'SOROBAN_RPC_URL=https://soroban-testnet.stellar.org',
      'BOT_PRIVATE_KEY=',
      'HARVEST_THRESHOLD=1000',
      'NEXT_PUBLIC_STAKING_CONTRACT_ID=',
    ].join('\n');
    expect(scanner.scanFile('.env.example', template)).toEqual([]);
  });

  it.each([
    'BOT_PRIVATE_KEY=',
    'BOT_PRIVATE_KEY=""',
    'BOT_PRIVATE_KEY=<your-secret-seed>',
    'API_TOKEN=${CI_API_TOKEN}',
    'DB_PASSWORD=changeme',
    'DB_PASSWORD=your-password-here',
    'SIGNING_KEY=xxxxxxxx',
    'BOT_PRIVATE_KEY=   # filled in by the operator',
  ])('treats %j in a template as a placeholder', (line) => {
    expect(scanner.scanFile('.env.example', line)).toEqual([]);
  });

  it.each([
    ['BOT_PRIVATE_KEY=hunter2hunter2', 1],
    ['export API_TOKEN="abc123def456"', 1],
    ['# comment\nDB_PASSWORD=s3cr3t', 2],
    ["MNEMONIC='word word word'", 1],
  ])('flags a real value in a template: %j', (content, line) => {
    const findings = scanner.scanFile('.env.example', content);
    expect(rules(findings)).toEqual(['template-secret']);
    expect(findings[0].line).toBe(line);
  });

  it('does not apply template rules to non-env files', () => {
    expect(scanner.scanFile('README.md', 'BOT_PRIVATE_KEY=hunter2')).toEqual([]);
  });

  it('ignores secret-looking NEXT_PUBLIC_ keys (public by design)', () => {
    expect(scanner.scanFile('ui/.env.example', 'NEXT_PUBLIC_API_KEY_HINT=abc')).toEqual([]);
  });

  it('flags a Stellar secret seed in any text file, with its line', () => {
    const content = `const a = 1;\nconst key = "${makeSeed()}";\n`;
    const findings = scanner.scanFile('examples/bot.ts', content);
    expect(rules(findings)).toEqual(['stellar-secret-seed']);
    expect(findings[0].line).toBe(2);
  });

  it('flags a seed placed in a template as both template-secret and seed', () => {
    const findings = scanner.scanFile('.env.example', `BOT_PRIVATE_KEY=${makeSeed()}`);
    expect(rules(findings).sort()).toEqual(['stellar-secret-seed', 'template-secret']);
  });

  it('does not flag a 56-char S-string without a valid checksum', () => {
    expect(scanner.scanFile('a.ts', `const h = "S${'A'.repeat(55)}";`)).toEqual([]);
  });

  it('flags PEM private keys, GitHub tokens and AWS keys', () => {
    const content = [pemHeader(), `token=${fakeGithubToken()}`, `aws=${fakeAwsKey()}`].join('\n');
    expect(rules(scanner.scanFile('notes.txt', content))).toEqual([
      'private-key-block',
      'github-token',
      'aws-access-key',
    ]);
  });

  it('honours the allow pragma on the same line only', () => {
    const seed = makeSeed();
    const content = `fixture = "${seed}" // ${scanner.ALLOW_PRAGMA}: deterministic test seed\nother = "${seed}"`;
    const findings = scanner.scanFile('a.test.ts', content);
    expect(findings.map((f: { line: number }) => f.line)).toEqual([2]);
  });

  it('never includes the secret value in the formatted message', () => {
    const seed = makeSeed();
    const [finding] = scanner.scanFile('a.ts', `k="${seed}"`);
    const text = scanner.formatFinding(finding);
    expect(text).toBe('a.ts:1: [stellar-secret-seed] Stellar secret seed');
    expect(text).not.toContain(seed);
  });
});

describe('main (against a real git repository)', () => {
  let repo: string;
  let log: jest.SpyInstance;
  let err: jest.SpyInstance;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  const write = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), content);
  };

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
    git('init', '-q');
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('returns 0 for a clean tree', () => {
    write('.env.example', 'BOT_PRIVATE_KEY=\n');
    write('src/index.ts', 'export const x = 1;\n');
    git('add', '.');
    expect(scanner.main([], repo)).toBe(0);
  });

  it('returns 1 when a .env file is tracked', () => {
    write('.env', 'BOT_PRIVATE_KEY=\n');
    git('add', '-f', '.env');
    expect(scanner.main([], repo)).toBe(1);
    expect(err.mock.calls.flat().join('\n')).toContain('.env: [committed-env-file]');
  });

  it('ignores untracked files', () => {
    write('.env', `BOT_PRIVATE_KEY=${makeSeed()}\n`);
    write('README.md', 'hello\n');
    git('add', 'README.md');
    expect(scanner.main([], repo)).toBe(0);
  });

  it('skips binary files and files deleted from the working tree', () => {
    write('logo.png', Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(makeSeed())]));
    write('gone.ts', `k="${makeSeed()}"`);
    git('add', '.');
    fs.unlinkSync(path.join(repo, 'gone.ts'));
    expect(scanner.main([], repo)).toBe(0);
  });

  it('scans only the paths given on the command line', () => {
    write('a.ts', `k="${makeSeed()}"`);
    write('b.ts', 'ok');
    expect(scanner.main(['b.ts'], repo)).toBe(0);
    expect(scanner.main(['a.ts'], repo)).toBe(1);
  });

  it('emits GitHub annotations without the secret value', () => {
    const seed = makeSeed();
    write('a.ts', `k="${seed}"`);
    const previous = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = 'true';
    try {
      expect(scanner.main(['a.ts'], repo)).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = previous;
    }
    const out = log.mock.calls.flat().join('\n');
    expect(out).toContain('::error file=a.ts,line=1::[stellar-secret-seed]');
    expect(out).not.toContain(seed);
  });

  it('returns 2 when it is not run inside a git repository', () => {
    const notRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-norepo-'));
    try {
      expect(scanner.main([], notRepo)).toBe(2);
    } finally {
      fs.rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
