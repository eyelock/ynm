---
"@ynm/cli": patch
---

Moves `@oclif/core` to 5.1.12, which declares `minimatch ^11.0.1`, so the bundled CLI takes the fix for GHSA-g3hv-75wg-m249 (minimatch below 11.0.1) from its own dependency and not only from the root override (ynm #155).
