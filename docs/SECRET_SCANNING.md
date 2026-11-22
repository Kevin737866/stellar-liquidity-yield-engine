# Secret Scanning

The `Secret Scan` workflow (`.github/workflows/secret-scan.yml`) fails a pull
request when it would commit an environment secret. It runs
`scripts/check-env-secrets.js` against every file tracked by git, on every
pull request and every push to `main`.

## Running it locally

```bash
npm run check:secrets                       # all tracked files
node scripts/check-env-secrets.js .env.example sdk/src/index.ts   # specific paths
```

The script only needs Node.js and git. It does not need `npm install`.

| Exit code | Meaning |
|-----------|---------|
| `0` | No findings. |
| `1` | One or more findings. Each one is printed as `file:line: [rule] message`. |
| `2` | The scan could not run, for example because the directory is not a git repository. |

Findings never print the matched value. In CI they also show up as
annotations on the PR diff.

## Rules

| Rule | Fails when | Fix |
|------|------------|-----|
| `committed-env-file` | A dotenv file is tracked: `.env`, `.env.local`, `ui/.env.production`, `prod.env`, and so on. Only templates ending in `.example`, `.sample`, `.template` or `.dist` may be committed. | Run `git rm --cached <file>`, keep it git-ignored, and commit a `*.example` template instead. |
| `template-secret` | A committed template gives a real value to a secret-looking key. Keys containing `PRIVATE_KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `MNEMONIC`, `SEED`, `API_KEY`, `CREDENTIAL`, `AUTH_KEY` or `SIGNING_KEY` count as secret. | Leave the value empty (`BOT_PRIVATE_KEY=`) or use an obvious placeholder (see below). |
| `stellar-secret-seed` | A Stellar secret seed appears in any text file. A match must be an `S...` 56-character StrKey with a valid checksum, so random upper-case strings do not trigger it. | Remove the seed and load it from the environment at runtime. |
| `private-key-block` | A PEM private key header appears. | Remove the key. |
| `github-token` | A GitHub token (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`) appears. | Remove the token. |
| `aws-access-key` | An AWS access key ID (`AKIA...` / `ASIA...`) appears. | Remove the key. |

### Placeholders accepted in templates

A secret key in a template passes if its value is one of:

- empty, e.g. `KEY=`, `KEY=""` or `KEY=   # set by the operator`
- an angle-bracket placeholder: `<your-secret-seed>`
- a variable reference: `${CI_SECRET}`
- something starting with `your`, `my`, `insert`, `replace`, `change`, `enter` or `put` (`your-password-here`)
- `changeme`, `replace_me`, `todo`, `tbd`, `placeholder`, `example`, `dummy`, `redacted`, `none`, `null` or `n/a`
- a run of at least three `x`, `*` or `.` characters

Keys starting with `NEXT_PUBLIC_` are skipped by the template rule. Next.js
inlines those values into the browser bundle, so they are public by design
(see `ui/.env.example`). The content rules still apply to them, so a seed or
token placed there is still caught.

### What is not scanned

- **Untracked and git-ignored files.** A local `.env` is fine as long as it
  stays ignored. `.gitignore` already ignores `.env` and `.env.*.local`.
- **Binary files** (anything containing a NUL byte) and files larger than 2 MB.
- **Files deleted in the working tree.** Only the file-name rule applies to them.

## Allowing a deliberate fixture

To allow one line, add `secret-scan:allow` to it and say why on the same line:

```ts
const FIXTURE = 'S...'; // secret-scan:allow: throwaway seed generated for this test only
```

It is usually better to generate test fixtures at runtime, so the source file
never contains a literal credential. `scripts/check-env-secrets.test.ts` does
this. The pragma only covers the line it is on. There is no file-level or
repository-level ignore list, on purpose: each exception has to be visible in
review.

## If the check catches a real secret

Removing the value in a follow-up commit is **not enough**. It is still in git
history, and on any fork or clone that already fetched it.

1. Treat the credential as compromised. Rotate it right away: for a Stellar
   account, move the funds and signers to a new keypair; for a token, revoke it.
2. Remove the value from the branch and force-push the branch before it is
   merged. If it already reached `main`, tell the maintainers so they can
   decide whether to rewrite history.
3. Load the value from the environment instead, and document the variable
   (empty) in the relevant `.env.example`.
