const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseVersion, classifyRelease } = require('./release-policy.cjs');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
);
const version = process.argv[2] || packageJson.version;
const previous = process.argv[3];

if (!parseVersion(version)) {
  console.error(`Invalid semantic version: ${version}`);
  process.exit(1);
}

let gitTagExists = false;
try {
  execFileSync('git', ['rev-parse', '--verify', `refs/tags/v${version}`], {
    cwd: root,
    stdio: 'ignore',
  });
  gitTagExists = true;
} catch {
  gitTagExists = false;
}

if (gitTagExists) {
  console.error(`Release tag already exists: v${version}`);
  process.exit(1);
}

if (previous) {
  if (!parseVersion(previous)) {
    console.error(`Invalid previous semantic version: ${previous}`);
    process.exit(1);
  }
  const releaseType = classifyRelease(previous, version);
  if (!releaseType) {
    console.error(`Candidate ${version} does not represent a valid release after ${previous}`);
    process.exit(1);
  }
  console.log(`Validated ${releaseType} release: ${previous} -> ${version}`);
} else {
  console.log(`Validated semantic version: ${version}`);
}
