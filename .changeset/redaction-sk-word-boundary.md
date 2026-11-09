---
"@ynm/service": patch
"@ynm/cli": patch
---

Secret redaction no longer refuses ordinary words that contain `sk-`, such as `desk-asks` (ynm #116).
