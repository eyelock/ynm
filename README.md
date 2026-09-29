# ynm

**Your named memory.** Persistent memory for coding agents, stored as git notes in the
repositories you already have, served over MCP and a CLI with identical commands. Personal
memory stays on your machine; shared memory travels with `git push`. Sibling of
[ynh](https://github.com/eyelock/ynh): ynh manages how an agent is guided, ynm what it remembers.

## Quickstart

```bash
brew install eyelock/tap/ynm
cd your-repo
ynm init                          # shared memory for this repo; personal memory in ~/.ynm
ynm client install claude-code    # or copilot-cli, opencode, pi, ynh
ynm remember --type procedural --level distributed --content "Run pnpm check before pushing"
ynm recall --text "before pushing"
```

The agent now has `memory_recall`, `memory_remember` and eight more tools; every one is also a
CLI command. `ynm serve` is the MCP server (stdio), `ynm serve --http` the hosted service.

## Documentation

[eyelock.github.io/ynm](https://eyelock.github.io/ynm) (source in [`docs/`](docs/README.md)):

- [Tutorials](docs/tutorial/README.md): ordered lessons that double as the acceptance tests.
- [How-to guides](docs/how-to/README.md): hosted stores, keys, releases.
- [Explanation](docs/explanation/README.md): the six memory types, and the
  [decision records](docs/adr/README.md) behind the design.
- [Reference](docs/reference/README.md): commands, tools, configuration.

Contributing, building and running the evals: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
