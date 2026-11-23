import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where a loopback `ynm serve --http` keeps its token (ADR-017). */
export function localTokenPath(home: string): string {
  return join(home, "serve-token");
}

/** The token on file, if there is one. */
export function readLocalToken(home: string): string | undefined {
  const file = localTokenPath(home);
  if (!existsSync(file)) return undefined;
  return readFileSync(file, "utf8").trim() || undefined;
}

function write(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // Written to a private temporary file and renamed, so the token is never readable by others,
  // not even for the moment between creating the file and restricting it.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/**
 * The local token, made on first use: 32 random bytes, in a file only the user can read. A file
 * left readable by others is made private again.
 */
export function ensureLocalToken(home: string): { token: string; created: boolean; path: string } {
  const path = localTokenPath(home);
  const existing = readLocalToken(home);
  if (existing) {
    chmodSync(path, 0o600);
    return { token: existing, created: false, path };
  }
  const token = randomBytes(32).toString("base64url");
  write(path, token);
  return { token, created: true, path };
}

/** A new token in place of the old one; clients that read the file pick it up on their next install. */
export function rotateLocalToken(home: string): { token: string; path: string } {
  const path = localTokenPath(home);
  const token = randomBytes(32).toString("base64url");
  write(path, token);
  return { token, path };
}
