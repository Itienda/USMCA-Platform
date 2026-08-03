// ============================================================
// PRODENSA · USMCA Intelligence — Edge Function: sync-editorial (v3.3)
// ------------------------------------------------------------
// EL PUENTE Claude ↔ Supabase que faltaba.
//
// Problema que resuelve (auditoría 3-ago-2026): las tareas programadas de
// Claude escriben la edición en archivos locales (OneDrive) porque su sandbox
// no tiene salida de red hacia Supabase. El único puente era una tarea de
// Windows (sincronizar_supabase.mjs cada 60 min) que depende de que la PC de
// Isaac esté encendida y OneDrive sincronizado — un punto único de falla sin
// monitoreo.
//
// Solución: el pipeline ya publica el HTML en Netlify (git push →
// prodensa-usmca.netlify.app, sitio público). Esta función corre por cron de
// Supabase, descarga ese HTML, extrae los bloques `const EDITION` y
// `const NEWS` con el mismo escáner de llaves del pipeline, y hace upsert en
// `editions` / `news_items`. Resultado: en cuanto hay deploy, la base se
// alinea sola — sin PC de Isaac, sin credenciales nuevas (el sitio es público
// y la función ya trae su service key en el entorno).
//
// La tarea de Windows puede seguir corriendo como respaldo: ambas rutas son
// idempotentes (upsert por edition_date + reemplazo de ítems).
//
// Honestidad operativa: si el sitio no responde o los bloques no se pueden
// leer, se reporta en source_health y NO se toca la base. Nunca se inventa.
//
// Secretos: ninguno nuevo. Usa SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY que
// Supabase inyecta por omisión. Opcional: SYNC_SOURCE_URL para otro origen.
// Cron: CARGAR_EN_SUPABASE_v3.3.sql (diario 8:20 y 12:50 hora centro MX).
// Invocable a mano:
//   curl -X POST https://<ref>.supabase.co/functions/v1/sync-editorial \
//        -H "Authorization: Bearer <service_role_key>"
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const ORIGEN = Deno.env.get("SYNC_SOURCE_URL") ?? "https://prodensa-usmca.netlify.app/";

/* Escáner de bloques idéntico al de actualizar_plataforma.mjs /
   sincronizar_supabase.mjs: respeta comillas y escapes para no cortar en
   llaves dentro de texto (el bloque NEWS es una sola línea enorme). */
function bloque(src: string, nombre: string): unknown | null {
  const decl = `const ${nombre} = `;
  const i = src.indexOf(decl);
  if (i === -1) return null;
  const ini = i + decl.length;
  const abre = src[ini];
  if (abre !== "{" && abre !== "[") return null;
  let prof = 0, enCadena = false, esc = false;
  for (let k = ini; k < src.length; k++) {
    const c = src[k];
    if (enCadena) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') enCadena = false;
      continue;
    }
    if (c === '"') enCadena = true;
    else if (c === "{" || c === "[") prof++;
    else if (c === "}" || c === "]") {
      prof--;
      if (prof === 0) {
        try { return JSON.parse(src.slice(ini, k + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

type Dict = Record<string, unknown>;

Deno.serve(async (req) => {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const salud = async (ok: boolean, detalle: string) => {
    try {
      await supa.from("source_health").insert({
        fuente: "sync-editorial (Netlify)", ok, detalle: detalle.slice(0, 500),
      });
    } catch { /* la bitácora nunca debe tumbar la corrida */ }
  };

  try {
    const r = await fetch(ORIGEN, { headers: { "cache-control": "no-cache" } });
    if (!r.ok) {
      await salud(false, `HTTP ${r.status} al descargar ${ORIGEN}`);
      return new Response(JSON.stringify({ ok: false, error: `HTTP ${r.status}` }), { status: 502 });
    }
    const html = await r.text();
    const ed = bloque(html, "EDITION") as Dict | null;
    const news = bloque(html, "NEWS") as Dict[] | null;
    if (!ed || !Array.isArray(news)) {
      await salud(false, "No se pudieron extraer los bloques EDITION/NEWS del HTML publicado");
      return new Response(JSON.stringify({ ok: false, error: "bloques ilegibles" }), { status: 422 });
    }

    /* Guarda anti-retroceso: nunca sobrescribir una edición MÁS NUEVA en la
       base con un HTML publicado viejo (p. ej. deploy atrasado). */
    const { data: ultima } = await supa.from("editions")
      .select("edition_date").eq("status", "published")
      .order("edition_date", { ascending: false }).limit(1).maybeSingle();
    if (ultima && String(ultima.edition_date) > String(ed.date)) {
      await salud(true, `Sin cambios: base en ${ultima.edition_date}, sitio en ${ed.date} (no se retrocede)`);
      return new Response(JSON.stringify({ ok: true, skipped: true, reason: "site older than DB" }));
    }

    const fila = {
      edition_date: ed.date,
      window_es: ed.window_es ?? null, window_en: ed.window_en ?? null,
      window_ja: ed.window_ja ?? null, window_de: ed.window_de ?? null,
      panorama: ed.panorama ?? null, analysis: ed.analysis ?? null,
      watch: ed.watch ?? null, markets: ed.markets ?? null,
      calendar: ed.calendar ?? null, tmec: ed.tmec ?? null, aviso: ed.aviso ?? null,
      client_overrides: ed.client_overrides ?? null, status: "published",
    };
    const { data: reg, error: e1 } = await supa.from("editions")
      .upsert(fila, { onConflict: "edition_date" }).select("id").single();
    if (e1) throw new Error(`upsert editions: ${e1.message}`);

    const { error: e2 } = await supa.from("news_items").delete().eq("edition_id", reg.id);
    if (e2) throw new Error(`delete news_items: ${e2.message}`);

    const filas = news.map((n) => ({
      edition_id: reg.id, pub_date: n.date, topic: n.topic, level: n.level,
      sentiment: n.sent, conf: n.conf ?? 1, state: n.state, city: n.city,
      lat: n.lat, lng: n.lng, source: n.source, url: n.url,
      title: n.title, summary: n.sum,
      sectors: n.sectors ?? ["automotriz"], impl: n.impl ?? null,
      client_id: n.client_id ?? null,
      source_tier: n.source_tier ?? null, usmca_ref: n.usmca_ref ?? null,
      sin_traducir: n.sin_traducir ?? false, origen: "sync-editorial",
    }));
    for (let i = 0; i < filas.length; i += 50) {
      const { error: e3 } = await supa.from("news_items").insert(filas.slice(i, i + 50));
      if (e3) throw new Error(`insert news_items: ${e3.message}`);
    }

    await salud(true, `Edición ${ed.date} sincronizada: ${filas.length} ítem(s)`);
    return new Response(JSON.stringify({ ok: true, edition: ed.date, items: filas.length }));
  } catch (err) {
    await salud(false, String(err));
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
});
