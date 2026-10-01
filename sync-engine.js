/* Local-first sync. Transport reads NEVER acknowledge a revision. No credentials
 * are included in backups, drafts, or endpoint-scoped acknowledged metadata. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YilanSync = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const STATE_KEY = 'yilanUtilityV2';
  const LEGACY_KEY = 'yilanUtilityV1';
  const BACKUP_PREFIX = 'yilanSyncBackup:';
  const INITIAL_BACKUP_KEY = BACKUP_PREFIX + 'initial:v1';
  const DRAFT_PREFIX = 'yilanSyncDraft:';
  const clone = value => JSON.parse(JSON.stringify(value));
  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }
  const same = (a, b) => canonical(a) === canonical(b);
  function verifiedSet(storage, key, value) {
    const raw = JSON.stringify(value);
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error('backup_verification_failed');
  }
  function rawState(storage) {
    return { [STATE_KEY]: storage.getItem(STATE_KEY), [LEGACY_KEY]: storage.getItem(LEGACY_KEY) };
  }
  // Call before reading, parsing, normalizing, or migrating application data.
  function captureInitialBackup(storage, now = () => new Date().toISOString()) {
    const existing = storage.getItem(INITIAL_BACKUP_KEY);
    if (existing !== null) {
      const parsed = JSON.parse(existing);
      if (!parsed || parsed.version !== 1 || !parsed.raw || !Object.hasOwn(parsed.raw, STATE_KEY) || !Object.hasOwn(parsed.raw, LEGACY_KEY)) throw new Error('invalid_initial_backup');
      return parsed;
    }
    const backup = { version: 1, reason: 'before-first-normalization', createdAt: now(), raw: rawState(storage) };
    verifiedSet(storage, INITIAL_BACKUP_KEY, backup);
    return backup;
  }
  function exportRecovery(storage) {
    const records = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && (key.startsWith(BACKUP_PREFIX) || key.startsWith(DRAFT_PREFIX))) records.push({ key, raw: storage.getItem(key) });
    }
    return { version: 1, exportedAt: new Date().toISOString(), currentRaw: rawState(storage), records };
  }
  function create(options) {
    const { storage, transport, onApply = () => {}, onStatus = () => {}, normalize = clone } = options;
    const now = options.now || (() => new Date().toISOString());
    let serial = 0;
    const uuid = options.uuid || (() => (globalThis.crypto?.randomUUID?.() || Date.now() + '-' + Math.random().toString(36).slice(2)));
    const endpoint = transport.endpoint || 'unconfigured';
    const metaKey = 'yilanSyncMeta:v1:' + encodeURIComponent(endpoint);
    const draftKey = DRAFT_PREFIX + (options.tabId || uuid());
    let local = clone(options.initialState);
    let observedRaw = storage.getItem(STATE_KEY);
    // Baked-in defaults are not user records. Only a genuinely pristine device
    // may adopt its first authenticated cloud snapshot without a conflict choice.
    let hasUserData = observedRaw !== null || storage.getItem(LEGACY_KEY) !== null;
    let generation = 0, conflict = null, blocked = null, currentStatus = { mode: 'local' };
    let ack = null, attempt = null, running = null, rerun = false, timer = null, session = 0;
    let knownMetaRaw = storage.getItem(metaKey);
    try {
      captureInitialBackup(storage, now);
      const meta = knownMetaRaw && JSON.parse(knownMetaRaw);
      if (meta?.version === 1 && meta.endpoint === endpoint && Number.isSafeInteger(meta.ack?.revision) && meta.ack.revision > 0 && meta.ack.payload) {
        ack = { ...meta.ack, payload: normalize(clone(meta.ack.payload)) };
        attempt = meta.attempt || null;
      }
    } catch (_) { blocked = 'backup_error'; }
    function emit(mode, extra = {}) {
      currentStatus = { mode, dirty: !ack || !same(local, ack.payload), conflict: conflict ? clone(conflict) : null, ...extra };
      onStatus(currentStatus);
      return currentStatus;
    }
    function backup(reason, remote) {
      const key = BACKUP_PREFIX + now().replace(/[^0-9TZ]/g, '') + ':' + uuid() + ':' + (++serial);
      verifiedSet(storage, key, { version: 1, createdAt: now(), reason, raw: rawState(storage), local: clone(local), remote: remote ? clone(remote) : null });
      return key;
    }
    function protectedBackup(reason, remote) {
      try { return backup(reason, remote); }
      catch (_) { blocked = 'backup_error'; emit('backup_error'); return null; }
    }
    function persistenceFailure(error) {
      blocked = 'storage_error';
      emit('storage_error');
      error.persistenceFailure = true;
      throw error;
    }
    function saveMeta() {
      try {
        // Never adopt another tab's base for this tab's dirty payload.
        const storedRaw = storage.getItem(metaKey);
        let stored;
        try { stored = storedRaw && JSON.parse(storedRaw); } catch (_) {}
        if (stored?.ack?.revision > (ack?.revision || 0)) return;
        verifiedSet(storage, metaKey, { version: 1, endpoint, ack, attempt });
        knownMetaRaw = storage.getItem(metaKey);
      } catch (error) { persistenceFailure(error); }
    }
    function rememberDraft() {
      try { verifiedSet(storage, draftKey, { version: 1, endpoint, createdAt: now(), payload: clone(local), base: ack ? clone(ack) : null }); }
      catch (error) { persistenceFailure(error); }
    }
    function clearDraftIfClean() {
      try { if (ack && same(local, ack.payload)) storage.removeItem(draftKey); }
      catch (error) { persistenceFailure(error); }
    }
    function acknowledge(remote) {
      ack = { revision: remote.revision, payload: normalize(clone(remote.payload)), updatedAt: remote.updated_at || null };
      attempt = null;
      saveMeta();
      if (!same(local, ack.payload)) rememberDraft();
      else clearDraftIfClean();
    }
    function localChangedElsewhere() { return storage.getItem(STATE_KEY) !== observedRaw; }
    function flagLocalConflict() {
      const raw = storage.getItem(STATE_KEY);
      if (conflict?.kind === 'other-tab' && conflict.remote.raw === raw && same(conflict.local, local)) { emit('conflict'); return; }
      let payload = null;
      try { payload = raw ? normalize(JSON.parse(raw)) : null; } catch (_) {}
      const remote = { exists: !!payload, payload, raw, revision: null };
      if (!protectedBackup('other-tab-conflict', remote)) return;
      conflict = { kind: 'other-tab', remote, local: clone(local) };
      emit('conflict');
    }
    // A reloaded tab may own an unsent draft that another tab replaced in V2.
    try {
      const recoverKey = options.recoveryDraftId ? DRAFT_PREFIX + options.recoveryDraftId : draftKey;
      const draft = JSON.parse(storage.getItem(recoverKey) || 'null');
      if (draft?.version === 1 && draft.endpoint === endpoint && draft.payload) {
        hasUserData = true;
        // A newer global acknowledgment belongs to another tab, not this draft.
        ack = draft.base ? clone(draft.base) : null;
        if (!same(normalize(clone(draft.payload)), local)) {
          local = normalize(clone(draft.payload));
          onApply(clone(local));
          flagLocalConflict();
        }
        rememberDraft();
      }
    } catch (_) { blocked = 'backup_error'; }
    function saveLocal(value) {
      if (blocked) { emit(blocked); return false; }
      hasUserData = true;
      local = clone(value);
      generation++;
      try { rememberDraft(); }
      catch (_) { blocked = 'storage_error'; emit('storage_error'); return false; }
      if (localChangedElsewhere() || conflict?.kind === 'other-tab') { flagLocalConflict(); return false; }
      try {
        const raw = JSON.stringify(local);
        storage.setItem(STATE_KEY, raw);
        if (storage.getItem(STATE_KEY) !== raw) { flagLocalConflict(); return false; }
        observedRaw = raw;
        if (conflict) { conflict.local = clone(local); emit('conflict'); }
        else { emit('pending'); schedule(); }
        return true;
      } catch (_) { blocked = 'storage_error'; emit('storage_error'); return false; }
    }
    function ensureRemote(out) {
      if (!out || typeof out.exists !== 'boolean') throw new Error('invalid_remote');
      if (!out.exists) return { exists: false };
      if (!Number.isSafeInteger(out.revision) || out.revision < 1 || !out.payload || !Array.isArray(out.payload.rooms) || !out.payload.rooms.length) throw new Error('invalid_remote');
      return { ...out, rawPayload: clone(out.payload), payload: normalize(clone(out.payload)) };
    }
    function setConflict(remote, reason = 'both-changed') {
      if (!protectedBackup('cloud-conflict:' + reason, remote)) return;
      conflict = { kind: 'cloud', remote: clone(remote), local: clone(local), reason };
      emit('conflict');
    }
    function applyRemote(remote) {
      if (options.canApplyRemote && !options.canApplyRemote()) { emit('editing'); return false; }
      if (localChangedElsewhere()) { flagLocalConflict(); return false; }
      if (!protectedBackup('before-cloud-apply', remote)) return false;
      const raw = JSON.stringify(remote.payload);
      try {
        storage.setItem(STATE_KEY, raw);
        if (storage.getItem(STATE_KEY) !== raw) { flagLocalConflict(); return false; }
      } catch (error) { persistenceFailure(error); }
      observedRaw = raw;
      local = clone(remote.payload);
      hasUserData = true;
      generation++;
      // V2 and the visible model must agree even if a later metadata write fails.
      // Any persistence failure is terminal until reload, including partial commits.
      try { onApply(clone(local)); } catch (error) { persistenceFailure(error); }
      acknowledge(remote);
      conflict = null;
      emit('synced');
      return true;
    }
    async function syncOnce(token, decision) {
      if (blocked) return emit(blocked);
      const credential = transport.getCredential ? transport.getCredential() : transport.getPin?.();
      if (!transport.enabled() || !credential) return emit('local');
      if (localChangedElsewhere()) { flagLocalConflict(); return; }
      if (conflict?.kind === 'other-tab') return emit('conflict');
      emit('syncing');
      const remote = ensureRemote(await transport.load());
      if (token !== session) return;
      if (localChangedElsewhere()) { flagLocalConflict(); return; }
      if (!remote.exists) { conflict = null; return emit('needs-baseline'); }
      if (decision) {
        if (decision.generation !== generation || !same(decision.remote, remote)) { setConflict(remote, 'changed-during-choice'); return; }
        if (!protectedBackup('explicit-' + decision.choice, remote)) return;
        if (decision.choice === 'remote') { applyRemote(remote); return; }
        // Explicit keep-local acknowledges the inspected remote as the CAS base.
        acknowledge(remote);
        conflict = null;
      } else if (conflict) {
        if (same(local, remote.payload)) { acknowledge(remote); conflict = null; return emit('synced'); }
        if (!same(conflict.remote, remote)) setConflict(remote, 'remote-updated');
        else emit('conflict');
        return;
      }
      if (ack && remote.revision < ack.revision) { setConflict(remote, 'revision-regressed'); return; }
      if (same(local, remote.payload)) { acknowledge(remote); return emit('synced'); }
      if (!ack) {
        if (!hasUserData) applyRemote(remote);
        else setConflict(remote, 'unknown-base');
        return;
      }
      if (same(local, ack.payload)) { applyRemote(remote); return; }
      if (!same(remote.payload, ack.payload)) { setConflict(remote); return; }
      const outgoing = clone(local), outgoingGeneration = generation;
      // Record the exact request before sending, so an uncertain retry reuses it.
      if (!attempt || attempt.expectedRevision !== remote.revision || !same(attempt.payload, outgoing)) {
        attempt = { expectedRevision: remote.revision, payload: outgoing, mutationId: uuid() };
      }
      saveMeta();
      const out = await transport.save(outgoing, remote.revision, attempt.mutationId);
      if (token !== session) return;
      if (!out || !Number.isSafeInteger(out.revision) || out.revision <= remote.revision) throw new Error('invalid_save_response');
      acknowledge({ revision: out.revision, payload: outgoing, updated_at: out.updated_at });
      if (localChangedElsewhere()) { flagLocalConflict(); return; }
      if (outgoingGeneration !== generation || !same(local, outgoing)) { rerun = true; emit('pending'); }
      else emit('synced');
    }
    function run(decision) {
      clearTimeout(timer);
      if (running) { rerun = true; return running; }
      const token = session;
      running = (async () => {
        do {
          rerun = false;
          try {
            const work = () => syncOnce(token, decision);
            if (options.withLock) await options.withLock('yilan-sync:' + endpoint, work);
            else await work();
          } catch (error) {
            if (token !== session) break;
            if (error.persistenceFailure) { blocked = 'storage_error'; emit('storage_error'); }
            else if (error.status === 409) {
              // Re-read solely to show both versions. Never apply on conflict.
              try {
                const remote = ensureRemote(await transport.load());
                if (token === session && remote.exists) setConflict(remote, 'revision-conflict');
                else if (token === session) emit('needs-baseline');
              } catch (_) { emit('offline', { error: 'conflict_refresh_failed' }); }
            } else emit(error.status === 401 || error.status === 403 ? 'unauthorized' : error.status === 400 || error.status === 422 ? 'invalid-data' : error.status === 413 ? 'payload-too-large' : error.status === 429 ? 'rate-limited' : 'offline', { error: error.message });
          }
          decision = null;
        } while (rerun && !conflict && !blocked && token === session);
      })().finally(() => { running = null; });
      return running;
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => run(), options.debounceMs ?? 700);
    }
    async function resolve(choice) {
      if (blocked || !conflict || !['local', 'remote'].includes(choice)) return false;
      if (running) { await running; if (!conflict) return false; }
      if (conflict.kind === 'other-tab') {
        if (storage.getItem(STATE_KEY) !== conflict.remote.raw) { flagLocalConflict(); return false; }
        if (!protectedBackup('explicit-other-tab-' + choice, conflict.remote)) return false;
        if (choice === 'remote') {
          if (!conflict.remote.payload) return false;
          local = clone(conflict.remote.payload);
          onApply(clone(local));
        }
        observedRaw = storage.getItem(STATE_KEY);
        conflict = null;
        generation++;
        // Choosing another tab's local state still needs its own remote check.
        saveLocal(local);
        return run();
      }
      return run({ choice, remote: clone(conflict.remote), generation });
    }
    function observeStorage(event) {
      if (event.key === STATE_KEY || event.key === null) {
        if (localChangedElsewhere()) flagLocalConflict();
      }
      // Deliberately do not replace this tab's acknowledged base on meta events.
    }
    function disconnect() {
      session++;
      rerun = false;
      clearTimeout(timer);
      emit('local');
    }
    return {
      saveLocal, sync: run, schedule, resolve, observeStorage, disconnect,
      status: () => currentStatus,
      snapshot: () => clone(local),
      metadata: () => ({ ack: ack && clone(ack), attempt: attempt && clone(attempt) }),
      backup: (reason, remote) => protectedBackup(reason, remote),
      exportRecovery: () => exportRecovery(storage),
      dispose: () => { disconnect(); },
      keys: { metaKey, draftKey }
    };
  }
  return { create, captureInitialBackup, exportRecovery, canonical, STATE_KEY, LEGACY_KEY, INITIAL_BACKUP_KEY };
});
