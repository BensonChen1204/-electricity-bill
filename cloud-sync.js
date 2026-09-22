// Cloud sync adapter for Yilan Rental Helper v2.2
// Public project URL and anon key are intentionally frontend-safe.
// Writes still require the family PIN checked by the Edge Function.
window.YilanCloud = (() => {
  const KEY_PIN = "yilanFamilyPin";
  const KEY_DEVICE = "yilanDeviceId";
  const KEY_REV = "yilanCloudRevision";

  const config = window.YILAN_CLOUD_CONFIG || {};
  const enabled = () => Boolean(config.functionUrl && config.anonKey);

  function deviceId() {
    let id = localStorage.getItem(KEY_DEVICE);
    if (!id) {
      id = "device-" + crypto.randomUUID();
      localStorage.setItem(KEY_DEVICE, id);
    }
    return id;
  }

  function getPin() { return localStorage.getItem(KEY_PIN) || ""; }
  function setPin(pin) {
    const clean = String(pin || "").trim();
    if (clean) localStorage.setItem(KEY_PIN, clean);
    else localStorage.removeItem(KEY_PIN);
  }
  function revision() { return Number(localStorage.getItem(KEY_REV) || 0); }
  function setRevision(v) { localStorage.setItem(KEY_REV, String(Number(v) || 0)); }

  async function request(method, body) {
    if (!enabled()) throw new Error("cloud_not_configured");
    const pin = getPin();
    if (!pin) throw new Error("pin_required");

    const r = await fetch(config.functionUrl, {
      method,
      headers: {
        "Authorization": "Bearer " + config.anonKey,
        "apikey": config.anonKey,
        "Content-Type": "application/json",
        "x-family-pin": pin,
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });

    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(out.error || ("http_" + r.status));
      e.status = r.status;
      e.body = out;
      throw e;
    }
    return out;
  }

  async function load() {
    const out = await request("GET");
    if (out.exists) setRevision(out.revision);
    return out;
  }

  async function save(payload) {
    const out = await request("POST", {
      payload,
      expected_revision: revision(),
      actor: deviceId(),
    });
    setRevision(out.revision);
    return out;
  }

  return { enabled, deviceId, getPin, setPin, revision, setRevision, load, save };
})();
