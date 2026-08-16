# Quickstart: Mobile-Responsive UI with Octicons

End-to-end scenarios that exercise the feature; each is verifiable after
implementation and matches an e2e test in `e2e/responsive.spec.ts`.

## Prerequisites

```bash
bun install            # repo root: pulls @primer/octicons-react
bun run --cwd frontend build
```

E2E (spins up the seeded SPA+API on 5173 itself):

```bash
bun run --cwd e2e playwright test            # full suite
bun run --cwd e2e playwright test responsive  # this feature only
```

## Scenario 1 - Admin reaches /admin from a phone (US1)

1. Open `/files` signed in as the seeded admin, viewport 375x667.
2. Tap the hamburger in the navbar → drawer slides in showing Files,
   Manage users, bucket and space.
3. Tap "Manage users" → lands on `/admin`; drawer is closed.
4. Resize to 1280px → the same nav is a permanently visible sidebar; the
   hamburger is gone.

## Scenario 2 - File browser on a phone (US2)

1. Open `/files` signed in as alice, viewport 375x667.
2. Each file row shows the name with size · modified as a second line, and
   three icon-only buttons (download, share, delete) with accessible names.
3. Tap the download icon → the presigned download starts.
4. At 768px the size/modified values return to columns and the buttons show
   icon + text.
5. No emoji characters appear anywhere in the UI.

## Scenario 3 - Admin tables on a phone (US3)

1. Open `/admin` as admin, viewport 375x667.
2. Invite rows show role (and below 768px bucket/prefix + expiry) under the
   username; Re-send and Cancel are icon buttons.
3. User rows show role/bucket/created under the username; Remove is an icon
   button; tapping it opens the confirmation dialog and removing works.

## Scenario 4 - Dialogs and auth at every width (US4)

1. At 375px open each dialog in turn — share, delete, overwrite confirmation,
   remove confirmation — every control visible, no horizontal scroll, each
   action completes.
2. Sign-in and register render centred, reachable and scroll-free at
   375/768/1280.
3. Repeat the 375px sweep with a dark color scheme: same assertions
   (regression against theme.spec's dark checks).

## Regression gate

- Full existing suite (`auth`, `browse`, `upload`, `share`, `delete`,
  `admin`, `theme`, `listing-error`) green.
- `grep -P '[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}]' -r frontend/src`
  returns nothing (SC-004).
- `bun run --cwd frontend build` ships both themes unchanged (SC-007).
