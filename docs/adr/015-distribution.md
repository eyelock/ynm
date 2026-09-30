# ADR-015: Distribution: standalone binaries, a slim bundle and the image

Status: accepted (2026-09-30)
Satisfies: NFR-6, NFR-14

## Context

ynm is a TypeScript monorepo run by Node. It needs Node 22.13 or later (the first release with
`node:sqlite` unflagged, which the index uses) and `git` (memory is git notes). The first release
shipped one tarball, a `pnpm deploy` of the CLI package with its production `node_modules`
(22.2 MB gzipped), and a Homebrew formula that depended on Homebrew's `node`. That had three
costs:

- Every user needed a suitable Node, and a Homebrew `node` is a large dependency for people who
  manage Node with nvm, fnm or a base image, or have none.
- Anyone installing without Homebrew had to get Node 22.13 or later on their own first, and a
  CI image or server had to carry a Node toolchain to run a memory CLI.
- The release was unlike ynh's, which publishes one archive per platform
  (`ynh_<version>_<os>_<arch>.tar.gz`) and a formula with per-platform blocks. Users of both
  tools met two install shapes.

Measured on the reference machine (Node 24.20.0, macOS arm64): the Node binary is 116 MB, and
the CLI and MCP server bundle into one 4.9 MB minified file.

## Decision

Every release publishes three things, all built from the same bundle.

1. **Standalone binaries**, `ynm_<version>_<os>_<arch>.tar.gz` for darwin and linux on arm64 and
   amd64, named as goreleaser names ynh's. Each is Node's single-executable application (SEA):
   the official Node binary for the target with the CommonJS bundle injected by `postject`
   (ad-hoc signed on macOS). The machine needs only `git`. The Homebrew formula `ynm` installs
   them, with ynh's `on_macos` / `on_linux` shape and `depends_on "git"` only. This is the
   recommended install.
2. **A slim tarball**, `ynm_<version>_slim.tar.gz`: the ESM bundle `ynm.mjs` and a `bin/ynm`
   launcher that checks for Node 22.13 or later and says to use the standalone binary
   otherwise. The formula `ynm-slim` installs it on Homebrew's `node`. It is for machines that
   already keep a Node.
3. **The Docker image** on ghcr.io, unchanged (ADR-009): the hosted service.

Measured sizes for 0.1.0:

| Artefact | Download (gzipped) | Installed |
|---|---|---|
| `darwin_arm64` binary | 39.9 MB | 125.9 MB |
| `darwin_amd64` binary | 41.9 MB | 129.0 MB |
| `linux_arm64` binary | 44.3 MB | 127.7 MB |
| `linux_amd64` binary | 44.6 MB | 131.5 MB |
| slim tarball | 1.4 MB | 4.9 MB plus your Node |

`ynm --version` takes about 0.15 s from the binary and from the slim bundle, against about
0.18 s from the unbundled checkout.

How it is built:

- **One bundle.** esbuild bundles the CLI and the MCP server (`scripts/release/bundle.mjs`) into
  `ynm.mjs` and `ynm.cjs`; SEA needs a CommonJS main script. The guidance markdown is imported
  as text and registered with `embedGuidance`; the checkout still reads it from disk.
- **No disk reads by oclif.** The CLI uses oclif's explicit command strategy
  (`packages/cli/src/commands/index.ts`, a map tested against the directory). The bundle entry
  builds the root plugin from an in-memory `package.json` and seeds the plugin's command cache
  with that map, because oclif's explicit strategy otherwise imports the map from a path. That
  cache is a private field of oclif's `Plugin`; a change there breaks the bundle loudly (every
  smoke test fails) rather than quietly.
- **One blob, four binaries.** The SEA blob is platform independent but must be made by the
  Node version it is injected into, so `.nvmrc` pins an exact Node and the Node tarballs come
  from nodejs.org, verified against `SHASUMS256.txt`. A macOS runner builds both darwin targets
  (`codesign` needs macOS); a Linux runner builds both linux targets. Each runner can execute
  only its native binary, which is smoke-tested; the other is checked for the injected blob.
- **A manifest.** The release writes `manifest.json` (each asset's file, os, arch and SHA-256)
  and `checksums.txt`; both formulae are rendered from the manifest.

## Alternatives considered

- **A tarball that depends on Node** (what 0.1.0 shipped). Replaced: small, but it made Node a
  prerequisite everywhere, pulled Homebrew's `node` into every Homebrew install, and carried a
  `node_modules` tree (22.2 MB gzipped, against 1.4 MB for the bundle). Its useful half, running
  on the user's own Node, survives as the slim tarball: one file and a launcher.
- **Bun or Deno compile.** Rejected: both produce single binaries, but ynm's index is built on
  `node:sqlite`, and neither runtime guarantees it. Bun's own SQLite module has a different API;
  a second storage path for one packaging choice is not worth it.
- **A custom-built, smaller Node** (`--without-intl`, no npm, no inspector). Rejected for now: it
  would roughly halve the binary, but building Node for four targets is slow and fragile in CI
  and moves Node's security updates onto us. The official binaries are rebuilt by Node's release
  team; we only inject into them.
- **Only the Docker image for users without Node.** Rejected: a container is the wrong shape for
  a CLI that agents launch as a stdio MCP server on the developer's machine.

## Consequences

- Most users install one 40 MB download that needs only `git`, with the same formula shape as
  ynh. `docs/how-to/install.md` compares every mechanism.
- Each binary carries a whole Node (about 120 MB installed). Node security releases reach users
  only through a ynm release: bumping `.nvmrc` is part of keeping ynm current.
- A new CLI command must be added to the explicit command map; a test fails otherwise.
- Code must not read files relative to its own module at runtime (the bundle has none); text
  assets are embedded at build time as the guidance is.
- The macOS binaries are ad-hoc signed, not notarized. Homebrew and `curl` downloads run; a
  browser download is quarantined until the user clears the attribute.
- The linux/arm64 and darwin/amd64 binaries are not executed before release.
- The release gate builds the slim tarball and the native binary and runs both.

## Open questions

- Notarizing the macOS binaries (needs a Developer ID) so browser downloads run without
  clearing quarantine.
- Running the non-native binaries before release, on arm64 Linux and Intel macOS runners, once
  those are cheap enough to add to the matrix.

## History

- 2026-09-30: standalone SEA binaries and the slim bundle replace the Node-dependent tarball;
  the Docker image is unchanged.
