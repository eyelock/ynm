# Security policy

## Supported versions

Only the latest release of ynm receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability
reporting on this repository (Security tab, "Report a vulnerability"), or email
support@eyelock.net if that is not available to you.

Include what you found, how to reproduce it, and the version (`ynm --version`). You will get an
acknowledgement within five working days and a fix or a mitigation plan within thirty days for
anything confirmed. Credit is given in the release notes unless you ask otherwise.

## What counts

ynm stores memory in git repositories and serves it over MCP. Reports about these are
especially welcome: a distributed write that bypasses the redaction gate, a personal record
reaching a distributed ref, an authentication bypass on the hosted HTTP transport, a client adapter
writing outside the paths it documents, or the model-backed passes acting where the design
says they may only flag.
