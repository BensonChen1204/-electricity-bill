# Cloudflare sync v3: review and cutover checklist

This is a **source-only migration candidate**. The checked-in `cloud-config.js`
still points at the existing Supabase service. No existing Worker is changed.
The new Worker has no public route, an unconfigured database placeholder, and a
required authentication secret. Do not deploy or merge before the gates below.

## What changes

- Same six-room UI, calculations, bills, completed-month history and export.
- A separate `yilan-sync-v3` Worker and new D1 database, no Supabase dependency.
- One canonical schema-v2 JSON document; each successful revision is preserved
  by a SQLite trigger in the same atomic write. Concurrent writers use a SQL
  `WHERE revision = ?` compare-and-swap, not a check followed by an upsert.
- Unique mutation IDs make retries after a lost response idempotent. An ID
  reused with different content is rejected. Every read starts at the primary.
- Phones back up the original raw V1/V2 storage before migration. Differences
  without a known shared base require explicit reconciliation; pending local
  edits are not discarded on reload, focus, reconnect, or a 409 response.
- The app never creates an initial cloud state from the bundled example/default
  readings. An empty new server remains read-only until an operator seeds it.
- The service worker caches only approved same-origin app files, never API
  responses. Site deployment uploads only the app shell, not backend files.

## Local verification (Node 24+)

From `backend/`:

```sh
npm ci
npm run check
```

From the repo root:

```sh
node --test tests/*.test.cjs
```

All automated fixtures are synthetic. Workerd/Miniflare tests use only local D1.
`npm run build` is `wrangler deploy --dry-run`; it does not deploy. Types are
generated from the actual Wrangler config before checking, and are not checked
in. No login, API token, production PIN, or remote database is needed for tests.

## Required cutover gates

1. Retain a verified private backup of the latest canonical Supabase row AND its
   prior snapshots, with counts, source revision, timestamp and SHA256 checksums.
   Keep it outside the repository and the static hosting directory. An older
   cloud snapshot is not proof that both phones have no newer offline changes.
2. Make the phone safety update available before switching sync destinations.
   Each phone needs to open the updated app at least once for its automatic local
   backup to exist. Until then, do not claim that phone has been backed up. If a
   phone differs, preserve both versions and review the conflict before choosing.
3. Obtain approval for the auth setup. This candidate keeps the existing shared
   household password model, but does not retrieve, copy or create credentials.
   The user enters the existing family password directly into the new Worker's
   encrypted `YILAN_FAMILY_PIN` secret in the Cloudflare dashboard, through the
   approved secure user handoff. The assistant does not handle this entry. The
   Worker hashes both supplied and configured values in memory and compares them
   with the platform's timing-safe primitive.
   Never place the plaintext password or hash in Git, config, logs or chat.
   A strong household passphrase is recommended. In addition to a per-IP edge
   limiter, D1 atomically bounds failed/unverified attempts to ten per ten-minute
   window globally; valid requests release their reserved slot. After ten wrong
   guesses all devices must wait for the window to expire. A malicious party can
   cause this temporary lockout, so a short PIN still has security/usability limits.
4. Create a **new** D1 database and put its confirmed ID in `backend/wrangler.jsonc`.
   Confirm its name is `yilan-sync-v3`. Apply only `backend/migrations/0001_state.sql`.
   Leave `electricity-bill-api`, its configuration, and Supabase untouched.
5. Validate the verified baseline without normalization using the offline script:

   ```sh
   node scripts/prepare-baseline.mjs PRIVATE_PAYLOAD.json PRIVATE_OUTPUT.seed.sql VERIFIED_SOURCE SOURCE_REVISION
   ```

   The accepted input is a bare schema-v2 payload, app export `{state:...}`, or
   cloud row `{payload:...}`. The generated SQL contains private data. It is
   excluded by `.gitignore`, created mode 0600 without overwrite, and must stay
   outside any hosting artifact. The script only prepares a file. It does not
   upload it. Apply it to the approved new D1 database only after verifying the
   destination. One INSERT atomically creates state revision 1, the immutable
   initial snapshot, and the source receipt. Re-running it fails, never replaces.
6. Read back the entire stored payload and compare it semantically to the source;
   verify all six rooms, current month, full history, source revision and receipt
   hash. The D1 revision starts at 1 independently of the old Supabase revision.
   Keep the full old state-history export as a separate private archive. The
   seed carries the current JSON's completed-month history, not old sync versions.
7. Configure a dedicated approved public Worker endpoint and matching exact
   `ALLOWED_ORIGIN`, then test authenticated reads, invalid PIN, preflight,
   two-device CAS, retries, conflict resolution, offline edit/reload/reconnect,
   reload of the PWA, and backup export. Do not put authentication in URLs.
8. Only after approval switch the public frontend config to
   `{ protocol: 'worker-v1', functionUrl: 'https://CONFIRMED_HOST/v1/state' }`.
   No anon key is needed. Publish the reviewed UI with the new service-worker
   version. Verify both phones, not only a desktop simulation.
9. During the migration window, avoid edits on an old cached client. An old
   Supabase client can still write the old backend; a current backup must be
   rechecked immediately before cutover. Do not automatically dual-write.

## Rollback and operations

- Keep old services and exports until the two phones pass acceptance. Never
  delete old systems as part of this migration.
- A UI rollback may keep the new API endpoint if compatibility is verified.
  Switching the endpoint back to Supabase after new writes would fork the data:
  export and reconcile the new D1 state first; never blindly restore an old seed.
- Keep periodic private D1 exports and monitor storage use. Revision snapshots
  intentionally do not have an automatic deletion policy. They are not a substitute
  for independent backup. Cloudflare D1 Time Travel has plan-dependent retention.
- Requests are capped at 512 KiB including the write envelope; backups approaching
  that size require a reviewed limit/schema change before cutover.
- Authentication is a shared secret, not per-person accounts or revocable device
  sessions. Local storage retains the current app's credential behavior. Changing
  that model requires separate approval and a phone migration plan.

References: [D1 transactions and sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[rate-limit semantics](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
[Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
