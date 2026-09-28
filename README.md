# ynm

**Your named memory.** Agent memory in git notes, exposed over MCP and CLI. Sibling of
[ynh](https://github.com/eyelock/ynh) (your named harness): ynh manages the guide layer of an
agent; ynm manages what the agent remembers.

Status: pre-alpha. The architecture is recorded as draft ADRs in [`docs/adr`](docs/adr/README.md).

## Development

```bash
pnpm install
pnpm build
pnpm check && pnpm typecheck && pnpm test
pnpm gate M0        # milestone gate; see packages/evals/src/gates
```

Requires Node 22 or later and pnpm (via `corepack enable`).

## License

MIT
