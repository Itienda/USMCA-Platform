// ============================================================
// PRODENSA · USMCA Intelligence — Edge Function: whatsapp-webhook
// Recibe los webhooks de estado de Meta (sent/delivered/read/failed)
// y actualiza la bitácora `alert_deliveries` por `wamid`. Esta
// bitácora es la evidencia del SLA y el control del gasto: sin ella
// el sistema vuelve a "reportar éxito que no puede observar".
// Config en Meta (doc 13): callback URL = esta función,
// verify token = WHATSAPP_VERIFY_TOKEN, campo `messages`.
// Desplegar con: supabase functions deploy whatsapp-webhook --no-verify-jwt
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  // Verificación inicial de Meta (GET con hub.challenge)
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.verify_token") === Deno.env.get("WHATSAPP_VERIFY_TOKEN");
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 })
              : new Response("forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const payload = await req.json().catch(() => null);
  const statuses = payload?.entry?.flatMap((e: any) => e.changes ?? [])
    .flatMap((c: any) => c.value?.statuses ?? []) ?? [];

  for (const st of statuses) {
    const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (["sent", "delivered", "read", "failed"].includes(st.status)) upd.status = st.status;
    if (st.errors?.length) upd.error = JSON.stringify(st.errors).slice(0, 500);
    // Meta manda el costo real en pricing (cuando aplica): úsalo sobre el estimado
    if (st.pricing?.category) upd.cost_usd = st.pricing?.billable === false ? 0 : undefined;
    Object.keys(upd).forEach((k) => upd[k] === undefined && delete upd[k]);
    await db.from("alert_deliveries").update(upd).eq("wamid", st.id);
  }
  return Response.json({ received: statuses.length });
});
