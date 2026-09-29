.PHONY: rebuild build test check lint format typecheck clean gate cli docs docs-gen docs-links help

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

# Serve the user docs (docsify) at http://localhost:4000; any static server works, python is always there
docs:
	@echo "docs at http://localhost:4000 (ctrl-c to stop)"
	@python3 -m http.server 4000 --directory docs

# Regenerate the reference pages and manual test plan from the built code, then check links
docs-gen:
	pnpm build && pnpm docs:gen && pnpm docs:links

docs-links:
	pnpm docs:links

help:
	@echo "Build:    rebuild build clean"
	@echo "Quality:  check lint format typecheck test"
	@echo "Gates:    gate M=M0 (one gate per milestone; a milestone closes when its gate has no todos)"
	@echo "CLI:      cli"
	@echo "Docs:     docs (serve locally) docs-gen (regenerate reference) docs-links"
