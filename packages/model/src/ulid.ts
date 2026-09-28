import { randomBytes } from "node:crypto";

/** Crockford base32 alphabet used by ULIDs. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID is 26 Crockford base32 characters: 48 bits of time then 80 bits of randomness. */
export const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

function encode(value: bigint, length: number): string {
  let out = "";
  let v = value;
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

/**
 * Generates a ULID. Sorting ULIDs lexicographically sorts them by creation time, which is what
 * makes `cat_sort_uniq` reordering harmless (ADR-002).
 */
export function ulid(time: number = Date.now(), random?: () => number): string {
  let r = 0n;
  if (random) {
    for (let i = 0; i < 10; i++) r = (r << 8n) | BigInt(Math.floor(random() * 256) & 255);
  } else {
    for (const b of randomBytes(10)) r = (r << 8n) | BigInt(b);
  }
  return encode(BigInt(time), 10) + encode(r, 16);
}

/** Extracts the millisecond timestamp encoded in a ULID. */
export function ulidTime(id: string): number {
  let t = 0n;
  for (const ch of id.slice(0, 10)) t = (t << 5n) | BigInt(ALPHABET.indexOf(ch));
  return Number(t);
}
