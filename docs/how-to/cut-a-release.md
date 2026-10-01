# Releasing ynm

Releases follow Gitflow (CONTRIBUTING.md, "Branches and pull requests"): changes land on
`develop` through feature pull requests, and a release branch carries them to `main`.

1. Land changesets on `develop` with the features (`make changeset` for each user-visible
   change).
2. Cut `release/vX.Y.Z` from `develop`. On it, `make version` bumps package versions and
   CHANGELOGs from the changesets; commit.
3. Freeze the evals for the version on the same branch:
   `YNM_BASELINE_VERSION=<v> YNM_WRITE_BASELINE=1 make bench` and the tier 1 quality suites,
   then `make bench-public` for the tier 3 reports (`packages/evals/reports/<v>/`). Commit both.
4. `make gate M=M6` must be green. Its release check builds the slim tarball and this machine's
   standalone binary and runs both (below).
5. Open a pull request from `release/vX.Y.Z` into `main`; merge it with a true merge (not
   squash) once CI is green. Then open a second pull request from the release branch into
   `develop` so `develop` has the version bump and frozen evals too (the mandatory back-merge),
   and delete the release branch after both are in.
6. Tag `v<version>` on `main` and push the tag. The `release` workflow then:
   - `verify`: re-runs build, check, typecheck, tests and the M6 gate;
   - `build`: on `macos-14` (both darwin targets) and `ubuntu-24.04` (both linux targets),
     builds the four standalone binaries and smoke-tests each runner's native one;
   - `release`: builds and smoke-tests the slim tarball and the Lambda package, writes
     `manifest.json` and `checksums.txt`, and attaches them with every tarball and the zip to a
     GitHub release;
   - `homebrew`: renders `Formula/ynm.rb` and `Formula/ynm-slim.rb` from the manifest and pushes
     them to `github.com/eyelock/homebrew-tap`, next to `ynh`;
   - `docker`: pushes `ghcr.io/eyelock/ynm:<version>` and `:latest` (linux/amd64 and arm64).

## What a release contains

| Asset | Contents | Built by |
|---|---|---|
| `ynm_<v>_darwin_arm64.tar.gz`, `_darwin_amd64`, `_linux_arm64`, `_linux_amd64` | `ynm` (Node single-executable with the bundle inside), `LICENSE`, `README.md` | `scripts/release/build-standalone.mjs` |
| `ynm_<v>_slim.tar.gz` | `ynm.mjs` (the bundle), `bin/ynm` (a launcher that requires Node 22.13 or later), `LICENSE`, `README.md` | `scripts/release/build-slim.mjs` |
| `ynm_<v>_lambda.zip` | `index.mjs`, the MCP server bundled for AWS Lambda (Node.js 24 runtime, arm64 or x86_64), exporting `handler`; see [Host ynm on AWS Lambda](host-on-aws-lambda.md) | `scripts/release/build-lambda.mjs` |
| `manifest.json` | Each asset's file name, kind, os, arch, SHA-256 and size; the formulae are rendered from it | `scripts/release/manifest.mjs` |
| `checksums.txt` | SHA-256 of every tarball and the zip, in `sha256sum` format | `scripts/release/manifest.mjs` |

The formulae: `ynm` (the standalone binaries, per-platform `on_macos` / `on_linux` blocks in the
shape goreleaser writes for `ynh`, `depends_on "git"` only) and `ynm-slim` (the slim tarball,
`depends_on "git"` and `"node"`, launcher pinned to Homebrew's node). They conflict with each
other because both install `ynm`. `ynm serve` is the MCP server, so either formula covers the
CLI, the stdio server clients launch, and the hosted service. How users choose between them is
in [Install ynm](install.md).

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
- `scripts/release/build-lambda.mjs` bundles `packages/mcp/src/lambda.ts` with esbuild for Node
  24 as one ESM file, `index.mjs`, embedding the guidance as the CLI bundle does, and zips it.
  It is plain JavaScript (`node:sqlite` is part of the runtime), so one zip serves both Lambda
  architectures. `scripts/release/smoke-lambda.mjs <zip>` unpacks it, imports `index.mjs` and
  calls `handler` with a scheduled health event, `GET /health`, an unauthenticated request (401),
  an MCP `initialize` and a prompt, against a throwaway sqlite store.

## Build the artefacts locally

With the Node version in `.nvmrc` active:

```bash
make release-slim          # dist-release/ynm_<v>_slim.tar.gz, smoke-tested through node
make lambda                # dist/lambda.zip, the Lambda package, smoke-tested by calling handler
make release-standalone    # this machine's ynm_<v>_<os>_<arch>.tar.gz, smoke-tested
make release-manifest      # dist-release/manifest.json with every asset's sha256
make release-notes         # dist-release/RELEASE_NOTES.md from the changeset CHANGELOG
```

Each target wraps a script under `scripts/release/` (`build-slim.mjs`, `fetch-node.mjs`,
`build-standalone.mjs`, `smoke.mjs`, `build-lambda.mjs`, `smoke-lambda.mjs`, `manifest.mjs`);
the workflow calls the same scripts. The workflow names the zip `ynm_<v>_lambda.zip`
(`build-lambda.mjs --out`).

`formula.mjs` needs all four standalone targets in the manifest (the gate fills the missing
ones with placeholders to exercise it):
`node scripts/release/formula.mjs dist-release/manifest.json ynm` and `... ynm-slim`. Linux
targets can be built on macOS too; darwin targets need macOS for `codesign`.

## Secrets

`RELEASE_TOKEN` in the ynm repository must be a token with write access to
`eyelock/homebrew-tap` (the same convention ynh uses). `GITHUB_TOKEN` covers the release and the
image.
