const {
  parseVersion,
  compareVersions,
  classifyRelease,
} = require('../../scripts/release-policy.cjs');

describe('SDK release semver policy', () => {
  it('accepts stable and prerelease versions', () => {
    expect(parseVersion('1.2.3')).not.toBeNull();
    expect(parseVersion('1.2.3-beta.1')).not.toBeNull();
    expect(parseVersion('1.2.3+build.7')).not.toBeNull();
  });

  it('rejects malformed and boundary versions', () => {
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('01.2.3')).toBeNull();
    expect(parseVersion('1.2.3-')).toBeNull();
    expect(parseVersion('1.2.3-beta.01')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('uses semantic-version precedence', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.3-beta.2', '1.2.3-beta.10')).toBe(-1);
    expect(compareVersions('1.2.3-beta.1', '1.2.3')).toBe(-1);
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
  });

  it('classifies patch, minor, and major releases', () => {
    expect(classifyRelease('1.2.3', '1.2.4')).toBe('patch');
    expect(classifyRelease('1.2.3', '1.3.0')).toBe('minor');
    expect(classifyRelease('1.2.3', '2.0.0')).toBe('major');
  });

  it('rejects equal, lower, or malformed release candidates', () => {
    expect(classifyRelease('1.2.3', '1.2.3')).toBeNull();
    expect(classifyRelease('1.2.3', '1.2.2')).toBeNull();
    expect(classifyRelease('not-a-version', '1.2.3')).toBeNull();
  });
});
