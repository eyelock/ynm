# ynm developer front door. Every command a developer or CI runs is a target here, so the
# underlying tooling (pnpm, turbo, biome, vitest) can change without changing habits or CI.
.PHONY: help deps install uninstall build rebuild verify check fix lint format typecheck test coverage coverage-diff \
        test-hosted test-tutorials eval-tutorials bench bench-large bench-public gate \
        gen golden docs docs-gen docs-links release-slim release-standalone release-manifest release-notes changeset version cli clean ci build-pkg test-pkg

M ?= M6

help:
	@echo "Setup:    deps build install (~/.ynm/bin/ynm runs this checkout) uninstall rebuild build-pkg P= test-pkg P="
	@echo "Verify:   verify (check typecheck test) check fix lint format typecheck test coverage coverage-diff"
	@echo "Evals:    test-hosted (needs Docker) test-tutorials eval-tutorials (model-driven, opt-in)"
	@echo "          bench bench-large bench-public gate M=M6"
	@echo "Docs:     docs (serve at :4000) docs-gen docs-links gen (regenerate all checked-in artefacts) golden"
	@echo "Release:  release-slim release-standalone release-manifest release-notes changeset version"
	@echo "Other:    cli clean ci (what CI runs: deps build verify gate)"

## Setup
deps:
	pnpm install --frozen-lockfile

# A locally addressable ynm for testing (ynh-style): ~/.ynm/bin/ynm runs this checkout
install: build
	node scripts/install-local.mjs

uninstall:
	node scripts/install-local.mjs --remove

build:
	pnpm build

rebuild:
	pnpm clean || true
	pnpm install --no-frozen-lockfile
	$(MAKE) build verify

# One package: `make build-pkg P=store`, `make test-pkg P=service`
build-pkg:
	pnpm --filter @ynm/$(P) build

test-pkg:
	pnpm --filter @ynm/$(P) test

## Verify
verify: check typecheck test

check:
	pnpm check

fix:
	pnpm check:fix

lint:
	pnpm lint

format:
	pnpm format

typecheck:
	pnpm typecheck

test:
	pnpm test

coverage:
	pnpm test:coverage

# Line coverage of what this branch changes, against BASE (default origin/develop); run coverage first.
coverage-diff:
	node scripts/coverage-diff.mjs --base $(or $(BASE),origin/develop) --min 80

## Evals (see docs/adr/014 and docs/tutorial/RUNNING.md)
test-hosted:
	pnpm --filter @ynm/evals test:hosted

test-tutorials:
	pnpm --filter @ynm/evals test:tutorials

eval-tutorials:
	YNM_EVAL_CLAUDE_CLI=1 pnpm --filter @ynm/evals eval:tutorials

bench:
	pnpm bench

bench-large:
	YNM_BENCH_LARGE=1 pnpm bench

bench-public:
	pnpm bench:public

# Milestone gate, e.g. `make gate M=M1`
gate:
	pnpm gate $(M)

## Docs and generated artefacts
docs:
	@echo "docs at http://localhost:4000 (ctrl-c to stop)"
	@python3 -m http.server 4000 --directory docs

docs-gen:
	pnpm docs:gen

docs-links:
	pnpm docs:links

# Rewrite golden files after an intended change (client adapters, wiki)
golden:
	YNM_WRITE_GOLDEN=1 pnpm --filter @ynm/service test
	YNM_WRITE_GOLDEN=1 pnpm --filter @ynm/wiki test

# Everything generated and checked in: client artefacts, reference docs, manual test plan
gen: build
	pnpm gen:clients
	pnpm docs:gen
	pnpm docs:links

## Release
# Release artefacts (docs/how-to/cut-a-release.md): the slim tarball, then this machine's
# standalone binary with the Node from .nvmrc, each smoke-tested; then the manifest.
VERSION := $(shell node -p "require('./packages/cli/package.json').version")
OS := $(shell node -p "process.platform")
ARCH := $(shell node -p "process.arch === 'arm64' ? 'arm64' : 'amd64'")

release-slim: build
	node scripts/release/build-slim.mjs $(VERSION)
	node scripts/release/smoke.mjs $(VERSION) node dist-release/ynm.mjs

release-standalone: build
	node scripts/release/build-standalone.mjs --os $(OS) --arch $(ARCH) --version $(VERSION) \
	  --node-tarball "$$(node scripts/release/fetch-node.mjs --os $(OS) --arch $(ARCH))"
	node scripts/release/smoke.mjs $(VERSION) dist-release/ynm_$(VERSION)_$(OS)_$(ARCH)/ynm

release-manifest:
	node scripts/release/manifest.mjs $(VERSION)

release-notes:
	node scripts/release/notes.mjs $(VERSION)

changeset:
	pnpm changeset

version:
	pnpm release:version

## Other
cli:
	pnpm --filter @ynm/cli run cli --help

clean:
	pnpm clean

# Exactly what CI runs, in order
ci: deps build verify gate
