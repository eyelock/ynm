# Connect a client over HTTP

Goal: point an agent client at a hosted ynm server instead of a local stdio process. The client
needs a URL and a token, and no git. To run the server, see
[Operate a hosted store](operate-a-hosted-store.md); tutorial 10 shows it working.

## Install

Give `ynm client install` the server's MCP endpoint (it ends in `/mcp`) and the bearer token:

```bash
ynm client install claude-code --http https://memory.example.com/mcp --token "$YNM_TOKEN"
ynm client install copilot-cli --http https://memory.example.com/mcp --token "$YNM_TOKEN"
ynm client install opencode --http https://memory.example.com/mcp --token "$YNM_TOKEN"
```

Run `ynm client plan <client> --http ...` first to see what would change; `plan` writes nothing.
Leave `--token` off if the server is open (only sensible on localhost).

## What each client gets

| Client | Written | Shape |
|---|---|---|
| claude-code, project scope | `.mcp.json` | `{"type": "http", "url": ..., "headers": {"Authorization": "Bearer ..."}}` |
| claude-code, `--scope user` | runs `claude mcp add --scope user --transport http ynm <url>` | the token is not passed; see below |
| copilot-cli | `~/.copilot/mcp-config.json` | `type: http`, the URL and an `Authorization` header |
| opencode | `opencode.json` | `type: remote`, the URL and an `Authorization` header |
| ynh | nothing extra: the install command is the same whatever you pass | the plugin ships a `hosted` profile that points at `http://localhost:3000/mcp`; select it in ynh, and edit its URL for a remote server |
| pi | not applicable | Pi has no MCP; its extension shells out to the local `ynm` CLI |

The guidance block (`CLAUDE.md` or `AGENTS.md`) is written the same way as for stdio.

## Keep the token out of git

With `--http --token`, Claude Code's project-scope `.mcp.json` and OpenCode's `opencode.json`
contain the token in plain text. Do not commit them. Either add them to `.gitignore`, or install
at user scope, which keeps the file in your home directory:

```bash
ynm client install claude-code --scope user --http https://memory.example.com/mcp
```

The user-scope Claude Code command does not carry the token, so add the header afterwards with
`claude mcp add` options of your own, or edit the entry Claude Code created. `--scope user`
places OpenCode's file at `~/.config/opencode/opencode.json`.

## Check

```bash
ynm client status
```

lists each client with the file it found. To check the server itself, `curl <server>/health`
answers without a token, and a request to `/mcp` without one gets a 401.

## Tokens

The server accepts a static token (`YNM_MCP_TOKEN`), JWTs verified against a JWKS, or OAuth token
introspection, chosen from its environment. For rotation, run the server with `new,old`, move
clients to `new`, then drop `old`. Details are in
[Operate a hosted store](operate-a-hosted-store.md#authentication).
