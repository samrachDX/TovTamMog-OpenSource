/**
 * IP address and CIDR handling for branch allowlists.
 * Addresses are parsed to (version, bigint) so IPv4 and IPv6 share one code path.
 * IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as IPv4.
 */
export type ParsedIp = { version: 4 | 6; value: bigint };

function parseV4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let out = 0n;
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

function parseV6(s: string): bigint | null {
  let str = s;
  // Embedded IPv4 tail, e.g. ::ffff:1.2.3.4
  const lastColon = str.lastIndexOf(':');
  if (str.includes('.')) {
    const v4 = parseV4(str.slice(lastColon + 1));
    if (v4 === null) return null;
    str = `${str.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === '' ? [] : part.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  let out = 0n;
  for (const g of all) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out = (out << 16n) | BigInt(parseInt(g, 16));
  }
  return out;
}

export function parseIp(input: string): ParsedIp | null {
  const s = input.trim();
  if (!s || s.length > 45) return null;
  if (s.includes(':')) {
    const v6 = parseV6(s);
    if (v6 === null) return null;
    if (v6 >> 32n === 0xffffn) return { version: 4, value: v6 & 0xffffffffn };
    return { version: 6, value: v6 };
  }
  const v4 = parseV4(s);
  return v4 === null ? null : { version: 4, value: v4 };
}

export type ParsedCidr = { version: 4 | 6; network: bigint; prefix: number };

export function parseCidr(input: string): ParsedCidr | null {
  const s = input.trim();
  const slash = s.indexOf('/');
  const ip = parseIp(slash === -1 ? s : s.slice(0, slash));
  if (!ip) return null;
  const bits = ip.version === 4 ? 32 : 128;
  let prefix = bits;
  if (slash !== -1) {
    const p = s.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return null;
    prefix = Number(p);
    if (prefix > bits) return null;
  }
  const hostBits = BigInt(bits - prefix);
  return { version: ip.version, network: (ip.value >> hostBits) << hostBits, prefix };
}

function formatIp(version: 4 | 6, value: bigint): string {
  if (version === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.');
  }
  const groups: string[] = [];
  for (let i = 7; i >= 0; i--) groups.push(((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  return groups.join(':');
}

/**
 * Canonical form for storage: network address with host bits cleared and an explicit
 * prefix. Returns null for anything that is not a valid address or range. Ranges wide
 * enough to allow most of the internet are refused.
 */
export function normalizeCidr(input: string): string | null {
  const c = parseCidr(input);
  if (!c) return null;
  const minPrefix = c.version === 4 ? 16 : 32;
  if (c.prefix < minPrefix) return null;
  return `${formatIp(c.version, c.network)}/${c.prefix}`;
}

export function ipInCidr(ip: ParsedIp, cidr: ParsedCidr): boolean {
  if (ip.version !== cidr.version) return false;
  const bits = ip.version === 4 ? 32 : 128;
  const hostBits = BigInt(bits - cidr.prefix);
  return (ip.value >> hostBits) << hostBits === cidr.network;
}

/** Fails closed: an unparseable address, an empty list, or a bad entry never matches. */
export function ipAllowed(ip: string | null | undefined, allowlist: string[]): boolean {
  if (!ip) return false;
  const parsed = parseIp(ip);
  if (!parsed) return false;
  return allowlist.some((entry) => {
    const cidr = parseCidr(entry);
    return cidr !== null && ipInCidr(parsed, cidr);
  });
}
