/**
 * Version rules, in one place, because two scripts and a test all need them.
 *
 * Chrome accepts 1–4 dot-separated integers, each **0–65535**, with no leading
 * zeros. The range is the part a regular expression gets wrong: `65535` is five
 * digits, so a `\d{0,3}` tail silently rejects a legal version. (The first version
 * of this check had exactly that bug — harmless for real versions like 10.1.0, wrong
 * all the same.)
 */

/** Shape only: 1-4 dot-separated decimal runs with no leading zeros. */
const SHAPE = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/;

const MAX_PART = 65535;

export function isChromeVersion(version) {
  if (typeof version !== 'string' || version === '') return false;
  if (!SHAPE.test(version)) return false;
  return version.split('.').every((part) => Number(part) <= MAX_PART);
}

/**
 * @param {string} current e.g. `10.0.0`
 * @param {string} argument `patch` | `minor` | `major` | an explicit version
 * @returns {string} the next version
 */
export function nextVersion(current, argument) {
  const kind = String(argument ?? '').trim();
  if (!kind) throw new Error('缺少参数（patch / minor / major / X.Y.Z）');
  if (!isChromeVersion(current)) throw new Error(`当前版本不合法：${current}`);

  if (kind !== 'patch' && kind !== 'minor' && kind !== 'major') {
    const explicit = kind.replace(/^v/, '');
    if (!isChromeVersion(explicit)) {
      throw new Error(`${explicit} 不是 Chrome 接受的版本号（1-4 段、0-65535、无前导零）`);
    }
    if (explicit === current) throw new Error(`版本号没变：${current}`);
    return explicit;
  }

  // Pad to three parts so `1.0` bumps like `1.0.0` instead of producing `1.1` vs `1.0.1`
  // depending on how the file happened to be written.
  const parts = current.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  const [major, minor, patch] = parts;

  const next =
    kind === 'major'
      ? `${major + 1}.0.0`
      : kind === 'minor'
        ? `${major}.${minor + 1}.0`
        : `${major}.${minor}.${patch + 1}`;

  if (!isChromeVersion(next) || next === current) {
    throw new Error(`无法从 ${current} 推导出 ${kind} 版本（得到 ${next}）`);
  }
  return next;
}
