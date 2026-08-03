// ============================================================
// PRODENSA · USMCA Intelligence — Edge Function: send-alerts
// Envía alertas rojas por WhatsApp Business Cloud API (Meta).
// Existe para que el token de Meta NUNCA toque el navegador y para
// que cada envío quede en la bitácora `alert_deliveries` con clave
// de idempotencia: una corrida repetida no duplica alertas.
//
// POST {edition_date, items:[{url,date,title:{es,en,ja},impl:{es,en,ja}}],
//       recipients:[{name,wa,lang,tz,client_id?,mode?:"item"|"digest"}], test?:bool}
//
// MODO HÍBRIDO POR PLAN (decisión de Isaac, 29-jul-2026):
//   · mode:"item"   → un mensaje por rojo (Enterprise): plantilla alerta_roja_usmca
//   · mode:"digest" → un mensaje por corrida con todos los rojos (Corporativo):
//     plantilla resumen_rojos_usmca — reduce el costo ~5× y las interrupciones.
//   Default: digest. Con un solo rojo, digest usa la plantilla individual.
//
// Reglas:
//  · Plantilla `alerta_roja_usmca` (Utility), idioma por destinatario
//    (es_MX / en_US / ja). Aprobada por Isaac el 29-jul-2026.
//  · Idempotencia: sha256(edition|item.url|wa|whatsapp) única en BD.
//  · Horario silencioso 21:00–07:00 hora local del destinatario:
//    se registra `skipped_quiet_hours`; el cron de escalate-alerts
//    lo reintenta al abrir la ventana.
//  · Costo: desde el 1-oct-2026 Meta cobra TODOS los mensajes de
//    negocio; se registra COST_PER_MSG_USD por mensaje desde hoy.
// Secretos (supabase secrets set):
//  WHATSAPP_TOKEN, WHATSAPP_PHONE_ID  (Meta · doc 13)
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const COST_PER_MSG_USD = 0.008; // utilidad, México (supuesto post 1-oct-2026)
const QUIET_START = 21, QUIET_END = 7; // hora local del destinatario
const TPL = "alerta_roja_usmca";
const TPL_DIGEST = "resumen_rojos_usmca";
const TPL_LANG: Record<string, string> = { es: "es_MX", en: "en_US", ja: "ja" };
/* Las variables de plantilla de Meta NO admiten saltos de línea: la lista del
   resumen va en línea con separadores. */
function digestList(items: any[], lang: string) {
  const clean = (t: string) => (t || "").replace(/\s+/g, " ").trim();
  return items.map((it, i) =>
    (i + 1) + ") " + clean(it.title?.[lang] || it.title?.en || it.title?.es) + " — " + clean(it.impl?.[lang] || it.impl?.en || it.impl?.es)
  ).join("  ●  ").slice(0, 900);
}

async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function localHour(tz: string) {
  return +new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date());
}
function inQuietHours(tz: string) {
  const h = localHour(tz || "America/Mexico_City");
  return h >= QUIET_START || h < QUIET_END;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const TOKEN = Deno.env.get("WHATSAPP_TOKEN");
  const PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID");
  if (!TOKEN || !PHONE_ID) {
    return Response.json({ error: "WhatsApp Cloud API sin configurar (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID). Ver doc 13. No se simulan envíos." }, { status: 503 });
  }
  const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, SRK);
  /* SEGURIDAD (revisión full-stack 31-jul-2026): antes CUALQUIER usuario
     autenticado podía invocar esta función y gastar mensajes de pago hacia
     destinatarios arbitrarios. Ahora exige service_role (cron/pipeline) o admin,
     y acota el tamaño de la llamada. */
  const auth = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (auth !== SRK) {
    const { data: u } = await db.auth.getUser(auth);
    if (!u?.user) return Response.json({ error: "no autorizado" }, { status: 401 });
    const { data: p } = await db.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
    if (p?.role !== "admin") return Response.json({ error: "solo un administrador puede disparar alertas" }, { status: 403 });
  }
  const { edition_date, items = [], recipients = [], test = false } = await req.json();
  if (recipients.length > 200 || items.length > 50) return Response.json({ error: "limite excedido (200 destinatarios / 50 items)" }, { status: 400 });
  if (!edition_date || !items.length || !recipients.length) {
    return Response.json({ error: "payload incompleto: edition_date, items[], recipients[]" }, { status: 400 });
  }

  let queued = 0, skipped_quiet = 0, deduped = 0, failed = 0;
  for (const r of recipients) {
    const lang = TPL_LANG[r.lang] ? r.lang : "es";
    const modo = r.mode === "item" ? "item" : "digest";
    /* digest con 2+ ítems: un solo envío por destinatario y corrida */
    const paquetes = (modo === "digest" && items.length > 1)
      ? [{ digest: true, urls: items.map((x: any) => x.url).sort().join(","), items }]
      : items.map((it: any) => ({ digest: false, urls: it.url, items: [it] }));
    for (const paq of paquetes) {
      const it = paq.items[0];
      const key = await sha256(`${edition_date}|${paq.urls}|${r.wa}|whatsapp`);
      // Idempotencia: si la clave ya existe, no se reenvía.
      const { error: insErr } = await db.from("alert_deliveries").insert({
        idempotency_key: key, client_id: r.client_id ?? null, edition_date,
        news_url: paq.digest ? ("digest:" + paq.items.length + " ítems") : it.url,
        recipient: r.wa, channel: "whatsapp", lang,
        status: "queued", cost_usd: 0,
      });
      if (insErr) { deduped++; continue; } // clave duplicada u otro conflicto: no duplicar

      if (!test && inQuietHours(r.tz)) {
        await db.from("alert_deliveries").update({ status: "skipped_quiet_hours", updated_at: new Date().toISOString() }).eq("idempotency_key", key);
        skipped_quiet++; continue;
      }

      const clean1 = (t: string) => (t || "").replace(/\s+/g, " ").slice(0, 300);
      const params = paq.digest
        ? [
            { type: "text", text: edition_date },
            { type: "text", text: String(paq.items.length) },
            { type: "text", text: digestList(paq.items, lang) },
          ]
        : [
            { type: "text", text: it.date || edition_date },
            { type: "text", text: clean1(it.title?.[lang] || it.title?.en || it.title?.es) },
            { type: "text", text: clean1(it.impl?.[lang] || it.impl?.en || it.impl?.es) },
          ];
      const body = {
        messaging_product: "whatsapp", to: r.wa.replace(/[^+\d]/g, ""), type: "template",
        template: {
          name: paq.digest ? TPL_DIGEST : TPL, language: { code: TPL_LANG[lang] },
          components: [
            { type: "body", parameters: params },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: edition_date }] },
          ],
        },
      };
      try {
        const res = await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID}/messages`, {
          method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`);
        await db.from("alert_deliveries").update({
          status: "sent", wamid: j.messages?.[0]?.id ?? null, cost_usd: COST_PER_MSG_USD,
          updated_at: new Date().toISOString(),
        }).eq("idempotency_key", key);
        queued++;
      } catch (e) {
        await db.from("alert_deliveries").update({ status: "failed", error: String(e).slice(0, 500), updated_at: new Date().toISOString() }).eq("idempotency_key", key);
        failed++;
      }
    }
  }
  // fin del doble loop destinatario→paquete
  return Response.json({ queued, skipped_quiet, deduped, failed });
});
