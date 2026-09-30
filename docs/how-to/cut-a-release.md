# Releasing ynm

1. Land changesets on `main` (`pnpm changeset` for each user-visible change). 0.1.0 is the
   initial version the packages were born with, so it ships without a changeset.
2. `pnpm release:version` bumps package versions and CHANGELOGs from the changesets; commit.
3. Freeze the evals for the version: `YNM_BASELINE_VERSION=<v> YNM_WRITE_BASELINE=1 pnpm bench`
   and the tier 1 quality suites, then `pnpm bench:public` for the tier 3 reports
   (`packages/evals/reports/<v>/`). Commit both.
4. `pnpm gate M6` must be green. Its release check builds the slim tarball and this machine's
   standalone binary and runs both (below).
5. Tag `v<version>` and push the tag. The `release` workflow then:
   - `verify`: re-runs build, check, typecheck, tests and the M6 gate;
   - `build`: on `macos-14` (both darwin targets) and `ubuntu-24.04` (both linux targets),
     builds the four standalone binaries and smoke-tests each runner's native one;
   - `release`: builds and smoke-tests the slim tarball, writes `manifest.json` and
     `checksums.txt`, and attaches them with every tarball to a GitHub release;
   - `homebrew`: renders `Formula/ynm.rb` and `Formula/ynm-slim.rb` from the manifest and pushes
     them to `github.com/eyelock/homebrew-tap`, next to `ynh`;
   - `docker`: pushes `ghcr.io/eyelock/ynm:<version>` and `:latest` (linux/amd64 and arm64).

## What a release contains

| Asset | Contents | Built by |
|---|---|---|
| `ynm_<v>_darwin_arm64.tar.gz`, `_darwin_amd64`, `_linux_arm64`, `_linux_amd64` | `ynm` (Node single-executable with the bundle inside), `LICENSE`, `README.md` | `scripts/release/build-standalone.mjs` |
| `ynm_<v>_slim.tar.gz` | `ynm.mjs` (the bundle), `bin/ynm` (a launcher that requires Node 22.13 or later), `LICENSE`, `README.md` | `scripts/release/build-slim.mjs` |
| `manifest.json` | Each asset's file name, kind, os, arch, SHA-256 and size; the formulae are rendered from it | `scripts/release/manifest.mjs` |
| `checksums.txt` | SHA-256 of every tarball, in `sha256sum` format | `scripts/release/manifest.mjs` |

The formulae: `ynm` (the standalone binaries, per-platform `on_macos` / `on_linux` blocks in the
shape goreleaser writes for `ynh`, `depends_on "git"` only) and `ynm-slim` (the slim tarball,
`depends_on "git"` and `"node"`, launcher pinned to Homebrew's node). They conflict with each
other because both install `ynm`. `ynm serve` is the MCP server, so either formula covers the
CLI, the stdio server clients launch, and the hosted service. How users choose between them is
in [Install ynm](install.md); the reasoning is [ADR-015](../adr/015-distribution.md).

## How the artefacts are built

- `scripts/release/bundle.mjs` bundles the CLI and the MCP server with esbuild into
  `dist-release/ynm.mjs` (ESM) and `ynm.cjs` (CommonJS). The guidance markdown is embedded with
  the text loader; oclif is given an in-memory `package.json` and the explicit command map
  (`packages/cli/src/commands/index.ts`), so the bundle reads nothing from disk. A new command
  goes into that map; a test fails when a command file is missing from it.
- `scripts/release/build-standalone.mjs` makes a SEA blob from `ynm.cjs` with the running Node,
  extracts `node` from the official tarball for the target, injects the blob with `postject`
  and, for darwin, signs it ad hoc with `codesign`. The blob must be made by the same Node
  version it is injected into, so `.nvmrc` pins an exact version and the script refuses
  anything else. `scripts/release/fetch-node.mjs` downloads the tarball from nodejs.org and
  verifies it against `SHASUMS256.txt`.
- Only a runner's native binary can be executed. The other architecture on each runner
  (darwin/amd64, linux/arm64) is checked for the injected blob (the SEA fuse is flipped) but not
  run before release.
- `scripts/release/smoke.mjs <version> <command...>` runs `--version`, `--help`,
  `serve --help`, an `init --personal` / `remember` / `recall` round trip in a throwaway
  `YNM_HOME`, and one MCP prompt over stdio, against any build.

## Build the artefacts locally

After `pnpm build`, with the Node in `.nvmrc`:

```bash
node scripts/release/build-slim.mjs 0.1.0
TARBALL=$(node scripts/release/fetch-node.mjs --os darwin --arch arm64)
node scripts/release/build-standalone.mjs --os darwin --arch arm64 --node-tarball "$TARBALL" --version 0.1.0
node scripts/release/smoke.mjs 0.1.0 dist-release/ynm_0.1.0_darwin_arm64/ynm
node scripts/release/smoke.mjs 0.1.0 node dist-release/ynm.mjs
node scripts/release/manifest.mjs 0.1.0
```

`formula.mjs` needs all four standalone targets in the manifest (the gate fills the missing
ones with placeholders to exercise it):
`node scripts/release/formula.mjs dist-release/manifest.json ynm` and `... ynm-slim`. Linux
targets can be built on macOS too; darwin targets need macOS for `codesign`.

## Secrets

`RELEASE_TOKEN` in the ynm repository must be a token with write access to
`eyelock/homebrew-tap` (the same convention ynh uses). `GITHUB_TOKEN` covers the release and the
image.
