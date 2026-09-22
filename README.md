# Moonshot — private cloud workspace

This build preserves the supplied Moonshot interface and its planning, calendar, goals, focus timer, daily anchors, journal, weekly review, history, and JSON import/export features. It adds a private single-owner account and automatic PostgreSQL persistence.

## Deployment status

The application build and automated checks are complete. Import this repository into Vercel and configure the database before first use. Live cloud saving must be verified on the production deployment.

## Storage behavior

- Edits enter a persistent device outbox immediately and upload after 800 ms of inactivity. The interface says “Saved to cloud” only after the server confirms all outstanding writes.
- Each day, week, focus session, and settings record is stored separately. Older entries do not have to fit inside a single ever-growing request.
- An interrupted upload is retried with the same operation ID. A lost response cannot duplicate that operation.
- A record's revision must match before it can be replaced. Conflicting changes from another device are kept for download, and the user can then load the cloud version.
- One editing tab per browser is enforced with Web Locks. Separate devices synchronize approximately every 12 seconds while active. This is a personal workspace, not a collaborative editor.
- Earlier versions are retained at most once per changed record per hour. Records and snapshots have no automatic expiry or deletion job. Settings → Earlier versions downloads a complete recovery workspace using a selected historical record. Import it to restore.
- A device draft is kept during network failures. The app initially requires a connection and sign-in to load the private workspace. It is not an offline-installable PWA.
- Signing out revokes the session and removes this app's cloud cache only after pending saves finish. A legacy imported HTML app's browser storage is not deleted.
- Local drafts are not application-encrypted. Use a trusted browser profile. API routes require the owner's session; journal content is never embedded in public assets or source control.

No provider can promise storage literally forever. Retention depends on keeping the database and hosting accounts active and within their plan limits. Keep independent JSON exports. Hourly history in the same database is recovery from edits, not an independent disaster-recovery backup.

## Deploy to Vercel

1. Use this repository as the project source. Keep database credentials and personal exports out of Git.
2. Import that repository into a **new, separate** Vercel project. Use the Other framework preset. `vercel.json` specifies the build and output directory. Main is the production branch. Vercel Git integration will redeploy future pushes.
3. Provision a dedicated Neon PostgreSQL database through Vercel Marketplace and connect it to this project. Start with the free plan where available; review any billing commitment before accepting it. Do not point this app at another product's database.
4. Confirm `DATABASE_URL` is provided to the Production environment. If its automatically supplied name differs, map it to `DATABASE_URL`. Never place it in a public variable or repository.
5. Deploy. Database tables are created idempotently on the first API call. Missing storage configuration shows a blocking setup message; it never silently falls back to pretending that device-only storage is cloud storage.
6. The owner opens the production URL and creates a username and password, each at least 6 characters. The first account becomes the single owner; setup cannot replace an existing owner. Session tokens are random, stored only as hashes, and sent in HttpOnly/SameSite cookies (Secure on Vercel).
7. Create a temporary plan and reflection; wait for “Saved to cloud”; sign in in an independent browser session and verify both. Test edit, reload, sign-out, export/import, and production runtime logs. Keep preview environments on a separate database to avoid changing production journals.
8. Verify Git-triggered redeployment and confirm that the saved plan survives it before reporting the app live.

The original HTML's data is tied to its original browser origin. Hosting the file cannot retrieve that data automatically. In the original app, download a JSON backup, then import it through Settings in the deployed app. The supplied HTML itself contains no journal data.

## Development and tests

Requires Node 22.13+ (Node 22 LTS selected for Vercel).

```sh
npm ci
npm test
npm run build
```

Tests exercise the real SQL with isolated PGlite PostgreSQL, private API access, one-time username/password setup, password hashing, CSRF rejection, idempotent saves, revision conflicts, snapshot retrieval, limits, session revocation, reconnect recovery, edits during slow uploads, tombstones, quota failures, and original UI interactions in a DOM harness. The DOM harness is not a live browser/production verification.

Production dependencies: `@neondatabase/serverless`. Test-only dependencies: PGlite and jsdom. The client has no external scripts, trackers, or fonts. Database secrets stay in Vercel server functions.

## Files

- `public/`: preserved interface plus cloud sync, login, and recovery UI.
- `api/session.js`: one-time owner setup, sign-in, session status, sign-out.
- `api/workspace.js`: authenticated paginated reads and atomic conditional writes.
- `api/history.js`: authenticated historical versions.
- `lib/`: schema, password/session security, request validation.
- `tests/`: persistence and interface checks.
- `vercel.json`: deployment, security headers, build configuration.

## Recovery and operations

The database is the source of truth. Do not delete or recreate it to troubleshoot a deployment. If the owner forgets the Moonshot password, a project administrator can replace the owner's hash using `hashPassword` from `lib/security.js` in a secure maintenance session and revoke `moonshot_sessions`. Never make a public reset endpoint or reuse the deployment account password.

Each entry is limited to 1 MiB so it fits safely within serverless request/response limits. Split extremely long entries across days. The original app's field and import limits remain in place. Session cookies expire after 30 days; the interface provides reauthentication while preserving queued edits.
