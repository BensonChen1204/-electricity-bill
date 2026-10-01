# v2.2 Cloud Sync

Historical Supabase architecture. The new Worker/D1 candidate and current safety
gates are documented in [CLOUDFLARE_MIGRATION.md](CLOUDFLARE_MIGRATION.md).
The old Edge Function's separate read/upsert does not guarantee atomic multi-device
writes; do not treat its revision check as equivalent to the new D1 CAS.

Goal: make the same rental-account state available from Benson's phone, his mother's phone, and ChatGPT-assisted administration.

## Architecture

- Frontend remains GitHub Pages / PWA.
- Supabase stores one canonical JSON state plus append-only history snapshots.
- Browser never gets the service-role key.
- A Supabase Edge Function validates a shared family PIN before reading/writing.
- Browser keeps a local cache for offline use.
- Cloud writes are revision-checked to avoid silently overwriting another device.
- ChatGPT can administer the same database directly through the connected Supabase integration.

## Access model

For the first production version, use one family PIN. It is entered once per device and stored locally on that device.

This is intentionally simpler than email/password for a two-person family workflow while still keeping the database itself closed to anonymous direct access.

## Deployment sequence

1. Create Supabase project.
2. Apply `supabase-schema.sql`.
3. Deploy `supabase/functions/yilan-state/index.ts`.
4. Set Edge Function secret `YILAN_FAMILY_PIN_SHA256`.
5. Fill `cloud-config.js` with project Function URL and public anon key.
6. Wire `cloud-sync.js` into `index.html`.
7. Run live two-device simulation and conflict tests.
8. Merge to main only after E2E passes.
