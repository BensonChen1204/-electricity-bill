// Offline only: validate a private backup and emit a one-time seed SQL file.
// Does not contact Cloudflare, deploy, or print the state. Run with Node 24+.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validPayload, MAX_BODY_BYTES } from '../src/schema.ts';

export function prepareBaseline(raw, { source, sourceRevision = null, now = new Date().toISOString() }) {
  if (!source || source.length > 200 || /[\r\n]/.test(source)) throw new Error('A short verified source description is required');
  if (sourceRevision !== null && (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1)) throw new Error('Invalid source revision');
  const parsed = JSON.parse(raw);
  const payload = parsed.state ?? parsed.payload ?? parsed;
  if (!validPayload(payload)) throw new Error('Backup schema is incompatible; stop and review without normalization');
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) > MAX_BODY_BYTES - 4096) throw new Error('Backup is too large for configured API limit');
  const sha = createHash('sha256').update(raw).digest('hex');
  const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
  // The guard makes accidental re-runs or an already populated DB fail loudly.
  // One INSERT also creates the snapshot and provenance via a trigger, so
  // partial imports cannot mark the baseline as backed up. No OR REPLACE.
  const sql = `-- PRIVATE: contains household data; never commit this generated file.\n`
    + `INSERT INTO app_state (id,revision,payload,updated_at,actor,mutation_id,request_hash,seed_source,seed_sha256,seed_source_revision)\n`
    + `VALUES ('main',1,${quote(json)},${quote(now)},'verified-baseline',${quote('baseline-' + sha)},${quote(sha)},${quote(source)},${quote(sha)},${sourceRevision ?? 'NULL'});\n`;
  return { sql, receipt: { sha256: sha, source, sourceRevision, month: payload.month, rooms: payload.rooms.length, history: payload.history.length } };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const [input, output, source, revision] = process.argv.slice(2);
  if (!input || !output?.endsWith('.seed.sql') || !source) {
    console.error('Usage: node scripts/prepare-baseline.mjs PRIVATE_BACKUP.json PRIVATE_OUTPUT.seed.sql VERIFIED_SOURCE [SOURCE_REVISION]');
    process.exitCode = 1;
  } else {
    try {
      const result = prepareBaseline(await readFile(input, 'utf8'), { source, sourceRevision: revision ? Number(revision) : null });
      await writeFile(output, result.sql, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ prepared: true, ...result.receipt }));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
