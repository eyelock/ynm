.PHONY: rebuild build test check lint format typecheck clean gate cli help

rebuild:
	pnpm clean || true
	pnpm install
	pnpm build
	pnpm check
	pnpm typecheck
	pnpm test

build:
	pnpm build

test:
	pnpm test

check:
	pnpm check

lint:
	pnpm lint

format:
	pnpm format

typecheck:
	pnpm typecheck

clean:
	pnpm clean

# Milestone gate, e.g. `make gate M=M1`
gate:
	pnpm gate $(M)

cli:
	pnpm --filter @ynm/cli run cli --help

help:
	@echo "Build:    rebuild build clean"
	@echo "Quality:  check lint format typecheck test"
	@echo "Gates:    gate M=M0 (one gate per milestone; a milestone closes when its gate has no todos)"
	@echo "CLI:      cli"
