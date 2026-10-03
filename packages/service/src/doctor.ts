import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitOrNull, NOTES_PREFIX } from "@ynm/store";
import { clientReports, type InstallTarget } from "./clients/index.js";
import type { LoadedConfig } from "./config.js";
import { DISTRIBUTED_FETCH } from "./init.js";
import type { Mount } from "./mounts.js";
import { projectInitialised } from "./mounts.js";
import { hasRemoteCredentials } from "./remote/auth.js";
import type { WorktreeInfo } from "./worktree.js";

export interface Check {
  name: string;
  ok: boolean;
  level: "error" | "warn" | "info";
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: Check[];
}

/** Health checks from ADR-009; offline (divergence is reported by `ynm sync --dry-run`). */
export async function doctor(opts: {
  loaded: LoadedConfig;
  worktree: WorktreeInfo;
  mounts: Mount[];
  /** Where to look for agent clients; omitted, doctor skips the client checks. */
  clients?: Pick<InstallTarget, "cwd" | "home">;
}): Promise<DoctorReport> {
  const checks: Check[] = [];
  const add = (
    name: string,
    ok: boolean,
    detail: string,
    level: Check["level"] = ok ? "info" : "error"
  ) => checks.push({ name, ok, level, detail });

  const gitVersion = (await gitOrNull(["--version"], { cwd: process.cwd() }))?.trim();
  add("git available", !!gitVersion, gitVersion ?? "git not found on PATH");
  const localBin = join(opts.loaded.home, "bin");
  if (existsSync(join(localBin, "ynm"))) {
    const onPath = (process.env.PATH ?? "").split(":").some((p) => resolve(p) === localBin);
    add(
      "local install on PATH",
      onPath,
      onPath ? localBin : `${localBin} holds a ynm launcher but is not on PATH`,
      onPath ? "info" : "warn"
    );
  }
  add(
    "config files",
    true,
    opts.loaded.files.length ? opts.loaded.files.join(", ") : "none (defaults)"
  );

  for (const m of opts.mounts) {
    const h = await m.log.health();
    add(
      `mount ${m.id} (${m.log.provider})`,
      h.ok,
      h.ok ? `${m.location}: ${JSON.stringify(h.details)}` : h.problems.join("; ")
    );
    if (m.log.provider === "git-notes" && h.details.anchorPresent === false) {
      add(
        `mount ${m.id} anchor object`,
        true,
        "not present locally (shallow clone); plumbing does not need it",
        "warn"
      );
    }
  }

  const wt = opts.worktree;
  if (wt.isGitRepo && !wt.isBare) {
    const repo = wt.mainRepoPath;
    if (!projectInitialised(wt)) {
      add(
        "project initialised",
        false,
        "no .ynm/config.json; run `ynm init` to add a distributed project mount",
        "warn"
      );
    } else {
      const cfg = JSON.parse(readFileSync(join(repo, ".ynm", "config.json"), "utf8")) as {
        anchor?: string;
      };
      add(
        "project anchor configured",
        !!cfg.anchor,
        cfg.anchor ?? "missing anchor in .ynm/config.json"
      );
      const remote = opts.loaded.config.remote;
      const hasRemote = (await gitOrNull(["remote", "get-url", remote], { cwd: repo })) !== null;
      if (hasRemote) {
        const fetches =
          (await gitOrNull(["config", "--get-all", `remote.${remote}.fetch`], { cwd: repo })) ?? "";
        add(
          "distributed fetch refspec",
          fetches.includes(DISTRIBUTED_FETCH(remote)),
          fetches.includes(DISTRIBUTED_FETCH(remote))
            ? DISTRIBUTED_FETCH(remote)
            : "missing; `ynm sync` adds it"
        );
        const pushes =
          (await gitOrNull(["config", "--get-all", `remote.${remote}.push`], { cwd: repo })) ?? "";
        add(
          "personal refs never pushed",
          !/personal/.test(pushes) && !/personal/.test(fetches),
          "no personal refspecs in remote config"
        );
      } else {
        add("remote", true, `remote "${remote}" not configured; sync unavailable`, "warn");
      }
      const personalRefs =
        (await gitOrNull(["for-each-ref", "--format=%(refname)", `${NOTES_PREFIX}/personal/`], {
          cwd: repo,
        })) ?? "";
      add(
        "no personal refs in project repo",
        personalRefs.trim() === "",
        personalRefs.trim() === "" ? "ok" : personalRefs.trim()
      );
      const hooksDir = (
        (await gitOrNull(["rev-parse", "--path-format=absolute", "--git-path", "hooks"], {
          cwd: repo,
        })) ?? ""
      ).trim();
      const prePush = join(hooksDir, "pre-push");
      const hooked = existsSync(prePush) && readFileSync(prePush, "utf8").includes("ynm sync");
      add("pre-push hook", hooked, hooked ? prePush : "not installed", hooked ? "info" : "warn");
    }
  } else if (!wt.isGitRepo) {
    add(
      "git repository",
      true,
      "not inside a git repository; only the personal store is mounted",
      "info"
    );
  }

  // Remote mounts are checked for credentials only: doctor stays offline.
  for (const m of opts.loaded.config.mounts ?? []) {
    if (m.provider !== "mcp") continue;
    const signedIn = hasRemoteCredentials(opts.loaded.home, m.id, m.url);
    add(
      `mount ${m.id} (mcp)`,
      signedIn,
      signedIn ? `${m.url}, signed in` : `${m.url}: not signed in; run \`ynm login ${m.id}\``,
      signedIn ? "info" : "warn"
    );
  }

  if (opts.clients) {
    for (const r of await clientReports(opts.clients)) {
      if (!r.detected && r.level === "off") continue;
      const detail =
        r.level === "off"
          ? `detected (${r.detection}); ynm not registered; run \`ynm client install ${r.client}\``
          : r.level === "warn"
            ? (r.advice as string)
            : `${r.hooks ? "server, guidance and hooks" : "server and guidance"} in place (${r.detail})`;
      add(`client ${r.client}`, r.level !== "warn", detail, r.level === "warn" ? "warn" : "info");
    }
  }

  return { ok: checks.every((c) => c.ok || c.level !== "error"), checks };
}
