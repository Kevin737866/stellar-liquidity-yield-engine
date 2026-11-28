const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseVersion(version) {
  if (typeof version !== 'string' || !SEMVER_PATTERN.test(version)) {
    return null;
  }

  const [coreAndPrerelease, build] = version.split('+');
  const dash = coreAndPrerelease.indexOf('-');
  const core = dash === -1 ? coreAndPrerelease : coreAndPrerelease.slice(0, dash);
  const prerelease = dash === -1 ? null : coreAndPrerelease.slice(dash + 1);
  if (prerelease) {
    const invalidNumericIdentifier = prerelease
      .split('.')
      .some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'));
    if (invalidNumericIdentifier) {
      return null;
    }
  }
  const [major, minor, patch] = core.split('.').map(Number);

  return { major, minor, patch, prerelease, build: build || null };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) {
    return null;
  }

  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) {
      return a[key] > b[key] ? 1 : -1;
    }
  }
  if (a.prerelease === null || b.prerelease === null) {
    if (a.prerelease === b.prerelease) return 0;
    return a.prerelease === null ? 1 : -1;
  }

  const aParts = a.prerelease.split('.');
  const bParts = b.prerelease.split('.');
  const length = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < length; i += 1) {
    if (aParts[i] === undefined) return -1;
    if (bParts[i] === undefined) return 1;
    if (aParts[i] === bParts[i]) continue;
    const aNumeric = /^\d+$/.test(aParts[i]);
    const bNumeric = /^\d+$/.test(bParts[i]);
    if (aNumeric && bNumeric) return Number(aParts[i]) > Number(bParts[i]) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aParts[i] > bParts[i] ? 1 : -1;
  }
  return 0;
}

function classifyRelease(previous, next) {
  const from = parseVersion(previous);
  const to = parseVersion(next);
  if (!from || !to) {
    return null;
  }
  if (compareVersions(previous, next) >= 0) {
    return null;
  }
  if (to.major !== from.major) return 'major';
  if (to.minor !== from.minor) return 'minor';
  return 'patch';
}

module.exports = {
  SEMVER_PATTERN,
  parseVersion,
  compareVersions,
  classifyRelease,
};
