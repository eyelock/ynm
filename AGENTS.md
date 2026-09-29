# ynm for agents

This repository is ynm, persistent memory for coding agents. Read `CONTRIBUTING.md` for the
build, test and eval commands and the package layout; read `docs/adr/README.md` before changing
a design decision. Skills for common jobs are under `.agents/skills/`.

Rules that are easy to get wrong:

- Never read or print `.env` or any `*_API_KEY` variable. Load secrets into a shell with
  `set -a && . ./.env && set +a` if a command needs them.
- Model-backed evals cost money. They are opt-in (`YNM_EVAL_CALIBRATED=1`, `YNM_EVAL_CLAUDE_CLI=1`)
  and small by default; do not raise their sizes.
- Milestone ids belong only in gate files and ADR history lines.
- `docs/adr` is the design record; `.claude/plans` is scratch and is never committed.
