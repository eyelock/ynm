One JSON file per released version, `<version>.json`, keyed `name@size`. A timing holds p50 and
p95 in milliseconds; a metric holds its value and the tolerance its suite allows (`null` for an
informational metric such as cost, which never gates).

Write a version's file with `YNM_BASELINE_VERSION=<v> YNM_WRITE_BASELINE=1` on the suites listed
in `docs/how-to/cut-a-release.md`. A writing run compares with nothing, so the release gate
(`make gate M=M6`) compares the file, and the benchmark reports under `../reports/`, with the
previous release's. A regression that is a deliberate trade-off goes in `<version>.accepted.json`
as `{ "<key>": "<reason>" }`; any other regression fails the gate.
