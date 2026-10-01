// Transport only: a GET must never advance the acknowledged local base.
// Keep cloud-config.js unchanged until an operator verifies and switches endpoints.
(function (root, factory) {
  const create = factory();
  if (typeof module === 'object' && module.exports) module.exports = create;
  if (root) root.YilanCloud = create(root.YILAN_CLOUD_CONFIG || {}, root.localStorage, root.fetch.bind(root), root.crypto);
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  return function create(config, storage, fetcher, cryptoApi) {
    const KEY_PIN = 'yilanFamilyPin';
    const KEY_DEVICE = 'yilanDeviceId';
    const protocol = config.protocol || 'supabase-legacy';
    const worker = protocol === 'worker-v1';
    let parsedUrl;
    try { parsedUrl = new URL(config.functionUrl); } catch (_) {}
    // Credentials and fragments must not become part of metadata or a backup.
    const safeUrl = parsedUrl && !parsedUrl.username && !parsedUrl.password && !parsedUrl.search && !parsedUrl.hash && (parsedUrl.protocol === 'https:' || (parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)));
    const enabled = () => Boolean(safeUrl && ((worker) || (protocol === 'supabase-legacy' && config.anonKey)));
    const endpoint = safeUrl ? protocol + ':' + parsedUrl.href : 'unconfigured';
    function deviceId() {
      let id = storage.getItem(KEY_DEVICE);
      if (!id) { id = 'device-' + cryptoApi.randomUUID(); storage.setItem(KEY_DEVICE, id); }
      return id;
    }
    function getPin() { return storage.getItem(KEY_PIN) || ''; }
    function setPin(pin) {
      const clean = String(pin || '').trim();
      if (clean) storage.setItem(KEY_PIN, clean);
      else storage.removeItem(KEY_PIN);
    }
    async function request(method, body) {
      if (!enabled()) throw new Error('cloud_not_configured');
      const pin = getPin();
      if (!pin) throw new Error('pin_required');
      const headers = { 'Content-Type': 'application/json', 'x-family-pin': pin };
      if (!worker) headers.apikey = config.anonKey;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const r = await fetcher(parsedUrl.href, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal });
        const out = await r.json().catch(() => ({}));
        if (!r.ok) { const error = new Error(out.error || ('http_' + r.status)); error.status = r.status; error.body = out; throw error; }
        return out;
      } finally { clearTimeout(timeout); }
    }
    const load = () => request('GET');
    async function save(payload, expectedRevision, mutationId) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('verified_baseline_required');
      if (!mutationId) throw new Error('mutation_id_required');
      return request('POST', { payload, expected_revision: expectedRevision, actor: deviceId(), mutation_id: mutationId });
    }
    return { enabled, endpoint, protocol, atomic: worker, deviceId, getPin, setPin, load, save };
  };
});
