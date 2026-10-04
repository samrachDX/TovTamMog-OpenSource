/**
 * Translation completeness check. Fails the build when:
 *  - a key exists in one dictionary but not the other,
 *  - a translation is empty,
 *  - placeholders differ between languages,
 *  - a Khmer string contains no Khmer script (likely left untranslated),
 *  - source code references a key that does not exist,
 *  - an error code has no message.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { km } from '../src/lib/i18n/km';
import { en } from '../src/lib/i18n/en';
import { ERROR_CODES } from '../src/lib/errors';

const problems: string[] = [];
const kmDict = km as Record<string, string>;
const enDict = en as Record<string, string>;

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const KHMER = /[ក-៿]/;
// Strings that are legitimately not Khmer script in the Khmer dictionary.
const KHMER_EXEMPT = new Set(['common.english', 'portal.pager']);

for (const key of Object.keys(kmDict)) {
  if (!(key in enDict)) problems.push(`missing in en: ${key}`);
  if (!kmDict[key].trim()) problems.push(`empty in km: ${key}`);
  if (!KHMER_EXEMPT.has(key) && !KHMER.test(kmDict[key])) problems.push(`no Khmer text in km: ${key}`);
  if (key in enDict && placeholders(kmDict[key]) !== placeholders(enDict[key])) {
    problems.push(`placeholder mismatch: ${key}`);
  }
}
for (const key of Object.keys(enDict)) {
  if (!(key in kmDict)) problems.push(`missing in km: ${key}`);
  if (!enDict[key].trim()) problems.push(`empty in en: ${key}`);
}
for (const code of ERROR_CODES) {
  if (!(`errors.${code}` in kmDict)) problems.push(`error code without message: ${code}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const KEY_USE = /\bt\(\s*(?:[\w.]+\s*,\s*)?['"]([a-zA-Z0-9_.]+)['"]/g;
for (const file of walk(join(__dirname, '..', 'src'))) {
  if (file.includes(`${join('lib', 'i18n')}`)) continue;
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(KEY_USE)) {
    if (!(m[1] in kmDict)) problems.push(`unknown key "${m[1]}" used in ${file}`);
  }
}

if (problems.length) {
  console.error(`i18n check failed (${problems.length}):\n` + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`i18n check passed: ${Object.keys(kmDict).length} keys in km-KH and en.`);
