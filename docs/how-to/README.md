# How-to guides

Recipes for a goal you already have. Each assumes you know the basics from the
[tutorials](../tutorial/README.md) and gets to the point.

| Guide | Goal |
|---|---|
| [Install ynm](install.md) | Choose between Homebrew (standalone or slim), a direct download, the slim tarball on your own Node, a source checkout and the Docker image |
| [Retrofit an existing repository](retrofit-an-existing-repo.md) | Give a repository with history and a team a shared memory without changing any tracked file |
| [Share an org store](share-an-org-store.md) | Keep memory that spans many repositories in one dedicated bare repo, mounted everywhere |
| [Choose the SQLite provider](choose-the-sqlite-provider.md) | Keep a store in a single SQLite file instead of git notes |
| [Configure the judge and writer](configure-judge-and-writer.md) | Choose which model judges in `ynm dream` and on recall, and which one writes |
| [Connect a client over HTTP](connect-over-http.md) | Point an agent client at a hosted server instead of a local stdio process |
| [Add a client adapter](add-a-client-adapter.md) | Teach `ynm client install` about a new agent client |
| [Operate a hosted store](operate-a-hosted-store.md) | Run the HTTP service: auth modes, key rotation, the scheduler, scaling |
| [Back up and restore](back-up-and-restore.md) | Keep a copy of memory you can restore from |
| [Cut a release](cut-a-release.md) | Version, freeze the evals, tag, and publish the binaries, slim tarball, formulae and image |
