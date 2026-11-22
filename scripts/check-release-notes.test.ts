/* eslint-disable @typescript-eslint/no-var-requires */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const notes = require('./check-release-notes');

const section = (fields: Record<string, string>, heading = '## Release notes') =>
  [heading, '', ...Object.entries(fields).map(([k, v]) => `- **${k}:** ${v}`)].join('\n');

const valid = {
  Component: 'contract',
  'Change type': 'fix',
  Summary: 'Vault deposits no longer round share amounts down to zero.',
  Migration: 'n/a',
  'Storage/ABI impact': 'none',
};

const check = (changedFiles: string[], body: string) => notes.checkReleaseNotes({ changedFiles, body });

describe('classifyChanges', () => {
  it('sorts files into contract and SDK surfaces', () => {
    expect(
      notes.classifyChanges([
        'src/lib.rs',
        'src/vault/mod.rs',
        'Cargo.toml',
        'sdk/src/index.ts',
        'sdk/src/utils/retryRpc.ts',
        'package.json',
      ])
    ).toEqual({
      contract: ['src/lib.rs', 'src/vault/mod.rs', 'Cargo.toml'],
      sdk: ['sdk/src/index.ts', 'sdk/src/utils/retryRpc.ts', 'package.json'],
    });
  });

  it.each([
    'tests/upgrade_tests.rs',
    'sdk/src/index.test.ts',
    'sdk/src/__tests__/x.ts',
    'docs/UPGRADING.md',
    'README.md',
    'ui/src/app/page.tsx',
    'ui/package.json',
    'examples/yield-harvest-bot.ts',
    'package-lock.json',
    '.github/workflows/ci.yml',
    'src/README.md',
    '',
  ])('does not treat %j as a shipped surface', (file) => {
    expect(notes.classifyChanges([file])).toEqual({ contract: [], sdk: [] });
  });

  it('normalises Windows separators', () => {
    expect(notes.classifyChanges(['sdk\\src\\index.ts']).sdk).toEqual(['sdk/src/index.ts']);
  });
});

describe('extractSection / parseFields', () => {
  it('reads a level-3 heading and stops at the next heading of the same level', () => {
    const body = `### Release notes\n- Summary: one\n### Testing\n- Summary: two`;
    expect(notes.parseFields(notes.extractSection(body))).toEqual({ summary: 'one' });
  });

  it('keeps sub-headings inside the section', () => {
    const body = `## Release notes\n- Summary: one\n### Detail\n- Migration: run migrate\n## Testing`;
    expect(notes.parseFields(notes.extractSection(body))).toEqual({ summary: 'one', migration: 'run migrate' });
  });

  it('ignores HTML comments so template hints do not count', () => {
    const body = `## Release notes\n<!-- - Summary: example text -->\n- Summary:`;
    expect(notes.parseFields(notes.extractSection(body))).toEqual({ summary: '' });
  });

  it('accepts several markdown spellings and CRLF line endings', () => {
    const body = '## Release Notes\r\n* Component: SDK\r\n**Change type**: Feature\r\nSummary: adds x: y\r\n';
    expect(notes.parseFields(notes.extractSection(body))).toEqual({
      component: 'SDK',
      changeType: 'Feature',
      summary: 'adds x: y',
    });
  });

  it('joins indented continuation lines onto the previous field', () => {
    const body = '## Release notes\n- Migration: 1. upgrade the wasm\n  2. call migrate()\n- Summary: s';
    expect(notes.parseFields(notes.extractSection(body)).migration).toBe('1. upgrade the wasm 2. call migrate()');
  });

  it('returns null without a section, or for a non-string body', () => {
    expect(notes.extractSection('## Summary\nstuff')).toBeNull();
    expect(notes.extractSection('Release notes: none')).toBeNull();
    expect(notes.extractSection(null)).toBeNull();
  });
});

describe('checkReleaseNotes', () => {
  it('does not require notes when no shipped surface changed', () => {
    const result = check(['docs/UPGRADING.md', 'tests/upgrade_tests.rs'], '');
    expect(result).toMatchObject({ required: false, ok: true, errors: [] });
  });

  it('does not require notes for an empty change set', () => {
    expect(check([], '').required).toBe(false);
  });

  it('accepts a complete contract section', () => {
    expect(check(['src/lib.rs'], section(valid))).toMatchObject({ required: true, ok: true, errors: [] });
  });

  it('accepts an SDK change without Storage/ABI impact', () => {
    const fields = { Component: 'sdk', 'Change type': 'feature', Summary: 'Adds VaultClient.getApy().' };
    expect(check(['sdk/src/vaultClient.ts'], section(fields)).ok).toBe(true);
  });

  it('is case-insensitive for enumerated values', () => {
    expect(check(['src/lib.rs'], section({ ...valid, Component: 'Contract', 'Change type': 'FIX' })).ok).toBe(true);
  });

  it('fails when the section is missing or the body is empty', () => {
    for (const body of ['', '## Summary\nchanged things', undefined as unknown as string]) {
      const result = check(['src/lib.rs'], body);
      expect(result.ok).toBe(false);
      expect(result.errors).toEqual(['the PR description has no "## Release notes" section']);
    }
  });

  it('fails on the unedited template', () => {
    const result = check(['src/lib.rs', 'sdk/src/index.ts'], notes.TEMPLATE);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/Component" is missing/);
    expect(result.errors.join('\n')).toMatch(/Change type" is missing/);
    expect(result.errors.join('\n')).toMatch(/Summary" is missing/);
    expect(result.errors.join('\n')).toMatch(/Storage\/ABI impact" is required/);
  });

  it('accepts a real summary that happens to contain a pipe', () => {
    const fields = { ...valid, Summary: 'Splits fees 70 | 30 between LPs and treasury.' };
    expect(check(['src/lib.rs'], section(fields)).ok).toBe(true);
  });

  it('rejects unknown component and change type values', () => {
    const result = check(['src/lib.rs'], section({ ...valid, Component: 'ui', 'Change type': 'refactor' }));
    expect(result.errors).toEqual([
      '"Component" is "ui"; use one of: contract, sdk, both',
      '"Change type" is "refactor"; use one of: breaking, feature, fix, security, internal',
    ]);
  });

  it('rejects a component that does not cover the changed surface', () => {
    const sdkOnly = check(['src/lib.rs'], section({ ...valid, Component: 'sdk' }));
    expect(sdkOnly.errors).toEqual([
      '"Component" is sdk, but contract files changed (src/lib.rs); use contract or both',
    ]);

    const contractOnly = check(['src/lib.rs', 'sdk/src/index.ts'], section(valid));
    expect(contractOnly.errors).toEqual([
      '"Component" is contract, but SDK files changed (sdk/src/index.ts); use sdk or both',
    ]);

    expect(check(['src/lib.rs', 'sdk/src/index.ts'], section({ ...valid, Component: 'both' })).ok).toBe(true);
  });

  it.each(['', 'n/a', 'None', '-', 'TBD', '<steps for integrators>'])(
    'requires a real Migration for breaking changes (rejects %j)',
    (migration) => {
      const result = check(['src/lib.rs'], section({ ...valid, 'Change type': 'breaking', Migration: migration }));
      expect(result.errors).toEqual([
        '"Migration" is required for a breaking change; explain what integrators or operators must do',
      ]);
    }
  );

  it('accepts a breaking change with migration steps', () => {
    const fields = {
      ...valid,
      'Change type': 'breaking',
      Migration: 'Call migrate() after upgrade; SDK callers must pass min_shares.',
      'Storage/ABI impact': 'deposit() gains a min_shares argument; STORAGE_VERSION 3 -> 4.',
    };
    expect(check(['src/lib.rs'], section(fields)).ok).toBe(true);
  });

  it('does not require Migration for non-breaking changes', () => {
    const fields = { ...valid };
    delete (fields as Partial<typeof valid>).Migration;
    expect(check(['src/lib.rs'], section(fields)).ok).toBe(true);
  });

  it('requires Storage/ABI impact for contract changes, accepting "none"', () => {
    const fields = { ...valid };
    delete (fields as Partial<typeof valid>)['Storage/ABI impact'];
    expect(check(['Cargo.toml'], section(fields)).errors).toEqual([
      '"Storage/ABI impact" is required for contract changes; write "none" if storage, entrypoints, events and errors are unchanged',
    ]);
  });

  it('requires Storage/ABI impact when Component is both, even for an SDK-only diff', () => {
    const fields = { Component: 'both', 'Change type': 'feature', Summary: 's' };
    expect(check(['sdk/src/index.ts'], section(fields)).errors).toHaveLength(1);
  });
});

describe('main', () => {
  let log: jest.SpyInstance;
  let err: jest.SpyInstance;
  let dir: string;

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
  });

  afterEach(() => {
    log.mockRestore();
    err.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const output = () => [...log.mock.calls, ...err.mock.calls].flat().join('\n');

  it('returns 0 when notes are not required', () => {
    expect(notes.main(['--files', 'README.md'], {})).toBe(0);
    expect(output()).toContain('not required');
  });

  it('reads the body from PR_BODY', () => {
    expect(notes.main(['--files', 'src/lib.rs'], { PR_BODY: section(valid) })).toBe(0);
    expect(output()).toContain('release notes: ok (contract, fix)');
  });

  it('reads the body from --body-file', () => {
    const file = path.join(dir, 'body.md');
    fs.writeFileSync(file, section(valid));
    expect(notes.main(['--files', 'src/lib.rs', '--body-file', file], {})).toBe(0);
  });

  it('returns 1 and prints the template and annotations on failure', () => {
    expect(notes.main(['--files', 'src/lib.rs'], { PR_BODY: '', GITHUB_ACTIONS: 'true' })).toBe(1);
    expect(output()).toContain('::error title=Release notes::the PR description has no');
    expect(output()).toContain(notes.TEMPLATE);
    expect(output()).toContain('src/lib.rs');
  });

  it.each([[['--bogus']], [['--base']], [['--files', 'a', '--body-file', '/no/such/file.md']]])(
    'returns 2 for unusable arguments %j',
    (argv) => {
      expect(notes.main(argv, {})).toBe(2);
    }
  );

  it('diffs against the base ref in a real repository', () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'ci@example.com');
    git('config', 'user.name', 'ci');
    fs.writeFileSync(path.join(dir, 'README.md'), 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), '#![no_std]');
    git('add', '.');
    git('commit', '-q', '-m', 'change');

    expect(notes.main(['--base', 'main'], { PR_BODY: '' }, dir)).toBe(1);
    expect(notes.main(['--base', 'main'], { PR_BODY: section(valid) }, dir)).toBe(0);
    expect(notes.main(['--base', 'does-not-exist'], {}, dir)).toBe(2);
  });
});

describe('docs/RELEASE_NOTES.md', () => {
  const doc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'RELEASE_NOTES.md'), 'utf8').replace(/\r\n/g, '\n');

  it('documents exactly the template the checker prints', () => {
    expect(doc).toContain(notes.TEMPLATE);
  });

  it('has examples that pass the checker', () => {
    const examples = [...doc.matchAll(/```markdown\n([\s\S]*?)```/g)].map((m) => m[1]);
    const filled = examples.filter((e) => !e.includes('contract | sdk | both'));
    expect(filled).toHaveLength(2);
    expect(check(['src/lib.rs', 'sdk/src/vaultClient.ts'], filled[0]).errors).toEqual([]);
    expect(check(['sdk/src/rewards.ts'], filled[1]).errors).toEqual([]);
  });
});
