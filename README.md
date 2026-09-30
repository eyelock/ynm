# ynm

**Your named memory.** Persistent memory for coding agents, stored as git notes in the
repositories you already have, served over MCP and a CLI with identical commands. Personal
memory stays on your machine; shared memory travels with `git push`. Sibling of
[ynh](https://github.com/eyelock/ynh): ynh manages how an agent is guided, ynm what it remembers.

## Quickstart

```bash
brew install eyelock/tap/ynm      # one executable, needs only git
cd your-repo && ynm init          # shared memory for this repo, and the agent clients it already uses
```

`ynm init` creates the shared memory mount (personal memory lives in `~/.ynm`) and configures the
agent clients this repository already uses: Claude Code, OpenCode or Pi. Each gets the MCP server,
the memory guidance, and, where the client has them, hooks that load memory when a session starts
and steer "remember this" into ynm rather than the client's own note files. A client found only on
your machine, such as Copilot CLI, gets a one-line suggestion, and a ynh harness gets ynm with
`ynm client install ynh`. `ynm client install <client>` does the same for one client by hand.

Other ways to install (a direct download, the slim build on your own Node, from source, the
Docker image) are in [Install ynm](docs/how-to/install.md).

The agent now has `memory_recall`, `memory_remember` and eight more tools; every one is also a
CLI command:

```bash
ynm remember --type procedural --level distributed --content "Run pnpm check before pushing"
ynm recall --text "before pushing"
```

`ynm serve` is the MCP server (stdio), `ynm serve --http` the hosted service.

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
