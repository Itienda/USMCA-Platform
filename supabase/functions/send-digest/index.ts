// ============================================================
// PRODENSA · USMCA Intelligence — Edge Function: send-digest (v2.5)
// ------------------------------------------------------------
// Resumen diario por CORREO, enviado de verdad desde el servidor con la misma
// bitácora que WhatsApp. Cierra un hueco real: los planes Básico y Profesional
// no tienen WhatsApp, y hasta ahora su "correo" era un borrador mailto que
// alguien tenía que enviar a mano — es decir, no era un servicio.
//
// · Destinatarios: subscribers con 'email' en channels, agrupados por cliente.
// · Contenido: corte del cliente (sectores) de la edición publicada de hoy,
//   en el idioma de cada destinatario (es/en/ja/de), con nivel de fuente.
// · Idempotencia: (edición|destinatario|email) en alert_deliveries → una
//   corrida repetida no duplica correos.
// · Sin RESEND_API_KEY: devuelve 503 y NO simula envíos.
//
// Secretos: RESEND_API_KEY, ALERT_FROM_EMAIL, PLATFORM_URL
// Cron: TODOS LOS DÍAS 13:15 hora centro MX, después de curar-edicion.
// Ya programado en CARGAR_EN_SUPABASE_v3.2.sql (tarea digest).
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const T: Record<string, Record<string, string>> = {
  es: { subj: "Reporte USMCA", urgentes: "urgentes", pano: "Panorama del día", rojos: "Urgente — acción o escalamiento", ver: "Abrir la plataforma", pie: "Confidencial — uso exclusivo de miembros. No responda a este correo.", sin: "Sin novedades relevantes hoy. El monitoreo sigue activo." },
  en: { subj: "USMCA Report", urgentes: "urgent", pano: "Daily outlook", rojos: "Urgent — action or escalation", ver: "Open the platform", pie: "Confidential — members only. Please do not reply to this email.", sin: "No relevant developments today. Monitoring remains active." },
  ja: { subj: "USMCAレポート", urgentes: "件の緊急", pano: "本日の概況", rojos: "緊急—対応・報告要", ver: "プラットフォームを開く", pie: "機密：会員限定。本メールへの返信はご遠慮ください。", sin: "本日、重要な新規事案はございません。監視は継続しております。" },
  de: { subj: "USMCA-Bericht", urgentes: "dringend", pano: "Lagebild des Tages", rojos: "Dringend — Handlung oder Eskalation", ver: "Plattform öffnen", pie: "Vertraulich — nur für Mitglieder. Bitte antworten Sie nicht auf diese E-Mail.", sin: "Heute keine relevanten Entwicklungen. Die Überwachung läuft weiter." },
};
const esc = (s: string) => (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const tx = (o: any, l: string) => (o && (o[l] || o.en || o.es)) || "";
async function sha256(t: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, SRK);
  const auth = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (auth !== SRK) {
    const { data: u } = await db.auth.getUser(auth);
    if (!u?.user) return Response.json({ error: "no autorizado" }, { status: 401 });
    const { data: p } = await db.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
    if (p?.role !== "admin") return Response.json({ error: "requiere rol admin" }, { status: 403 });
  }
  const RESEND = Deno.env.get("RESEND_API_KEY");
  if (!RESEND) return Response.json({ error: "RESEND_API_KEY sin configurar — no se simulan envíos" }, { status: 503 });
  const FROM = Deno.env.get("ALERT_FROM_EMAIL") ?? "alertas@prodensa.com";
  const URLP = Deno.env.get("PLATFORM_URL") ?? "https://prodensa-usmca.netlify.app";

  // edición publicada más reciente
  const { data: ed } = await db.from("editions").select("id,edition_date,panorama,client_overrides")
    .eq("status", "published").order("edition_date", { ascending: false }).limit(1).maybeSingle();
  if (!ed) return Response.json({ error: "sin edición publicada" }, { status: 404 });
  const { data: items } = await db.from("news_items")
    .select("level,topic,title,summary,url,source,sectors,client_id,source_tier,conf,impl").eq("edition_id", ed.id);
  const { data: clientes } = await db.from("clients").select("id,name,sectors,langs,status,brand");
  const { data: subs } = await db.from("subscribers").select("name,email,lang,channels,membership_id,tz");

  let enviados = 0, deduped = 0, fallidos = 0;
  for (const s of subs ?? []) {
    if (!s.email || !(s.channels ?? []).includes("email")) continue;
    const cli = (clientes ?? []).find((c) => c.id === (s as any).client_id) ?? (clientes ?? [])[0];
    if (cli && ["suspendida", "vencida"].includes(cli.status)) continue;
    const lang = T[s.lang] ? s.lang : "es";
    const t = T[lang];
    const corte = (items ?? []).filter((n) =>
      (!n.client_id || n.client_id === cli?.id) &&
      (n.client_id === cli?.id || (n.sectors ?? ["automotriz"]).some((x: string) => (cli?.sectors ?? ["automotriz"]).includes(x))));
    const rojos = corte.filter((n) => n.level === "rojo");

    const key = await sha256(`${ed.edition_date}|${s.email}|email`);
    const { error: insErr } = await db.from("alert_deliveries").insert({
      idempotency_key: key, client_id: cli?.id ?? null, edition_date: ed.edition_date,
      news_url: `digest:${corte.length}`, recipient: s.email, channel: "email", lang, status: "queued", cost_usd: 0,
    });
    if (insErr) { deduped++; continue; }

    const ov = (ed.client_overrides ?? {})[cli?.id ?? ""] ?? null;
    const pano = tx(ov?.panorama ?? ed.panorama, lang).split("\n")[0];
    const item = (n: any) => `<tr><td style="padding:10px 0;border-bottom:1px solid #E1E7ED">
      <div style="font-size:11px;color:#5A6B7C">${n.level === "rojo" ? "⬤" : n.level === "amarillo" ? "▲" : "■"} ${esc(n.source)}${n.source_tier === "institucional" ? " · 🏛" : ""}${(n.conf ?? 1) >= 2 ? " · ✓×" + n.conf : ""}</div>
      <a href="${n.url}" style="font-size:14px;color:#0A2540;font-weight:600;text-decoration:none">${esc(tx(n.title, lang))}</a>
      <div style="font-size:12.5px;color:#33414F;margin-top:3px">${esc(tx(n.impl?.automotriz ?? n.impl?.dedicated ?? {}, lang))}</div></td></tr>`;
    const html = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:0 auto;color:#26313C">
      <div style="border-bottom:3px solid #00AEEF;padding-bottom:12px;margin-bottom:18px">
        <span style="font-weight:800;letter-spacing:2px;color:#0A2540;font-size:18px">PRODENSA</span>
        <div style="font-size:11px;color:#5A6B7C;letter-spacing:1px">USMCA INTELLIGENCE · ${ed.edition_date}</div></div>
      <p style="font-size:13.5px;line-height:1.7">${esc(pano)}</p>
      ${rojos.length ? `<h3 style="font-size:13px;color:#D64545;margin:20px 0 6px">${t.rojos} (${rojos.length})</h3>
        <table style="width:100%;border-collapse:collapse">${rojos.map(item).join("")}</table>` : `<p style="font-size:13px;color:#3E9B6E">✔ ${t.sin}</p>`}
      ${corte.length > rojos.length ? `<table style="width:100%;border-collapse:collapse;margin-top:14px">${corte.filter((n) => n.level !== "rojo").map(item).join("")}</table>` : ""}
      <p style="margin-top:22px"><a href="${URLP}" style="background:#00AEEF;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">${t.ver} →</a></p>
      <p style="font-size:10.5px;color:#5A6B7C;border-top:1px solid #E1E7ED;padding-top:10px;margin-top:22px">${t.pie}</p></div>`;

    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: FROM, to: s.email, subject: `PRODENSA · ${t.subj} ${ed.edition_date} — ${rojos.length} ${t.urgentes}`, html }),
      });
      if (!r.ok) throw new Error((await r.text()).slice(0, 200));
      await db.from("alert_deliveries").update({ status: "sent", updated_at: new Date().toISOString() }).eq("idempotency_key", key);
      enviados++;
    } catch (e) {
      await db.from("alert_deliveries").update({ status: "failed", error: String(e).slice(0, 400), updated_at: new Date().toISOString() }).eq("idempotency_key", key);
      fallidos++;
    }
  }
  return Response.json({ edicion: ed.edition_date, enviados, deduped, fallidos });
});
