# Security policy

JiveDrive handles authentication (WebAuthn passkeys, OAuth for MCP
clients), per-user storage scoping and anonymous share links, so security
reports are taken seriously.

## Reporting a vulnerability

Report vulnerabilities privately through
[GitHub security advisories](https://github.com/johngrimes/jivedrive/security/advisories/new).
Do not open a public issue or pull request for a suspected vulnerability.

Include:

- the affected version or commit,
- the steps to reproduce, with a proof of concept where possible,
- the impact you expect (for example, access to objects outside a user's
  bucket and prefix, session or token theft, enrollment without an invite).

You will get an acknowledgement, and the fix will be coordinated with you
before the advisory is published.

## Supported versions

Only the latest commit on `main` receives security fixes.

## Scope

In scope: the backend API, the SPA, the MCP and OAuth endpoints, the
Docker image and the Helm chart in this repository.

Out of scope: vulnerabilities in OVHcloud, in third-party dependencies with
no exploitable path through JiveDrive, and misconfigured deployments (for
example, a WebAuthn origin served without TLS).
