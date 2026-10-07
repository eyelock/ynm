---
"@ynm/service": minor
"@ynm/cli": minor
---

`ynm client install ynh` now writes ynh's `.agents/harness/plugin.json` layout, and the ynm harness
under `integrations/ynh` uses it too. A harness that still has its manifest in the deprecated
`.ynh-plugin/` directory is recognised by `ynm client status` and `ynm doctor`, and
`ynm client install ynh` moves it to `.agents/harness/` (saying so in its output) before merging
ynm into it, so a harness never ends up with two manifests.
