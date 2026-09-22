import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-family-pin",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors });
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const expectedHash = Deno.env.get("YILAN_FAMILY_PIN_SHA256") || "";
  const pin = req.headers.get("x-family-pin") || "";
  if (!expectedHash || !pin || (await sha256Hex(pin)) !== expectedHash) {
    return reply({ ok: false, error: "unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(url, serviceRole, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const { data, error } = await db
      .from("yilan_app_state")
      .select("revision,payload,updated_at,updated_by")
      .eq("id", "main")
      .maybeSingle();
    if (error) return reply({ ok: false, error: error.message }, 500);
    return reply({ ok: true, exists: !!data, ...(data || {}) });
  }

  if (req.method !== "POST") return reply({ ok: false, error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => null);
  if (!body || typeof body.payload !== "object") return reply({ ok: false, error: "invalid_payload" }, 400);

  const actor = String(body.actor || "web").slice(0, 120);
  const expectedRevision = Number(body.expected_revision ?? 0);

  const { data: current, error: readError } = await db
    .from("yilan_app_state")
    .select("revision,payload")
    .eq("id", "main")
    .maybeSingle();
  if (readError) return reply({ ok: false, error: readError.message }, 500);

  if (current && expectedRevision !== Number(current.revision)) {
    return reply({ ok: false, error: "conflict", current_revision: current.revision, current_payload: current.payload }, 409);
  }

  const nextRevision = current ? Number(current.revision) + 1 : 1;

  if (current) {
    const { error: histError } = await db.from("yilan_app_state_history").insert({
      state_id: "main",
      revision: current.revision,
      payload: current.payload,
      changed_by: actor,
    });
    if (histError) return reply({ ok: false, error: histError.message }, 500);
  }

  const { data: saved, error: saveError } = await db
    .from("yilan_app_state")
    .upsert({
      id: "main",
      revision: nextRevision,
      payload: body.payload,
      updated_at: new Date().toISOString(),
      updated_by: actor,
    })
    .select("revision,payload,updated_at,updated_by")
    .single();

  if (saveError) return reply({ ok: false, error: saveError.message }, 500);
  return reply({ ok: true, ...saved });
});
