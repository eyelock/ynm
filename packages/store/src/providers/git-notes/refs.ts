import type { Level, MemoryType } from "@ynm/model";
import { MEMORY_TYPES } from "@ynm/model";
import { BUCKET_PATTERN, type ShardKey } from "../../log.js";

export const NOTES_PREFIX = "refs/notes/ynm";
/** Remote-tracking copies used by sync; still under refs/notes/ so `git notes merge` accepts them. */
export const REMOTE_PREFIX = "refs/notes/ynm-remote";

/** The ref directory for a level is the level's own name: refs/notes/ynm/<personal|distributed>/... */
export function levelDir(level: Level): Level {
  return level;
}

export function levelFromDir(dir: string): Level | null {
  return dir === "personal" || dir === "distributed" ? dir : null;
}

/**
 * refs/notes/ynm/<personal|distributed>/<namespace...>/<type>/<yyyy-mm>. Namespace segments are
 * real ref components; type and bucket have fixed forms, so parsing back is unambiguous.
 */
export function refFor(key: ShardKey): string {
  return `${NOTES_PREFIX}/${levelDir(key.level)}/${key.namespace}/${key.type}/${key.bucket}`;
}

export function refPrefixFor(level: Level, namespace?: string): string {
  return `${NOTES_PREFIX}/${levelDir(level)}/${namespace ? `${namespace}/` : ""}`;
}

export function keyFromRef(ref: string, prefix: string = NOTES_PREFIX): ShardKey | null {
  if (!ref.startsWith(`${prefix}/`)) return null;
  const parts = ref.slice(prefix.length + 1).split("/");
  if (parts.length < 4) return null;
  const bucket = parts.pop() as string;
  const type = parts.pop() as string;
  const level = levelFromDir(parts.shift() as string);
  if (!level || !BUCKET_PATTERN.test(bucket) || !(MEMORY_TYPES as readonly string[]).includes(type))
    return null;
  if (parts.length === 0) return null;
  return { level, namespace: parts.join("/"), type: type as MemoryType, bucket };
}

export function remoteRef(remote: string, localRef: string): string {
  return `${REMOTE_PREFIX}/${remote}/${localRef.slice(NOTES_PREFIX.length + 1)}`;
}
