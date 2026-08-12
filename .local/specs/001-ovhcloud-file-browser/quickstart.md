# Quickstart: JiveDrive

Key end-to-end scenarios that exercise the feature, phrased so they can later
be validated. Each scenario assumes a running instance: locally
(`bun dev` with `frontend/` and `backend/` workspaces) or on Kubernetes via
the Helm chart.

## Scenario 1 - Bootstrap and first sign-in

1. Deploy with `JIVEDRIVE_BOOTSTRAP_ADMIN_USERNAME=admin` and
   `JIVEDRIVE_BOOTSTRAP_ADMIN_BUCKET` / `JIVEDRIVE_BOOTSTRAP_ADMIN_PREFIX` set.
2. Open `https://drive.grimes.id.au` (or `http://localhost:5173` in dev).
3. Enter `admin`, complete the passkey prompt, and land on the file browser
   for the configured bucket and prefix.

## Scenario 2 - Invite, register, browse, upload, share, delete

1. As `admin`, open "Manage users", create an invite for `alice` with bucket
   `jivedrive-prod` and prefix `users/alice/`.
2. Open the invite link in a private window; choose a passkey; alice is signed
   in and sees an empty space.
3. Upload a file into the folder; it appears in the listing with size and
   timestamp.
4. Click the file, download it; the file arrives on the machine.
5. Share the file with default 7-day expiry; open the link in another private
   window (no session) and the file downloads without login.
6. Delete the file (confirm the prompt); the listing is empty again.

## Scenario 3 - Overwrite protection

1. Upload `report.pdf`.
2. Upload `report.pdf` again; the UI asks for confirmation and refuses without
   it (HTTP 409); confirming replaces the object (size updates).

## Scenario 4 - Invite expiry and user removal

1. Create an invite and manually age it past 48 hours (or wait); the admin
   list shows it as expired; opening the link shows "invite expired".
2. Admin clicks "Re-send"; the new link works.
3. Admin removes alice; alice can no longer sign in; the objects under
   `users/alice/` remain in the bucket (verify in OVHcloud console).

## Scenario 5 - Scope isolation

1. With `alice` and `bob` having different prefixes, ensure bob cannot list,
   download, upload to, delete, or share any object under alice's prefix -
   requests with keys outside the user's prefix return 400.

## Validation

- All scenarios pass against a local instance with a mock S3 layer and a
  seeded database, and against the real OVHcloud bucket for scenarios 1-4.
- `helm lint` and `helm template` succeed for the chart with default values.
- The e2e suite (Playwright) covers scenarios 1, 2, 3, and 5.
