# Feature Specification: JiveDrive - file browser for OVHcloud Object Storage

**Feature**: `001-ovhcloud-file-browser`
**Created**: 2026-08-12
**Status**: Draft

## User Scenarios & Testing _(mandatory)_

### User Story 1 - Passkey sign-in and invite registration (Priority: P1)

A user opens the JiveDrive web app, enters their username, and completes a
passkey prompt to sign in. A person who has been invited by an admin opens
their invite link, chooses a username and registers their passkey, which makes
them a signed-in user with access to their own bucket and prefix.

**Why this priority**: Nothing else in the app is usable without
authentication, and the multi-user model depends on invite-based registration.

**Independent Test**: With a seed user, a user can sign in and sign out.
With a valid, unexpired invite record, an invitee can complete registration
and immediately sign in. An expired or already-used invite is rejected.

**Acceptance Scenarios**:

1. **Given** a seeded user with a registered passkey, **When** the user enters
   their username and completes the passkey prompt, **Then** they are signed in
   and see the file browser for their configured bucket and prefix.
2. **Given** an unregistered user with a valid invite link, **When** they open
   the link and register their passkey, **Then** their account is created and
   they are signed in.
3. **Given** an invite that has expired or already been claimed, **When** the
   invitee opens the link, **Then** registration is refused with a clear
   message and they cannot sign in.
4. **Given** a signed-in user, **When** they sign out, **Then** a subsequent
   request to a protected endpoint is rejected.
5. **Given** a fresh deployment with bootstrap admin configuration set,
   **When** the bootstrap user signs in for the first time, **Then** they are
   signed in as an admin with user-management access.

---

### User Story 2 - Browse and download files (Priority: P1)

A signed-in user sees the contents of their own bucket and prefix as a list of
folders and files. They navigate into and out of folders, load more entries
when a folder has more than one page of objects, and download any file to
their machine.

**Why this priority**: Browsing is the core purpose of the app. All other
stories build on this screen.

**Independent Test**: With a bucket containing a known set of objects across
several prefixes, a user can navigate the folder tree, see correct file
names and sizes, page through large folders, and download a file.

**Acceptance Scenarios**:

1. **Given** a user's bucket and prefix contains files and subfolders, **When**
   they open the browser, **Then** folders and files are listed separately with
   file names and sizes, and any subfolders are clickable.
2. **Given** a folder with more than 1000 objects, **When** the user reaches
   the end of the current list, **Then** they can load the next page until all
   objects are shown.
3. **Given** a folder deeper in the tree, **When** the user navigates into it
   and clicks a file, **Then** the file downloads to their machine.
4. **Given** an empty prefix or an empty subfolder, **When** the user opens it,
   **Then** an empty state is shown with no error.
5. **Given** an object key that does not exist or is inaccessible, **When** the
   user attempts to download it, **Then** a clear error is shown and the
   session remains usable.

---

### User Story 3 - Upload files (Priority: P2)

A signed-in user uploads a single file into the folder they are currently
viewing. The UI shows an uploading indicator and a completion or failure
message. If a file with the same name already exists in that folder, the user
is asked to confirm overwriting it.

**Why this priority**: Upload is a core workflow but secondary to browsing;
browsing must exist first to choose a destination folder.

**Independent Test**: A user uploads a file, sees it appear in the listing,
then uploads another file with the same name and confirms the overwrite, and
sees the updated size.

**Acceptance Scenarios**:

1. **Given** a signed-in user viewing a folder, **When** they choose a file to
   upload, **Then** an upload progress indicator is shown and, on completion,
   the file appears in the listing.
2. **Given** an existing file with the same name in the destination folder,
   **When** the user attempts to upload over it, **Then** they are asked to
   confirm and the file is replaced only after confirmation.
3. **Given** a failed upload (network error or storage error), **When** the
   upload completes, **Then** a clear failure message is shown and the file
   does not appear in the listing.
4. **Given** a file uploaded with a name containing spaces or special
   characters, **When** it appears in the listing, **Then** the name is shown
   correctly and the file can be downloaded.

---

### User Story 4 - Share links (Priority: P2)

A signed-in user generates a share link for any file in their space. The
link is a URL that the storage provider serves directly and that expires
after a configurable period, defaulting to 7 days, with per-link overrides
(e.g. 1 hour, 24 hours, 7 days, 30 days). The generated link is displayed
for copying and is not stored by the app.

**Why this priority**: Sharing is the second headline feature of the app.

**Independent Test**: A user generates a link for a file, opens it in a
private/incognito browser window (no session), and the file downloads
successfully. A link generated with a short expiry (e.g. 1 hour) can be
observed to stop working after its expiry by inspecting the URL's expiry
parameter or by waiting.

**Acceptance Scenarios**:

1. **Given** a file in the user's space, **When** they choose to share it,
   **Then** a link that expires after the default 7 days is shown with a
   copy button.
2. **Given** the share dialog, **When** the user selects a different expiry,
   **Then** the generated link reflects that expiry.
3. **Given** a generated link, **When** someone without a JiveDrive session
   opens it, **Then** the file downloads without any login.
4. **Given** an expired link, **When** someone opens it, **Then** access is
   refused by the storage provider (HTTP 403) and the failure is surfaced to
   the person sharing.
5. **Given** a file whose key has been deleted, **When** someone opens a
   previously generated link, **Then** access is refused and no stale data is
   returned.

---

### User Story 5 - Delete files (Priority: P3)

A signed-in user permanently deletes a file from their space after confirming
the action. Deletion removes the object from storage immediately and cannot be
undone.

**Why this priority**: Valuable but lower than upload and sharing; a read-only
browser with uploads remains fully useful without it.

**Independent Test**: A user deletes a file, confirms the prompt, and the file
disappears from the listing and can no longer be downloaded or shared.

**Acceptance Scenarios**:

1. **Given** a file in the user's space, **When** the user chooses to delete
   it and confirms, **Then** the file is removed from the listing and any
   download or share attempt fails.
2. **Given** the delete confirmation dialog, **When** the user cancels,
   **Then** the file remains untouched.

---

### User Story 6 - Admin user management (Priority: P3)

An admin user manages accounts: they invite new users (choosing username,
bucket, prefix, and admin status), see the list of users and pending invites,
re-send invites, cancel pending invites, and remove users. Invites expire 48
hours after creation. Removing a user leaves their stored objects untouched.

**Why this priority**: Needed for the full multi-user model but not for the
first working deploy; a bootstrap admin seeded at deploy time covers initial
use.

**Independent Test**: An admin invites a new user, the invitee registers and
signs in, the admin sees the active user, and removes the user, after which
the user can no longer sign in but their objects remain in storage.

**Acceptance Scenarios**:

1. **Given** an admin user, **When** they create an invite with a username,
   bucket, prefix, and admin status, **Then** an invite link is shown that
   expires 48 hours later.
2. **Given** an invite link, **When** the invitee registers, **Then** the
   invite is marked used and the new user appears in the user list.
3. **Given** a pending invite past 48 hours, **When** the invitee opens the
   link, **Then** registration is refused and the admin is shown the invite as
   expired with an option to re-send.
4. **Given** an active user, **When** an admin removes them, **Then** the user
   can no longer sign in and the objects in their bucket and prefix are
   untouched.
5. **Given** an admin screen, **When** a non-admin user attempts to access user
   management, **Then** access is refused.

### Edge Cases

- What happens when the configured S3 credentials are invalid or the endpoint
  is unreachable? Every storage operation surfaces a clear error; the app
  itself stays up and the user remains signed in.
- What happens when a user's configured bucket or prefix does not exist?
  The browser shows an empty state or a clear "prefix not found" message,
  never a crash.
- What happens when two users share the same prefix? Each sees the same
  objects - acceptable, since admins choose prefixes and this may be intended
  for team spaces.
- What happens when a file name contains characters that need URL encoding
  (spaces, unicode, `#`, `?`)? Names are shown as stored and all URLs are
  properly encoded.
- What happens when the user's session expires mid-upload or mid-browse? The
  next request re-prompts for sign-in; partial upload state is not resumed.
- What happens when a deleted user's invite link is still open? The invite is
  removed with the user, so the link is refused.
- What happens if a passkey is lost? The admin can remove and re-invite the
  user; passkey management itself is left to the platform (browser/OS).

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: The system MUST authenticate users with platform passkeys
  (WebAuthn) and MUST NOT accept password credentials.
- **FR-002**: The system MUST support a username-first sign-in flow.
- **FR-003**: New users MUST register by claiming a time-limited invite link
  created by an admin; invites MUST expire 48 hours after creation.
- **FR-004**: Every user account MUST be associated with exactly one bucket
  and prefix in OVHcloud Object Storage, chosen by the admin at invite time.
- **FR-005**: All file operations MUST be scoped to the signed-in user's
  bucket and prefix; users MUST NOT see or access other users' objects.
- **FR-006**: The system MUST list the contents of a prefix, separating
  folders (common prefixes) from files (objects), and MUST paginate
  listings that exceed one page.
- **FR-007**: Users MUST be able to navigate into and out of folders and
  download files to their machine.
- **FR-008**: Users MUST be able to upload a single file into the folder they
  are viewing, with visible progress and explicit success or failure.
- **FR-009**: Uploading over an existing object with the same key MUST require
  explicit confirmation; after confirmation the object is replaced.
- **FR-010**: Users MUST be able to permanently delete an object after
  confirming; deletion is immediate and irreversible.
- **FR-011**: Users MUST be able to generate a share link for any object in
  their space; the link MUST expire after a configurable period, defaulting
  to 7 days, and MUST serve the file to anyone who has the link without a
  JiveDrive session.
- **FR-012**: The system MUST NOT store generated share links or provide
  revocation; links expire naturally at their chosen expiry.
- **FR-013**: Admin users MUST be able to invite users, re-send and cancel
  pending invites, list users, and remove users.
- **FR-014**: Removing a user MUST NOT delete any objects in storage.
- **FR-015**: Non-admin users MUST NOT access user-management functionality.
- **FR-016**: A bootstrap admin account MUST be provisionable at deploy time
  (e.g. via configuration) for first access.
- **FR-017**: All storage operations MUST surface clear error messages and
  MUST NOT crash or lose the user's session.
- **FR-018**: The app MUST be deployable on Kubernetes as a single replica
  (SQLite-backed) with persistent storage for its database.

### Key Entities

- **User**: A registered account. Attributes: username (unique), bucket name,
  prefix, admin flag, creation time. Related to zero or more passkey
  credentials and zero or more invites issued or claimed.
- **Passkey Credential**: A registered platform credential (WebAuthn public
  key) belonging to a user. A user may have several (one per device).
- **Invite**: A pending or claimed account invitation. Attributes: token,
  username, bucket, prefix, admin flag, expiry time, creation time, claiming
  user once used. Expires 48 hours after creation.

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: A user can go from clicking an invite link to browsing their
  files in under 2 minutes on first use.
- **SC-002**: Folder listing renders within 1 second for folders of up to 1000
  objects (S3's page size) on a typical connection.
- **SC-003**: A signed-in user can complete browse, upload, and share-link
  actions without any error on a happy path.
- **SC-004**: Share links generated with a given expiry behave correctly: they
  serve the file before expiry and refuse access after expiry, with no
  authentication required.
- **SC-005**: The Helm chart deploys the app to a Kubernetes cluster with
  default values plus required secrets in under 5 minutes.

## User Interface _(include only if the feature has a UI)_

- **Sign in**: Username entry and passkey prompt, with a link for invite
  registration. Wireframe: `wireframes/login.html`
- **Register with invite**: Claiming an invite link, choosing a username, and
  creating the passkey. Wireframe: `wireframes/register-invite.html`
- **File browser**: Folder/file listing for the signed-in user's space with
  breadcrumbs, load more, download, upload, share, and delete actions.
  Wireframe: `wireframes/files.html`
- **User management (admin)**: User and invite list with invite creation,
  re-send, cancel, and removal actions. Wireframe:
  `wireframes/admin-users.html`

## Assumptions

- The app talks to OVHcloud Object Storage over the S3-compatible API using a
  single credential set for the whole app; per-user configuration is bucket
  and prefix only.
- Search of file contents and names is out of scope; finding files is done by
  folder navigation.
- Share links are fire-and-forget: not stored, not listed, not revocable
  before expiry.
- Uploads are single-file; multi-file batch upload is out of scope.
- No application-imposed file size limit; the storage provider's limits apply.
- The deployment domain is `drive.grimes.id.au`; the WebAuthn relying party ID
  is that domain, with localhost supported for development.
- The browser is a modern evergreen browser (Chrome, Edge, Firefox, Safari)
  with platform passkey support; passkey management is delegated to the
  platform.
- The web UI is served by the backend (single container); the SPA is built
  and served statically by the API server in production.
