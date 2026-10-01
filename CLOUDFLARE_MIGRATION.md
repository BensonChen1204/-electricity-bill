# Cloudflare sync v3: review and cutover checklist

The new isolated Worker and D1 are provisioned. The owner has completed the
private-link connection check. This release switches the frontend to the new
endpoint `https://yilan-sync-v3.neihu0122.workers.dev/v1/state` using capability
access. The old Worker and Supabase remain untouched for rollback. Never share
an actual private link in this repository. The tests below cover only synthetic
capabilities; final acceptance includes the real family phones.

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
in. No login, real capability, production secret, or remote database is needed for tests.

## Required cutover gates

1. Retain a verified private backup of the latest canonical Supabase row AND its
   prior snapshots, with counts, source revision, timestamp and SHA256 checksums.
   Keep it outside the repository and the static hosting directory. An older
   cloud snapshot is not proof that both phones have no newer offline changes.
2. Make the phone safety update available before switching sync destinations.
   Each phone needs to open the updated app at least once for its automatic local
   backup to exist. Until then, do not claim that phone has been backed up. If a
   phone differs, preserve both versions and review the conflict before choosing.
3. Household access uses a high-entropy private link, not a password or account.
   The owner opens `https://yilan-sync-v3.neihu0122.workers.dev/setup` in their own
   browser and personally clicks the generation button. Web Crypto generates
   32 random bytes locally. The owner copies the computed SHA256 verifier into
   the encrypted Cloudflare Secret `YILAN_ACCESS_TOKEN_SHA256`, saves/deploys it,
   and returns to click the connection check. The assistant must not generate,
   inspect, copy, enter, or share the actual token, verifier, or private link.
   Only the owner shares the resulting app link with authorized family members.
   A synthetic test capability must never be configured in production.

   The link contains `#yilan-access=...`, not a query parameter. Fragments are
   consumed and scrubbed by the client; the token is stored per API endpoint and
   sent only in the Authorization header to the configured HTTPS API. Browser
   backups do not contain it. The setup page has no third-party scripts or
   analytics, a restrictive CSP, no-referrer policy, and no household data in its
   HTML. Its connection check performs an authenticated read with the user-owned
   capability, without the assistant knowing the credential.

   Anyone holding the link has read/write access to this household. Keep it out
   of public messages, screenshots, Git, logs, and assistant chat. The owner must
   preserve it before closing the setup tab; it cannot be recovered from the
   server. Rotating the configured hash revokes every old link immediately;
   family devices need the new link. Disconnecting one browser only removes
   its local copy and does not revoke copies elsewhere. The 60/minute per-IP
   limiter is supplemental protection, not a substitute for token entropy.
   The former PIN budget table is retained unused, avoiding anonymous guesses
   globally locking out authorized family members.
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
   `ALLOWED_ORIGIN`, then test authenticated reads, invalid capabilities, preflight,
   two-device CAS, retries, conflict resolution, offline edit/reload/reconnect,
   reload of the PWA, and backup export. Do not put authentication in URLs.
8. Only after approval switch the public frontend config to
   `{ protocol: 'worker-v1', authMode: 'capability-v1', functionUrl: 'https://CONFIRMED_HOST/v1/state' }`.
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
- Authentication is a shared capability, not per-person accounts or revocable
  device sessions. Someone with access to an authorized browser's storage can
  retrieve the token. Use normal device locks and share only with trusted family.
- The owner must finish the setup page's authenticated check before frontend
  cutover. Automated local/CI checks use synthetic capabilities only. After
  publication, verify both phones and their local backup/conflict behavior.

References: [D1 transactions and sessions](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[rate-limit semantics](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/),
[Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
