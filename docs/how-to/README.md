# How-to guides

Recipes for a goal you already have. Each assumes you know the basics from the
[tutorials](../tutorial/README.md) and gets to the point.

| Guide | Goal |
|---|---|
| [Install ynm](install.md) | Choose between Homebrew (standalone or slim), a direct download, the slim tarball on your own Node, a source checkout and the Docker image; then let `ynm init` set up your agent clients |
| [Retrofit an existing repository](retrofit-an-existing-repo.md) | Give a repository with history and a team a distributed memory without changing any tracked file, and decide what to do with the client files `ynm init` writes |
| [Share an org store](share-an-org-store.md) | Keep memory that spans many repositories in one dedicated bare repo, mounted everywhere |
| [Choose the SQLite provider](choose-the-sqlite-provider.md) | Keep a store in a single SQLite file instead of git notes |
| [Choose the S3 provider](choose-the-s3-provider.md) | Keep a store in an S3 bucket that many processes can write at once |
| [Configure the judge and writer](configure-judge-and-writer.md) | Choose which model judges in `ynm dream` and on recall, and which one writes |
| [Connect a client over HTTP](connect-over-http.md) | Point an agent client at a hosted server instead of a local stdio process |
| [Use personal memory with a hosted store](use-personal-and-hosted-memory.md) | Keep your memory private locally while reading, and choosing to share into, a team's hosted store |
| [Add a client adapter](add-a-client-adapter.md) | Teach `ynm init` and `ynm client install` about a new agent client |
| [Operate a hosted store](operate-a-hosted-store.md) | Run the HTTP service: server or Lambda, auth modes, key rotation, the scheduler, scaling |
| [Host ynm on AWS Lambda](host-on-aws-lambda.md) | Run a hosted store as a Lambda function behind a Function URL, with scheduled dream and compaction |
| [Send telemetry to an OpenTelemetry collector](send-telemetry.md) | See ynm's requests, tool calls, commands, store calls and dream passes as traces and metrics in your own backend, without memory content |
| [Back up and restore](back-up-and-restore.md) | Keep a copy of memory you can restore from |
| [Cut a release](cut-a-release.md) | Version, freeze the evals, tag, and publish the binaries, slim tarball, Lambda package, formulae and image |
