---
"@ynm/evals": patch
---

The release regression check no longer compares two public benchmark reports that were run differently: a different dataset, case count, question count, k, index or (when both answered) answering sample, writer or judge fails the gate with a `<dataset>:setup` regression naming the differences, which `<version>.accepted.json` can accept with a reason. Benchmark reports now carry 95% confidence intervals for retrieval and answering (ynm #173).
