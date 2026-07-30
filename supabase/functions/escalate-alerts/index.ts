// ============================================================
// PRODENSA · USMCA Intelligence — Edge Function: escalate-alerts
// Corre por cron (cada 10 min, doc 13):
//  1) ESCALAMIENTO: alertas `sent` sin confirmación de entrega tras
//     ESCALATION_MINUTES → respaldo por correo. Si RESEND_API_KEY está
//     configurada envía el correo; si no, marca `escalated` y el panel
//     de administración lo muestra para seguimiento manual — nunca se
//     finge que el respaldo salió.
//  2) REINTENTO de horario silencioso: `skipped_quiet_hours` cuya
//     ventana local ya abrió → se reencola marcándolas `queued` para
//     que la siguiente corrida de send-alerts las tome (misma clave de
//     idempotencia: no hay duplicado posible).
// Cron sugerido (SQL, doc 13): select cron.schedule(...)
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const ESCALATION_MINUTES = +(Deno.env.get("ALERT_ESCALATION_MINUTES") ?? "15");

Deno.serve(async (_req) => {
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const limite = new Date(Date.now() - ESCALATION_MINUTES * 60_000).toISOString();

  // 1) sin confirmación de entrega → correo de respaldo
  const { data: pendientes } = await db.from("alert_deliveries")
    .select("*").eq("channel", "whatsapp").eq("status", "sent").lt("updated_at", limite);
  let escaladas = 0, correos = 0;
  const RESEND = Deno.env.get("RESEND_API_KEY");
  for (const d of pendientes ?? []) {
    if (RESEND) {
      // destinatario de correo: se busca el suscriptor por WhatsApp en subscribers
      const { data: sub } = await db.from("subscribers").select("email,name").eq("whatsapp", d.recipient).maybeSingle();
      if (sub?.email) {
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: Deno.env.get("ALERT_FROM_EMAIL") ?? "alertas@prodensa.com",
            to: sub.email,
            subject: `🔴 PRODENSA · Alerta USMCA ${d.edition_date} (respaldo)`,
            text: `Su alerta de WhatsApp no confirmó entrega en ${ESCALATION_MINUTES} min.\nDetalle: ${d.news_url}\n— PRODENSA Market Intelligence`,
          }),
        });
        if (r.ok) correos++;
      }
    }
    await db.from("alert_deliveries").update({ status: "escalated", updated_at: new Date().toISOString() }).eq("id", d.id);
    escaladas++;
  }

  // 2) reabrir horario silencioso (ventana local 07:00–21:00)
  const { data: quiet } = await db.from("alert_deliveries")
    .select("id,recipient").eq("status", "skipped_quiet_hours");
  let reencoladas = 0;
  for (const d of quiet ?? []) {
    // la zona horaria vive en subscribers.tz (columna agregada en schema v2)
    const { data: sub } = await db.from("subscribers").select("tz").eq("whatsapp", d.recipient).maybeSingle();
    const tz = sub?.tz && String(sub.tz).includes("/") ? sub.tz : "America/Mexico_City";
    const h = +new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date());
    if (h >= 7 && h < 21) {
      await db.from("alert_deliveries").update({ status: "queued", updated_at: new Date().toISOString() }).eq("id", d.id);
      reencoladas++;
    }
  }
  return Response.json({ escaladas, correos_respaldo: correos, reencoladas, nota: RESEND ? "correo activo" : "RESEND_API_KEY sin configurar: escalamiento marcado para seguimiento manual" });
});
