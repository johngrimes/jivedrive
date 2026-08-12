# JiveDrive

## Constitution

### Core Principles

#### I. Test-First (NON-NEGOTIABLE)

Test-driven development is mandatory. Every behaviour is defined by tests written first and confirmed failing before any implementation exists. A task is not complete until its tests pass and the full suite - unit, integration, and end-to-end - is green.

#### II. Simplicity

Every feature ships as the simplest solution with the fewest moving parts: one container serving the SPA and the API, one SQLite database, no ORM, no message queues. Every dependency must earn its place; adding a dependency is a review flag that demands justification.

#### III. Functional TypeScript

All code is functional TypeScript: no classes, no inheritance. Behaviour lives in plain functions operating on plain data, with composition over inheritance. Every exported function has a JSDoc comment describing its contract.

#### IV. Scope Containment

Every storage operation MUST be scoped to the signed-in user's configured bucket and prefix. A user MUST NOT see, download, overwrite, share, or delete objects outside that scope. Scope enforcement lives in the route layer and is exercised by tests.

#### V. Visibility of System Status

Every user action produces a perceptible response. Listings and uploads show progress; every action surfaces an explicit success or failure; sign-in state is always visible; an error never crashes the app or loses the session.

#### VI. Mobile-First, Responsive UI

The UI is designed mobile-first: layouts are built for the smallest supported viewport and progressively enhanced for larger screens. Every view MUST remain fully usable on a narrow viewport - no horizontal scrolling, no clipped or unreachable content - and touch targets MUST be large enough to operate by touch. A feature is not complete until its UI is exercised at mobile, tablet, and desktop widths.

### Security Requirements

- Authentication is WebAuthn passkeys only. Password credentials are never accepted.
- Share links are fire-and-forget: generated, displayed, and never stored, listed, or revoked before expiry.
- Sessions are opaque tokens in httpOnly, Secure, SameSite=Lax cookies. Secrets come from environment configuration, never from the repository.

### Deployment

- The app is deployable on Kubernetes from the Helm chart in `deploy/helm/jivedrive/`: one container serving the built SPA and the API, SQLite on a PVC, single replica with a Recreate strategy.
- Deployment artifacts ship with every feature that changes runtime behaviour.
- The WebAuthn relying party is `drive.grimes.id.au` in production and localhost in development.
