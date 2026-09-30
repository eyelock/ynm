# ynm developer front door. Every command a developer or CI runs is a target here, so the
# underlying tooling (pnpm, turbo, biome, vitest) can change without changing habits or CI.
.PHONY: help install build rebuild verify check fix lint format typecheck test coverage \
        test-hosted test-tutorials eval-tutorials bench bench-large bench-public gate \
        gen golden docs docs-gen docs-links release-pack changeset version cli clean ci build-pkg test-pkg

M ?= M6

help:
	@echo "Setup:    install (deps) build rebuild (clean install build verify) build-pkg P=<pkg> test-pkg P=<pkg>"
	@echo "Verify:   verify (check typecheck test) check fix lint format typecheck test coverage"
	@echo "Evals:    test-hosted (needs Docker) test-tutorials eval-tutorials (model-driven, opt-in)"
	@echo "          bench bench-large bench-public gate M=M6"
	@echo "Docs:     docs (serve at :4000) docs-gen docs-links gen (regenerate all checked-in artefacts) golden"
	@echo "Release:  release-pack changeset version"
	@echo "Other:    cli clean ci (what CI runs)"

## Setup
install:
	pnpm install --frozen-lockfile

build:
	pnpm build

rebuild:
	pnpm clean || true
	pnpm install
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
release-pack:
	pnpm release:pack

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
ci: install build verify gate
