import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { git, gitOrNull, identityEnv } from "@ynm/store";
import type { WikiPage } from "./generate.js";

/** Where a projection is written (ADR-010). Mirrors the store and index seams. */
export interface WikiTarget {
  readonly name: string;
  write(pages: WikiPage[]): Promise<{ written: number; location: string }>;
  read(path: string): Promise<string | null>;
  list(): Promise<string[]>;
}

/** Default: a plain directory (gitignored `.ynm/wiki/`, or an Obsidian vault path). */
export class DirectoryTarget implements WikiTarget {
  readonly name = "directory";
  constructor(readonly dir: string) {}

  async write(pages: WikiPage[]): Promise<{ written: number; location: string }> {
    if (existsSync(this.dir)) {
      for (const p of await this.list())
        if (!pages.some((x) => x.path === p)) rmSync(join(this.dir, p));
    }
    for (const p of pages) {
      const file = join(this.dir, p.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, p.content);
    }
    return { written: pages.length, location: this.dir };
  }

  async read(path: string): Promise<string | null> {
    const file = join(this.dir, path);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }

  async list(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    const out: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md")) out.push(relative(this.dir, p));
      }
    };
    walk(this.dir);
    return out.sort();
  }
}

/** An orphan branch (default `ynm/wiki`) so a team can browse the projection on a forge. */
export class OrphanBranchTarget implements WikiTarget {
  readonly name = "orphan-branch";
  constructor(
    readonly repo: string,
    readonly branch = "ynm/wiki"
  ) {}

  private get ref(): string {
    return `refs/heads/${this.branch}`;
  }

  private async tree(pages: WikiPage[]): Promise<string> {
    // Build nested trees bottom-up: group blobs by directory, mktree each directory.
    const blobs = new Map<string, string>();
    for (const p of pages)
      blobs.set(
        p.path,
        (await git(["hash-object", "-w", "--stdin"], { cwd: this.repo, input: p.content })).trim()
      );
    const dirs = new Map<string, Array<{ name: string; kind: "blob" | "tree"; sha: string }>>();
    const ensure = (d: string) => {
      if (!dirs.has(d)) dirs.set(d, []);
      return dirs.get(d) as Array<{ name: string; kind: "blob" | "tree"; sha: string }>;
    };
    for (const [path, sha] of blobs) {
      const d = dirname(path) === "." ? "" : dirname(path);
      ensure(d).push({ name: path.slice(d ? d.length + 1 : 0), kind: "blob", sha });
    }
    const depth = (d: string) => (d ? d.split("/").length : 0);
    const order = [...dirs.keys()].sort((a, b) => depth(b) - depth(a));
    const treeSha = new Map<string, string>();
    for (const d of order) {
      const entries = ensure(d);
      const lines = entries.map((e) =>
        e.kind === "blob" ? `100644 blob ${e.sha}\t${e.name}` : `040000 tree ${e.sha}\t${e.name}`
      );
      const sha = (
        await git(["mktree"], { cwd: this.repo, input: `${lines.join("\n")}\n` })
      ).trim();
      treeSha.set(d, sha);
      if (d) {
        const parent = dirname(d) === "." ? "" : dirname(d);
        ensure(parent).push({ name: d.slice(parent ? parent.length + 1 : 0), kind: "tree", sha });
        if (!order.includes(parent)) order.push(parent);
      }
    }
    return treeSha.get("") ?? (await git(["mktree"], { cwd: this.repo, input: "" })).trim();
  }

  async write(pages: WikiPage[]): Promise<{ written: number; location: string }> {
    const tree = await this.tree(pages);
    const old = (
      await gitOrNull(["rev-parse", "--verify", "-q", `${this.ref}^{commit}`], { cwd: this.repo })
    )?.trim();
    const env = await identityEnv(this.repo);
    const commit = (
      await git(
        [
          "commit-tree",
          tree,
          ...(old ? ["-p", old] : []),
          "-m",
          `ynm: wiki (${pages.length} pages)`,
        ],
        { cwd: this.repo, env }
      )
    ).trim();
    await git(["update-ref", this.ref, commit, old ?? "0".repeat(commit.length)], {
      cwd: this.repo,
    });
    return { written: pages.length, location: `${this.repo}#${this.branch}` };
  }

  async read(path: string): Promise<string | null> {
    return gitOrNull(["show", `${this.ref}:${path}`], { cwd: this.repo });
  }

  async list(): Promise<string[]> {
    const out = await gitOrNull(["ls-tree", "-r", "--name-only", this.ref], { cwd: this.repo });
    return out
      ? out
          .split("\n")
          .filter((l) => l.endsWith(".md"))
          .sort()
      : [];
  }
}
