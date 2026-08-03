// ============================================================
// PRODENSA · USMCA Intelligence — Edge Function: fetch-institucional (v2.4)
// ------------------------------------------------------------
// Aumenta el flujo de noticias con FUENTES INSTITUCIONALES primarias
// (petición de Isaac, 31-jul-2026) y las deja disponibles para:
//   (a) el analista, como insumo verificado de la corrida editorial
//   (b) el cliente, en el panel "Fuentes oficiales" de la plataforma
//
// EE. UU. — Federal Register API (gratis, sin llave; verificado:
//   2,079 documentos de USTR). Es superior al RSS de USTR porque trae
//   agencia, tipo de documento (Rule / Proposed Rule / Notice), fecha
//   oficial de publicación y liga permanente. Agencias vigiladas:
//   USTR · Commerce/BIS · CBP · ITC — filtradas por términos USMCA.
// México — DOF (SIDOF) y comunicados de dependencias (SE, SRE,
//   Presidencia). Si un host no responde, se declara en source_health
//   y NO se inventa contenido.
//
// Todo lo que entra queda marcado source_tier='institucional': es el
// nivel más alto del verificador de fuentes.
//
// Cron: TODOS LOS DÍAS 7:30 y 12:00 hora centro MX. Ya programado en
// CARGAR_EN_SUPABASE_v3.2.sql (tareas inst-am / inst-md); no hace falta tocarlo.
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const TERMINOS = ["USMCA", "Mexico tariff", "rules of origin", "Section 232 automobile", "Section 301",
  "rapid response labor mechanism", "USMCA joint review", "regional value content", "Mexico labor rights"];
const AGENCIAS = [
  { slug: "trade-representative-office-of-united-states", nombre: "USTR" },
  { slug: "industry-and-security-bureau", nombre: "BIS · Commerce" },
  { slug: "u-s-customs-and-border-protection", nombre: "CBP" },
  { slug: "international-trade-commission", nombre: "USITC" },
];
const MX_FUENTES = [
  { nombre: "DOF · Diario Oficial", url: (f: string) => `https://sidofqa.segob.gob.mx/dof/sidof/documentos/diario_json/${f}`, tipo: "dof" },
  { nombre: "Secretaría de Economía", url: () => "https://www.gob.mx/se/rss/articulos", tipo: "rss" },
  { nombre: "Secretaría de Relaciones Exteriores", url: () => "https://www.gob.mx/sre/rss/articulos", tipo: "rss" },
];
const hoy = () => new Date().toISOString().slice(0, 10);
const hace = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

async function jget(url: string, ms = 12000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "PRODENSA-USMCA-Intelligence/2.4" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); } finally { clearTimeout(t); }
}
async function tget(url: string, ms = 12000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "PRODENSA-USMCA-Intelligence/2.4" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); } finally { clearTimeout(t); }
}
/* RSS mínimo sin dependencias (title/link/pubDate) */
function parseRSS(xml: string, limite = 10) {
  const out: any[] = [];
  const items = xml.split(/<item[\s>]/i).slice(1, limite + 1);
  for (const it of items) {
    const g = (tag: string) => {
      const m = it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : "";
    };
    const title = g("title"), link = g("link");
    if (title && link) out.push({ title, url: link, fecha: (new Date(g("pubDate") || Date.now())).toISOString().slice(0, 10) });
  }
  return out;
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

  const filas: any[] = [];
  const salud: { source: string; ok: boolean; detail?: string }[] = [];
  const nota = (s: string, ok: boolean, d = "") => salud.push({ source: s, ok, detail: d });
  const desde = hace(10);

  // ---- EE. UU.: Federal Register (por agencia y por término) ----
  /* comments_close_on: la fecha límite para comentar es lo ACCIONABLE de un aviso
   del Federal Register — un cliente puede presentar postura antes de que cierre. */
const campos = "&fields[]=title&fields[]=publication_date&fields[]=html_url&fields[]=type&fields[]=abstract&fields[]=agencies&fields[]=comments_close_on&fields[]=docket_ids";
  for (const a of AGENCIAS) {
    try {
      const j = await jget(`https://www.federalregister.gov/api/v1/documents.json?conditions[agencies][]=${a.slug}&conditions[publication_date][gte]=${desde}&per_page=20&order=newest${campos}`);
      for (const d of j.results ?? []) {
        filas.push({ pais: "US", entidad: a.nombre, tipo: d.type ?? "Notice", fecha: d.publication_date,
          titulo: d.title, resumen: (d.abstract ?? "").slice(0, 900), url: d.html_url, tema: null,
          comentarios_hasta: d.comments_close_on ?? null, expediente: (d.docket_ids ?? [])[0] ?? null });
      }
      nota("federal_register:" + a.nombre, true, `${(j.results ?? []).length} doc(s)`);
    } catch (e) { nota("federal_register:" + a.nombre, false, String(e).slice(0, 120)); }
  }
  for (const t of TERMINOS) {
    try {
      const j = await jget(`https://www.federalregister.gov/api/v1/documents.json?conditions[term]=${encodeURIComponent(t)}&conditions[publication_date][gte]=${desde}&per_page=10&order=newest${campos}`);
      for (const d of j.results ?? []) {
        filas.push({ pais: "US", entidad: (d.agencies?.[0]?.name ?? "Federal Register"), tipo: d.type ?? "Notice",
          fecha: d.publication_date, titulo: d.title, resumen: (d.abstract ?? "").slice(0, 900), url: d.html_url, tema: t });
      }
      nota("federal_register:term:" + t, true, `${(j.results ?? []).length} doc(s)`);
    } catch (e) { nota("federal_register:term:" + t, false, String(e).slice(0, 120)); }
  }

  // ---- México: DOF y comunicados oficiales (degradación declarada si no responden) ----
  for (const f of MX_FUENTES) {
    try {
      if (f.tipo === "dof") {
        const j = await jget(f.url(hoy()));
        const secciones = Array.isArray(j) ? j : (j?.NumeroPagina ?? j?.Ejemplares ?? []);
        const arr = (j?.CadaEjemplar ?? secciones ?? []) as any[];
        let n = 0;
        for (const s of arr) for (const nota2 of (s?.CadaNota ?? s?.notas ?? [])) {
          const titulo = nota2?.titulo ?? nota2?.Titulo; if (!titulo) continue;
          if (!/arancel|comercio|autom|acero|aluminio|T-MEC|TMEC|importaci|exportaci|IMMEX|origen/i.test(titulo)) continue;
          filas.push({ pais: "MX", entidad: "DOF · " + (nota2?.organismo ?? nota2?.codOrgaAbrev ?? "Federal"), tipo: "Publicación DOF",
            fecha: hoy(), titulo, resumen: "", url: nota2?.url ?? nota2?.Url ?? "https://www.dof.gob.mx/", tema: null });
          n++;
        }
        nota("dof", true, `${n} nota(s) relevante(s)`);
      } else {
        const xml = await tget(f.url(hoy()));
        for (const it of parseRSS(xml, 12)) {
          if (!/arancel|comercio|T-MEC|TMEC|USMCA|autom|export|import|inversi/i.test(it.title)) continue;
          filas.push({ pais: "MX", entidad: f.nombre, tipo: "Comunicado", fecha: it.fecha, titulo: it.title, resumen: "", url: it.url, tema: null });
        }
        nota(f.nombre, true);
      }
    } catch (e) { nota(f.nombre, false, String(e).slice(0, 140)); }
  }

  // ---- escribir (idempotente por url+fecha) ----
  let guardadas = 0;
  if (filas.length) {
    const { error } = await db.from("institutional_feed")
      .upsert(filas.map((f) => ({ ...f, source_tier: "institucional" })), { onConflict: "url,fecha", ignoreDuplicates: false });
    if (error) return Response.json({ error: "no se pudo escribir institutional_feed: " + error.message, salud }, { status: 500 });
    guardadas = filas.length;
  }
  await db.from("source_health").insert(salud.map((s) => ({ run_date: hoy(), run_mode: "manual", source: "inst:" + s.source, ok: s.ok, detail: s.detail?.slice(0, 300) ?? null })));
  // retención: 120 días
  await db.from("institutional_feed").delete().lt("fecha", hace(120));

  return Response.json({
    guardadas, us: filas.filter((f) => f.pais === "US").length, mx: filas.filter((f) => f.pais === "MX").length,
    fuentes_con_falla: salud.filter((s) => !s.ok).map((s) => `${s.source}: ${s.detail}`),
  });
});
