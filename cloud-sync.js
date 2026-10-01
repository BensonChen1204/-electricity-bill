// Transport only: a GET must never advance the acknowledged local base.
// Keep cloud-config.js unchanged until an operator verifies and switches endpoints.
(function (root, factory) {
  const create = factory();
  if (typeof module === 'object' && module.exports) module.exports = create;
  if (root) {
    root.YilanCloud = create(root.YILAN_CLOUD_CONFIG || {}, root.localStorage, root.fetch.bind(root), root.crypto, { location: root.location, history: root.history });
    root.addEventListener('hashchange', () => {
      if (root.YilanCloud.consumeAccessLink()) root.dispatchEvent(new root.Event('yilan-credential-change'));
    });
  }
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';
  const ACCESS_PATTERN = /^[A-Za-z0-9_-]{43}$/;
  return function create(config, storage, fetcher, cryptoApi, browser = {}) {
    const KEY_PIN = 'yilanFamilyPin';
    const KEY_DEVICE = 'yilanDeviceId';
    const protocol = config.protocol || 'supabase-legacy';
    const worker = protocol === 'worker-v1';
    const capability = worker && config.authMode === 'capability-v1';
    const legacy = protocol === 'supabase-legacy' && (!config.authMode || config.authMode === 'legacy-pin');
    const authMode = capability ? 'capability-v1' : legacy ? 'legacy-pin' : 'unconfigured';
    let parsedUrl, authIssue = '';
    try { parsedUrl = new URL(config.functionUrl); } catch (_) {}
    // The endpoint comes only from the deployed config, never from the link.
    // Credentials, query parameters, and fragments cannot enter sync metadata.
    const safeUrl = parsedUrl && !parsedUrl.username && !parsedUrl.password && !parsedUrl.search && !parsedUrl.hash && (parsedUrl.protocol === 'https:' || (!capability && parsedUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsedUrl.hostname)));
    const enabled = () => Boolean(safeUrl && (capability || (legacy && config.anonKey)));
    const endpoint = safeUrl ? protocol + ':' + parsedUrl.href : 'unconfigured';
    const accessKey = 'yilanAccessToken:v1:' + encodeURIComponent(endpoint);

    // Remove even malformed/private-link fragments on legacy or invalid config.
    // Only a configured HTTPS capability endpoint may consume or retain the token.
    function consumeAccessLink() {
      const hash = String(browser.location?.hash || '');
      if (!/^#yilan-access(?:=|$)/.test(hash)) return false;
      authIssue = '';
      try {
        browser.history.replaceState(browser.history.state, '', browser.location.pathname + browser.location.search);
      } catch (_) { authIssue = 'access_link_scrub_failed'; }
      if (!authIssue && capability && enabled()) {
        const token = hash.slice('#yilan-access='.length);
        if (!ACCESS_PATTERN.test(token)) authIssue = 'invalid_access_link';
        else {
          try {
            storage.setItem(accessKey, token);
            if (storage.getItem(accessKey) !== token) throw new Error('credential_storage_failed');
          } catch (_) { authIssue = 'access_storage_error'; }
        }
      }
      return true;
    }
    consumeAccessLink();
    function deviceId() {
      let id = storage.getItem(KEY_DEVICE);
      if (!id) { id = 'device-' + cryptoApi.randomUUID(); storage.setItem(KEY_DEVICE, id); }
      return id;
    }
    // Kept only for the unchanged legacy Supabase client. Never returns a token.
    function getPin() { return legacy ? storage.getItem(KEY_PIN) || '' : ''; }
    function setPin(pin) {
      if (!legacy) return;
      const clean = String(pin || '').trim();
      if (clean) storage.setItem(KEY_PIN, clean);
      else storage.removeItem(KEY_PIN);
    }
    function getCredential() {
      if (!enabled() || authIssue) return '';
      if (legacy) return getPin();
      try {
        const token = storage.getItem(accessKey) || '';
        return ACCESS_PATTERN.test(token) ? token : '';
      } catch (_) { authIssue = 'access_storage_error'; return ''; }
    }
    function credentialStatus() {
      if (!enabled()) return 'unconfigured';
      const present = Boolean(getCredential());
      return authIssue || (present ? 'ready' : capability ? 'access_link_required' : 'pin_required');
    }
    function clearCredential() {
      const key = capability ? accessKey : legacy ? KEY_PIN : null;
      try {
        if (key) {
          storage.removeItem(key);
          if (storage.getItem(key) !== null) throw new Error('credential_removal_failed');
        }
        authIssue = '';
      } catch (error) { authIssue = 'access_storage_error'; throw error; }
    }
    async function request(method, body) {
      if (!enabled()) throw new Error('cloud_not_configured');
      const credential = getCredential();
      if (!credential) throw new Error(credentialStatus());
      const headers = { 'Content-Type': 'application/json' };
      if (capability) headers.Authorization = 'Bearer ' + credential;
      else { headers['x-family-pin'] = credential; headers.apikey = config.anonKey; }
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
    return { enabled, endpoint, protocol, authMode, atomic: worker, deviceId, getPin, setPin, getCredential, credentialStatus, clearCredential, consumeAccessLink, load, save };
  };
});
