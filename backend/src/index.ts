import { MAX_BODY_BYTES, validWrite } from './schema.ts';

type StateRow = { revision: number; payload: string; updated_at: string; actor: string; mutation_id: string; request_hash: string };
class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
async function digest(value: string) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); }

async function readBody(request: Request): Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'json_required');
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large');
  if (!request.body) throw new HttpError(400, 'invalid_json');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, 'payload_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new HttpError(400, 'invalid_json'); }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('origin');
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, private', 'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff',
    });
    if (origin === env.ALLOWED_ORIGIN) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Headers', 'content-type,x-family-pin');
      headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      headers.set('Access-Control-Max-Age', '600');
    }
    const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    try {
      if (origin && origin !== env.ALLOWED_ORIGIN) return reply({ error: 'origin_not_allowed' }, 403);
      const url = new URL(request.url);
      if (url.pathname !== '/v1/state' || url.search) return reply({ error: 'not_found' }, 404);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
      if (!['GET', 'POST'].includes(request.method)) return reply({ error: 'method_not_allowed' }, 405);
      const configuredPin = env.YILAN_FAMILY_PIN;
      if (!configuredPin || configuredPin.length > 256 || !env.AUTH_LIMITER) return reply({ error: 'auth_not_configured' }, 503);
      // Edge IP throttling plus an atomic global failed-attempt budget below.
      // Neither replaces a strong approved household passphrase. Never log it.
      const limit = await env.AUTH_LIMITER.limit({ key: 'auth:' + (request.headers.get('CF-Connecting-IP') || 'unknown') });
      if (!limit.success) { headers.set('Retry-After', '60'); return reply({ error: 'rate_limited' }, 429); }
      const pin = request.headers.get('x-family-pin') || '';
      if (!pin || pin.length > 256) return reply({ error: 'unauthorized' }, 401);
      // Start at the primary even if read replication is enabled later.
      const db = env.DB.withSession('first-primary');
      // Reserve one slot BEFORE testing the PIN, so parallel guesses or many IPs
      // cannot bypass the limit. Valid logins release their slot; failures keep
      // it for this ten-minute window. At most ten unverified attempts can be in
      // flight globally. A crashed request may consume a slot until expiry.
      const windowStart = Math.floor(Date.now() / 600000) * 600;
      const reserved = await db.prepare(`INSERT INTO auth_budget (id,window_start,attempts)
        VALUES ('family',(CAST(strftime('%s','now') AS INTEGER)/600)*600,1)
        ON CONFLICT(id) DO UPDATE SET
        attempts = CASE WHEN window_start < excluded.window_start THEN 1 ELSE attempts + 1 END,
        window_start = excluded.window_start
        WHERE window_start < excluded.window_start OR (window_start = excluded.window_start AND attempts < 10)
        RETURNING attempts,window_start`).first<{ attempts: number; window_start: number }>();
      if (!reserved) {
        headers.set('Retry-After', String(Math.max(1,windowStart + 600 - Math.floor(Date.now()/1000))));
        return reply({ error: 'rate_limited' }, 429);
      }
      const [supplied,expected] = await Promise.all([digest(pin),digest(configuredPin)]);
      if (!crypto.subtle.timingSafeEqual(supplied,expected)) return reply({ error: 'unauthorized' }, 401);
      await db.prepare("UPDATE auth_budget SET attempts = MAX(0,attempts-1) WHERE id='family' AND window_start=?").bind(reserved.window_start).run();
      if (request.method === 'GET') {
        const row = await db.prepare("SELECT * FROM app_state WHERE id = 'main'").first<StateRow>();
        return reply(row ? { ok: true, exists: true, revision: row.revision, payload: JSON.parse(row.payload), updated_at: row.updated_at }
          : { ok: true, exists: false, revision: 0, baseline_required: true });
      }
      const body = await readBody(request);
      if (!validWrite(body)) return reply({ error: 'invalid_payload' }, 400);
      const serialized = JSON.stringify(body.payload);
      const requestHash = hex(await digest(JSON.stringify([body.expected_revision, body.actor, serialized])));
      const replay = async () => db.prepare('SELECT * FROM state_versions WHERE mutation_id = ?').bind(body.mutation_id).first<StateRow>();
      const replayResponse = (row: StateRow) => row.request_hash === requestHash
        ? reply({ ok: true, revision: row.revision, updated_at: row.updated_at, mutation_id: body.mutation_id, replayed: true })
        : reply({ error: 'mutation_id_reused' }, 409);
      const previous = await replay();
      if (previous) return replayResponse(previous);
      const updatedAt = new Date().toISOString();
      // Atomic compare-and-swap, including its history trigger. Never SELECT
      // then unconditionally UPDATE/UPSERT. Duplicate retries cannot reapply.
      const row = await db.prepare(`UPDATE app_state SET payload = ?, revision = revision + 1,
        updated_at = ?, actor = ?, mutation_id = ?, request_hash = ?
        WHERE id = 'main' AND revision = ?
        AND NOT EXISTS (SELECT 1 FROM state_versions WHERE mutation_id = ?)
        RETURNING revision, updated_at`)
        .bind(serialized, updatedAt, body.actor, body.mutation_id, requestHash, body.expected_revision, body.mutation_id)
        .first<{ revision: number; updated_at: string }>();
      if (row) return reply({ ok: true, ...row, mutation_id: body.mutation_id });
      const concurrentReplay = await replay();
      if (concurrentReplay) return replayResponse(concurrentReplay);
      const current = await db.prepare("SELECT revision FROM app_state WHERE id = 'main'").first<{ revision: number }>();
      return current ? reply({ error: 'revision_conflict', revision: current.revision }, 409)
        : reply({ error: 'baseline_required' }, 428);
    } catch (error) {
      if (error instanceof HttpError) return reply({ error: error.message }, error.status);
      // DB exceptions can contain SQL/data. Report only an opaque incident ID.
      const incident = crypto.randomUUID();
      console.error(JSON.stringify({ event: 'sync_request_failed', incident }));
      return reply({ error: 'temporarily_unavailable', incident }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
