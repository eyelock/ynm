// pnpm loads this before it resolves or fetches anything. @eyelock/otel-spool-exporter comes from
// GitHub Packages, which needs a token even to read, and without NODE_AUTH_TOKEN pnpm ignores the
// whole .npmrc and fails later with a 404 from the public registry. Say what is missing instead,
// only for the commands that fetch, so `pnpm build` and `pnpm test` work without the token.
const FETCHING = new Set(["install", "i", "add", "update", "up", "upgrade", "fetch", "dedupe"]);

if (!process.env.NODE_AUTH_TOKEN && process.argv.slice(2).some((a) => FETCHING.has(a))) {
  process.stderr.write(
    "\nNODE_AUTH_TOKEN is not set. ynm installs @eyelock/otel-spool-exporter from GitHub Packages,\n" +
      "which needs a GitHub token with read:packages, for example:\n\n" +
      "  export NODE_AUTH_TOKEN=$(gh auth token)\n\n" +
      'See CONTRIBUTING.md, "Build and test".\n\n'
  );
  process.exit(1);
}

module.exports = {};
