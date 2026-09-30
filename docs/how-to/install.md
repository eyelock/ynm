# Install ynm

Every release ships ynm five ways. They are the same program: the same commands, the same MCP
server (`ynm serve`), the same stores. Pick one by what the machine already has.

| Mechanism | What you get | Size | Needs Node? | Needs git? | Best for |
|---|---|---|---|---|---|
| [Homebrew, standalone](#homebrew-standalone-recommended) | `ynm`, a single executable with Node inside | about 40 MB download, 126 MB installed | No | Yes | Most people on macOS or Linux |
| [Homebrew, slim](#homebrew-slim) | `ynm` as one JavaScript file run by Homebrew's `node` | about 1.4 MB download | Yes (Homebrew's, installed for you) | Yes | Machines that already keep Homebrew's `node` |
| [Direct download of a binary](#direct-download-of-a-binary) | The standalone executable from the release page | 40 to 45 MB download | No | Yes | No Homebrew, CI images, servers |
| [Slim tarball with your own Node](#slim-tarball-with-your-own-node) | `ynm.mjs` and a `bin/ynm` launcher | about 1.4 MB download | Yes, 22.13 or later | Yes | You manage Node yourself (nvm, fnm, a base image) |
| [From source](#from-source) | A checkout you can change | the repository plus `node_modules` | Yes, 22.13 or later, and pnpm | Yes | Working on ynm |
| [Docker image](#docker-image) | The hosted service (`ynm serve --http`) in front of a bare repo | an Alpine image | No | No (inside the image) | Running a hosted store |

Every mechanism needs `git`: memory is stored as git notes. Node 22.13 is the first release with
`node:sqlite` unflagged, which the index uses.

Check any of them the same way:

```bash
ynm --version
```

Expected: `@ynm/cli/<version> <platform> node-v<version>`. For the standalone binary the Node
version is the one built into it.

## Homebrew, standalone (recommended)

```bash
brew install eyelock/tap/ynm
```

The formula picks the binary for your platform (macOS or Linux, arm64 or x86-64) and depends on
`git` only. `brew upgrade ynm` moves to the next release.

## Homebrew, slim

```bash
brew install eyelock/tap/ynm-slim
```

This installs the same program as one bundled JavaScript file and runs it on Homebrew's `node`,
which the formula depends on, whatever `node` comes first on your `PATH`. It is the small
download when Homebrew's `node` is already there. `ynm` and `ynm-slim` both install a `ynm`
executable, so install one of them.

## Direct download of a binary

Release assets are named `ynm_<version>_<os>_<arch>.tar.gz`, with `<os>` `darwin` or `linux` and
`<arch>` `arm64` or `amd64`. Each holds `ynm`, `LICENSE` and `README.md`. `checksums.txt` beside
them lists every asset's SHA-256.

```bash
VERSION=0.1.0
OS=$(uname -s | tr '[:upper:]' '[:lower:]')                       # darwin or linux
ARCH=$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')  # arm64 or amd64
ASSET="ynm_${VERSION}_${OS}_${ARCH}.tar.gz"
BASE="https://github.com/eyelock/ynm/releases/download/v${VERSION}"
curl -fsSLO "$BASE/$ASSET"
curl -fsSLO "$BASE/checksums.txt"
grep " $ASSET\$" checksums.txt | shasum -a 256 -c -   # prints "<asset>: OK"
tar -xzf "$ASSET" ynm
chmod +x ynm
mkdir -p ~/.local/bin && mv ynm ~/.local/bin/
export PATH="$HOME/.local/bin:$PATH"                  # add this line to your shell profile
ynm --version
```

On Linux without `shasum`, use `sha256sum -c -` in its place. The macOS binaries are signed ad
hoc, not notarized: a copy downloaded with a browser carries the quarantine attribute and
Gatekeeper refuses it. `curl` does not set that attribute; for a browser download, run
`xattr -d com.apple.quarantine ynm` once.

## Slim tarball with your own Node

`ynm_<version>_slim.tar.gz` holds `ynm.mjs` (the CLI and the MCP server bundled into one file),
`bin/ynm`, `LICENSE` and `README.md`. The launcher runs `ynm.mjs` on the `node` found on your
`PATH`, or on `YNM_NODE` when set, after checking it is 22.13 or later.

```bash
VERSION=0.1.0
BASE="https://github.com/eyelock/ynm/releases/download/v${VERSION}"
curl -fsSLO "$BASE/ynm_${VERSION}_slim.tar.gz"
curl -fsSLO "$BASE/checksums.txt"
grep " ynm_${VERSION}_slim.tar.gz\$" checksums.txt | shasum -a 256 -c -
mkdir -p ~/.local/share/ynm
tar -xzf "ynm_${VERSION}_slim.tar.gz" -C ~/.local/share/ynm
mkdir -p ~/.local/bin && ln -sf ~/.local/share/ynm/bin/ynm ~/.local/bin/ynm
export PATH="$HOME/.local/bin:$PATH"
ynm --version
```

The launcher follows the symlink to find `ynm.mjs`. With an older Node it stops before running
anything:

```text
ynm needs Node 22.13 or later (found v20.11.1); install it or use the standalone binary
```

## From source

Requires Node 22.13 or later and pnpm.

```bash
git clone https://github.com/eyelock/ynm.git
cd ynm
pnpm install && pnpm build
mkdir -p ~/.ynm/bin
printf '#!/bin/sh\nexec node %s/packages/cli/bin/run.js "$@"\n' "$PWD" > ~/.ynm/bin/ynm
chmod +x ~/.ynm/bin/ynm
export PATH="$HOME/.ynm/bin:$PATH"
ynm --version
```

To build the release artefacts from the checkout, see [Cut a release](cut-a-release.md#build-the-artefacts-locally).

## Docker image

The image is the hosted service, not a desktop install: the MCP server over HTTP in front of a
bare repo under `/data`, with an optional dream worker on a timer.

```bash
docker run -d --name ynm -p 3000:3000 -v ynm-data:/data \
  -e YNM_MCP_TOKEN=change-me -e YNM_DREAM_EVERY=15m ghcr.io/eyelock/ynm
```

Tags are `latest` and each version, for `linux/amd64` and `linux/arm64`. Configuration, auth and
backups are in [Operate a hosted store](operate-a-hosted-store.md); connecting clients to it is in
[Connect a client over HTTP](connect-over-http.md).

## Next

[Tutorial 1: First memory](../tutorial/01-first-memory.md).
