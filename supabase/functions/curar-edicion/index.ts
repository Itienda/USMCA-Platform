// ============================================================================
// PRODENSA · USMCA Intelligence — Edge Function: curar-edicion (v3.2)
// ----------------------------------------------------------------------------
// PRE-CURADURÍA DETERMINISTA. SIN MODELO DE PAGO. SIN LLAVES DE IA.
//
// QUÉ CAMBIÓ RESPECTO DE v3.1
//   La versión anterior llamaba a la API de Anthropic para redactar la edición
//   completa. Eso costaba dinero por corrida y se descartó. Esta versión hace
//   TODO lo que se puede hacer sin un modelo de lenguaje —que es más de lo que
//   parece— y deja la redacción a las tareas programadas de Claude, que ya
//   están cubiertas por la suscripción.
//
// REPARTO DE TRABAJO
//   Supabase (gratis, 7 días, aquí):
//     · Ingesta: Federal Register (USTR/CBP/BIS/USITC), DOF, 9 RSS, GDELT 2.0
//     · Deduplicación contra lo ya publicado y contra la bandeja
//     · Nivel de fuente desde source_registry
//     · Clasificación por tema y base jurídica del T-MEC, POR REGLAS
//     · Nivel sugerido del semáforo, POR REGLAS
//     · Escritura en `curation_inbox` para que el analista o Claude redacte
//     · PISO INSTITUCIONAL: si a la hora de correr no hay edición publicada
//       hoy, publica los hechos institucionales con su título y resumen
//       ORIGINALES, declarados como edición sin análisis.
//
//   Tarea de Claude (suscripción, redacta):
//     · Panorama, análisis, implicaciones por sector, semáforo definitivo
//     · Traducción ES/EN/JA/DE con keigo corporativo
//     · Sustituye el piso institucional cuando llega
//
// POR QUÉ ESTE REPARTO ES MEJOR, NO UN PARCHE
//   El sandbox donde corren las tareas de Claude no siempre resuelve DNS —fue
//   exactamente lo que impidió conectar INEGI—. Moviendo la ingesta a Supabase,
//   que sí tiene red estable, la parte frágil desaparece y a Claude le llega
//   material ya deduplicado y clasificado. Menos trabajo, menos superficie de
//   falla y ningún costo por consulta.
//
// LO QUE ESTA FUNCIÓN NO HACE, A PROPÓSITO
//   No redacta. No traduce. No interpreta. No marca nada en ROJO por su cuenta:
//   un rojo mueve decisiones de millones de dólares y no lo decide una regla de
//   palabras clave. Lo más alto que publica el piso institucional es AMARILLO.
//
// SECRETOS: ninguno obligatorio. No usa ninguna llave de IA.
// CRON: ver CARGAR_EN_SUPABASE_v3.2.sql (tareas curar-am y curar-md)
// ============================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const MAX_INBOX = 60;      // tope de candidatos por corrida
const MAX_PISO  = 6;       // tope de ítems del piso institucional

const hoy = () => new Date().toISOString().slice(0, 10);
const hace = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

/* `source_health.run_mode` solo acepta matutina | mediodia | manual. Se evalúa
   POR INVOCACIÓN, no a nivel de módulo: Deno reutiliza isolates calientes y una
   constante de módulo habría etiquetado la corrida del mediodía como matutina. */
const modoAhora = () => new Date().getUTCHours() < 16 ? "matutina" : "mediodia";
/* ---------------------------------------------------------------- utilidades */
async function jget(url: string, ms = 15000, headers: Record<string, string> = {}) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "PRODENSA-USMCA/3.2", ...headers } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function tget(url: string, ms = 15000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { "User-Agent": "PRODENSA-USMCA/3.2" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
function parseRSS(xml: string, limite = 12) {
  const out: any[] = [];
  const items = xml.split(/<item[\s>]/i).slice(1, limite + 1);
  for (const it of items) {
    const g = (tag: string) => {
      const m = it.match(new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i"));
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim() : "";
    };
    const title = g("title"), link = g("link"), desc = g("description");
    if (title && link && /^https?:/.test(link)) {
      /* Una fecha ilegible tumbaba el feed completo con RangeError. Ahora el
         ítem conserva la fecha de hoy y el resto del feed sigue vivo. */
      let fecha = hoy();
      const d = new Date(g("pubDate"));
      if (!isNaN(d.getTime())) fecha = d.toISOString().slice(0, 10);
      out.push({ titulo: title, url: link, resumen: desc.slice(0, 400), fecha });
    }
  }
  return out;
}

/* ------------------------------------------------------------------- fuentes */
const RSS_MEDIOS = [
  { nombre: "El Economista", url: "https://www.eleconomista.com.mx/rss/economia" },
  { nombre: "El Economista · Empresas", url: "https://www.eleconomista.com.mx/rss/empresas" },
  { nombre: "El Financiero · Economía", url: "https://www.elfinanciero.com.mx/arc/outboundfeeds/rss/category/economia/?outputType=xml" },
  { nombre: "Expansión", url: "https://expansion.mx/rss/economia" },
  { nombre: "Milenio · Negocios", url: "https://www.milenio.com/rss/negocios" },
  { nombre: "La Jornada · Economía", url: "https://www.jornada.com.mx/rss/economia.xml" },
  { nombre: "AM · Salamanca", url: "https://www.am.com.mx/rss/salamanca.xml" },
  { nombre: "Zona Franca", url: "https://zonafranca.mx/feed/" },
  { nombre: "Cluster Industrial", url: "https://www.clusterindustrial.com.mx/rss" },
];
const AGENCIAS_FR = [
  { slug: "trade-representative-office-of-united-states", nombre: "USTR" },
  { slug: "u-s-customs-and-border-protection", nombre: "CBP" },
  { slug: "industry-and-security-bureau", nombre: "BIS · Commerce" },
  { slug: "international-trade-commission", nombre: "USITC" },
];
const TERMINOS_FR = ["USMCA", "Mexico tariff", "rules of origin", "rapid response labor mechanism", "Section 232 automobile"];
const GDELT_CONSULTAS = [
  '("T-MEC" OR USMCA) sourcecountry:MX',
  '(arancel OR aranceles) (Mexico OR México) automotriz',
  '"reglas de origen" automotriz',
  '(Guanajuato OR Salamanca) (seguridad OR planta OR Mazda)',
];

/* ----------------------------------------------------------------- ingesta */
async function ingesta(nota: (s: string, ok: boolean, d?: string) => void) {
  const arts: any[] = [];
  const desde = hace(3);

  // Federal Register — por agencia y por término
  const campos = "&fields[]=title&fields[]=publication_date&fields[]=html_url&fields[]=abstract&fields[]=type&fields[]=agencies&fields[]=comments_close_on";
  for (const a of AGENCIAS_FR) {
    try {
      const j = await jget(`https://www.federalregister.gov/api/v1/documents.json?conditions[agencies][]=${a.slug}&conditions[publication_date][gte]=${desde}&per_page=8&order=newest${campos}`);
      for (const d of j.results ?? []) arts.push({ fuente: a.nombre, tier: "institucional", pais: "US",
        titulo: d.title, url: d.html_url, resumen: (d.abstract ?? "").slice(0, 600), fecha: d.publication_date,
        vence: d.comments_close_on ?? null });
      nota("fr:" + a.nombre, true, String((j.results ?? []).length));
    } catch (e) { nota("fr:" + a.nombre, false, String(e).slice(0, 100)); }
  }
  for (const t of TERMINOS_FR) {
    try {
      const j = await jget(`https://www.federalregister.gov/api/v1/documents.json?conditions[term]=${encodeURIComponent(t)}&conditions[publication_date][gte]=${desde}&per_page=5&order=newest${campos}`);
      for (const d of j.results ?? []) arts.push({ fuente: d.agencies?.[0]?.name ?? "Federal Register", tier: "institucional", pais: "US",
        titulo: d.title, url: d.html_url, resumen: (d.abstract ?? "").slice(0, 600), fecha: d.publication_date,
        vence: d.comments_close_on ?? null });
      nota("fr:term:" + t, true);
    } catch (e) { nota("fr:term:" + t, false, String(e).slice(0, 100)); }
  }

  // DOF — primero el ambiente productivo; sidofqa es el de PRUEBAS y solo se usa
  // como último recurso, dejando constancia de cuál respondió.
  try {
    let j: any = null, host = "";
    for (const h of ["https://sidof.segob.gob.mx", "https://sidofqa.segob.gob.mx"]) {
      try { j = await jget(`${h}/dof/sidof/documentos/diario_json/${hoy()}`); host = h; break; }
      catch (_) { /* siguiente */ }
    }
    if (!j) throw new Error("ningún host de SIDOF respondió");
    const secciones = (j?.CadaEjemplar ?? (Array.isArray(j) ? j : [])) as any[];
    let n = 0, sinUrl = 0;
    for (const s of secciones) for (const it of (s?.CadaNota ?? s?.notas ?? [])) {
      const titulo = it?.titulo ?? it?.Titulo; if (!titulo) continue;
      if (!/arancel|comercio|autom|acero|aluminio|T-MEC|TMEC|importaci|exportaci|IMMEX|origen|laboral|sindical/i.test(titulo)) continue;
      /* Cada nota necesita URL PROPIA. Antes todas caían en la portada del DOF:
         el mapa por URL conservaba una sola y, tras publicarse esa una vez,
         la deduplicación mataba la fuente institucional mexicana para siempre. */
      const cod = it?.codNota ?? it?.CodNota ?? it?.cod_nota ?? null;
      const url = it?.url ?? (cod ? `https://www.dof.gob.mx/nota_detalle.php?codigo=${cod}&fecha=${hoy().split("-").reverse().join("/")}` : null);
      if (!url) { sinUrl++; continue; }   // sin URL verificable NO se ingiere
      arts.push({ fuente: "DOF", tier: "institucional", pais: "MX", titulo, url, resumen: "", fecha: hoy() });
      n++;
    }
    nota("dof", true, `${n} nota(s) desde ${host}${sinUrl ? ` · ${sinUrl} descartada(s) sin URL propia` : ""}`);
  } catch (e) { nota("dof", false, String(e).slice(0, 100)); }

  // RSS de medios
  for (const m of RSS_MEDIOS) {
    try {
      const xml = await tget(m.url);
      for (const it of parseRSS(xml, 10)) {
        if (!/arancel|T-MEC|TMEC|USMCA|autom|export|import|planta|sindic|laboral|frontera|aduana|Guanajuato|Salamanca|Mazda|manufactur|nearshoring|inversi/i.test(it.titulo + " " + it.resumen)) continue;
        arts.push({ fuente: m.nombre, tier: null, pais: "MX", ...it });
      }
      nota("rss:" + m.nombre, true);
    } catch (e) { nota("rss:" + m.nombre, false, String(e).slice(0, 90)); }
  }

  // GDELT 2.0 — barrido amplio
  for (const [qi, q] of GDELT_CONSULTAS.entries()) {
    try {
      const j: any = await jget(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=10&timespan=3d&format=json`);
      for (const a of j.articles ?? []) arts.push({ fuente: a.domain ?? "GDELT", tier: null, pais: "MX",
        titulo: a.title, url: a.url, resumen: "", fecha: (a.seendate ?? "").slice(0, 4) + "-" + (a.seendate ?? "").slice(4, 6) + "-" + (a.seendate ?? "").slice(6, 8) });
      nota("gdelt:" + (qi + 1), true);
    } catch (e) { nota("gdelt:" + (qi + 1), false, String(e).slice(0, 90)); }
  }

  return arts;
}

/* ==================================================================== *
 * CLASIFICACIÓN POR REGLAS
 *
 * Todo lo de aquí es determinista y auditable: mismas entradas, misma
 * salida, sin modelo. Las reglas se leen de arriba abajo y gana la
 * primera que coincide, así que el orden IMPORTA y está pensado.
 * ==================================================================== */

/* Temas del catálogo. Se evalúan en orden: los más específicos primero,
   porque "arancel a insumos" también contiene la palabra arancel. */
const REGLAS_TEMA: { topic: number; re: RegExp }[] = [
  { topic: 13, re: /rapid response|respuesta r[áa]pida|anexo 31-a|annex 31-a|denegaci[óo]n de derechos|MLRR|RRLM/i },
  { topic: 14, re: /panel|controvers|dispute settlement|revisi[óo]n conjunta|joint review|34\.7|consulta[s]? formal/i },
  { topic: 8,  re: /aduana|customs|IMMEX|PROSEC|regla octava|pedimento|despacho|CBP.*(inspecci|clearance)/i },
  { topic: 7,  re: /secci[óo]n 232|section 232|secci[óo]n 301|section 301|acero|aluminio|steel|aluminum|cuota compensatoria|antidumping/i },
  { topic: 1,  re: /T-MEC|TMEC|USMCA|regla[s]? de origen|rules of origin|contenido regional|VCR|VCL|arancel|tariff|duty/i },
  { topic: 11, re: /energ[íi]a|CFE|Pemex|gas natural|el[ée]ctric|di[ée]sel|combustible|ambiental|emisiones|hidr[íi]co/i },
  { topic: 4,  re: /reforma laboral|sindicat|contrato colectivo|salario m[íi]nimo|CFCRL|libertad sindical|huelga/i },
  /* Seguridad ANTES de infraestructura: un robo de carga en una carretera es un
     problema de seguridad para el cliente, no de obra pública. Con el orden
     inverso, "carretera" se lo llevaba todo. */
  { topic: 5,  re: /robo de|carga robada|extorsi[óo]n|violencia|delictiv|inseguridad|bloqueo carreter|secuestro|asalto/i },
  { topic: 10, re: /carreter|ferrocarril|ferroviari|puerto|Manzanillo|L[áa]zaro C[áa]rdenas|log[íi]stic|infraestructura|tren|autopista|libramiento|aduana fronteriza/i },
  { topic: 5,  re: /seguridad p[úu]blica|seguridad industrial|seguridad de la planta/i },
  { topic: 12, re: /talento|migraci[óo]n|visa|capacitaci[óo]n|escasez de personal|rotaci[óo]n/i },
  { topic: 9,  re: /tipo de cambio|inflaci[óo]n|Banxico|tasa de inter[ée]s|PIB|INPC|peso frente/i },
  { topic: 3,  re: /automotriz|autoparte|armadora|planta|ensamble|Mazda|Nissan|GM|Stellantis|VW|Kia|Audi|BMW|Toyota|Honda/i },
  { topic: 2,  re: /Secretar[íi]a de Econom[íi]a|Sheinbaum|Ebrard|gobierno federal|DOF|decreto|acuerdo publicado/i },
  { topic: 6,  re: /congreso|senado|elecci[óo]n|gobernador|estatal|municipal/i },
];

/* Base jurídica del T-MEC. Un ítem puede invocar varias. */
const REGLAS_MARCO: { key: string; re: RegExp }[] = [
  { key: "anexo_31a",  re: /rapid response|respuesta r[áa]pida|anexo 31-a|annex 31-a|MLRR|RRLM/i },
  { key: "art_34_7",   re: /revisi[óo]n conjunta|joint review|34\.7|pr[óo]rroga del tratado|extension of the agreement/i },
  { key: "cap_4_auto", re: /regla[s]? de origen|rules of origin|contenido regional|VCR|VCL|labor value content|valor de contenido laboral/i },
  { key: "cap_31",     re: /panel|dispute settlement|controversia|consulta[s]? formal/i },
  { key: "cap_23",     re: /derechos laborales|labor rights|libertad sindical|freedom of association|reforma laboral|contrato colectivo|sindicat|huelga|CFCRL|legitimaci[óo]n/i },
  { key: "sec_232",    re: /secci[óo]n 232|section 232/i },
  { key: "sec_301",    re: /secci[óo]n 301|section 301/i },
  { key: "cap_7",      re: /aduana|customs|facilitaci[óo]n comercial|trade facilitation|IMMEX/i },
  { key: "cap_32_10",  re: /econom[íi]a de no mercado|non-market economy|32\.10/i },
];

/* Señales de urgencia. NO producen un rojo automático: elevan el nivel
   sugerido para que quien redacte lo mire primero. */
const RE_URGENTE = /entra en vigor|effective immediately|con efectos a partir|se suspende|suspension of|prohib|imponer un arancel|impose a tariff|plazo vence|deadline|comment period closes|orden ejecutiva|executive order|final rule|determinaci[óo]n final/i;

function clasificar(a: any, tier: string) {
  const txt = `${a.titulo ?? ""} ${a.resumen ?? ""}`;

  let topic = 3;                        // por omisión: industria del sector
  for (const r of REGLAS_TEMA) if (r.re.test(txt)) { topic = r.topic; break; }

  let usmca_ref = REGLAS_MARCO.filter((r) => r.re.test(txt)).map((r) => r.key);

  /* Los temas 1, 4, 13 y 14 EXIGEN base jurídica: es regla editorial y el
     verificador bloquea la publicación sin ella. Si ninguna expresión coincidió,
     se asigna la base canónica del tema en vez de dejar el hueco. */
  if (!usmca_ref.length) {
    const canon: Record<number, string> = { 1: "cap_4_auto", 4: "cap_23", 13: "anexo_31a", 14: "cap_31" };
    if (canon[topic]) usmca_ref = [canon[topic]];
  }

  /* Nivel SUGERIDO, explícitamente no definitivo:
       amarillo → institucional, o urgente con marco jurídico
       verde    → todo lo demás
     El rojo se reserva para quien redacta. Ninguna regla de palabras
     clave debería poder disparar una alerta de WhatsApp a Japón. */
  const urgente = RE_URGENTE.test(txt);
  let nivel_sugerido = "verde";
  if (tier === "institucional") nivel_sugerido = "amarillo";
  if (urgente && (tier === "institucional" || usmca_ref.length)) nivel_sugerido = "amarillo";

  /* Prioridad de lectura 0–100, para ordenar la bandeja. */
  let prioridad = 20;
  if (tier === "institucional") prioridad += 35;
  else if (tier === "prensa_establecida") prioridad += 15;
  if (usmca_ref.length) prioridad += 15;
  if (urgente) prioridad += 20;
  if ([13, 14, 1, 7].includes(topic)) prioridad += 10;
  if (a.vence) prioridad += 10;                     // tiene fecha límite
  prioridad = Math.min(100, prioridad);

  return { topic, usmca_ref, nivel_sugerido, prioridad, urgente };
}

/* ==================================================================== *
 * PISO INSTITUCIONAL
 *
 * Solo se usa si a la hora de correr NO hay edición publicada del día,
 * lo que significa que la tarea de Claude no alcanzó a producirla.
 *
 * Publica hechos institucionales con su TÍTULO Y RESUMEN ORIGINALES.
 * No traduce y no lo disimula: marca cada ítem con `sin_traducir` y la
 * interfaz muestra el aviso. Un boletín que declara «esto viene del
 * Federal Register en inglés y todavía no lo analizamos» es defendible;
 * uno que finge análisis que nadie escribió, no.
 * ==================================================================== */
const AVISO_PISO = {
  es: "Edición institucional automática. Contiene hechos publicados hoy por fuentes oficiales, con su texto original y sin análisis de PRODENSA. El boletín analítico completo se publica en cuanto el equipo lo redacta.",
  en: "Automatic institutional edition. It contains facts published today by official sources, in their original wording and without PRODENSA analysis. The full analytical bulletin is published as soon as the team writes it.",
  ja: "自動生成の公的情報版です。本日公表された官公庁の事実を原文のまま収録しており、PRODENSAによる分析は含まれておりません。完全版は担当者の執筆後に配信いたします。",
  de: "Automatische institutionelle Ausgabe. Sie enthält heute von amtlichen Quellen veröffentlichte Fakten im Originalwortlaut, ohne Analyse von PRODENSA. Das vollständige analytische Briefing folgt, sobald das Team es verfasst hat.",
};
const VENTANA_PISO = {
  es: "Cobertura: fuentes institucionales de EE. UU. y México publicadas hoy",
  en: "Coverage: U.S. and Mexican institutional sources published today",
  ja: "対象：本日公表された米墨の公的情報源",
  de: "Berichtszeitraum: heute veröffentlichte institutionelle Quellen der USA und Mexikos",
};

/* ==================================================================== *
 * HANDLER
 * ==================================================================== */
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

  const salud: { source: string; ok: boolean; detail?: string }[] = [];
  const nota = (s: string, ok: boolean, d = "") => salud.push({ source: "curar:" + s, ok, detail: d });
  const modo = modoAhora();

  try {
    /* ---------- contexto ---------- */
    const { data: reg } = await db.from("source_registry").select("domain,tier");
    const tierDe = (url: string) => {
      let d = "";
      try { d = new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return "no_clasificada"; }
      const hit = (reg ?? []).find((r: any) => d === r.domain || d.endsWith("." + r.domain));
      return hit?.tier ?? "no_clasificada";
    };

    /* URLs ya publicadas y URLs ya en la bandeja: no se repite nada. */
    const { data: pub } = await db.from("news_items").select("url").gte("pub_date", hace(120));
    const { data: inb } = await db.from("curation_inbox").select("url").gte("visto", hace(30));
    const vistas = new Set([...(pub ?? []).map((r: any) => r.url), ...(inb ?? []).map((r: any) => r.url)]);

    /* ---------- 1. ingesta ---------- */
    const arts = await ingesta(nota);
    const porUrl = new Map<string, any>();
    for (const a of arts) if (a.url && !vistas.has(a.url) && !porUrl.has(a.url)) porUrl.set(a.url, a);

    /* ---------- 2. clasificación ---------- */
    const cand = [...porUrl.values()].map((a) => {
      const tier = a.tier === "institucional" ? "institucional" : tierDe(a.url);
      const c = clasificar(a, tier);
      return {
        visto: hoy(), fecha: a.fecha ?? hoy(), fuente: a.fuente ?? "—", url: a.url,
        titulo: String(a.titulo ?? "").slice(0, 400),
        resumen: String(a.resumen ?? "").slice(0, 1200),
        pais: a.pais ?? null, source_tier: tier,
        topic: c.topic, usmca_ref: c.usmca_ref.length ? c.usmca_ref : null,
        nivel_sugerido: c.nivel_sugerido, prioridad: c.prioridad,
        vence: a.vence ?? null, estado: "pendiente", run_mode: modo,
      };
    }).sort((x, y) => y.prioridad - x.prioridad).slice(0, MAX_INBOX);

    /* ---------- 3. bandeja ---------- */
    let enBandeja = 0; const fallosInbox: string[] = [];
    for (let i = 0; i < cand.length; i += 25) {
      const lote = cand.slice(i, i + 25);
      const { error } = await db.from("curation_inbox").insert(lote);
      if (!error) { enBandeja += lote.length; continue; }
      for (const f of lote) {
        const { error: e1 } = await db.from("curation_inbox").insert([f]);
        if (e1) fallosInbox.push(`${String(f.url).slice(0, 50)}: ${e1.message.slice(0, 80)}`);
        else enBandeja++;
      }
    }
    if (fallosInbox.length) salud.push({ source: "curar:bandeja", ok: false, detail: fallosInbox.slice(0, 3).join(" | ") });
    nota("clasificacion", true, `${enBandeja} candidato(s) nuevos de ${arts.length} artículo(s) ingeridos`);

    /* ---------- 4. ¿hace falta el piso institucional? ---------- */
    const { data: edHoy } = await db.from("editions")
      .select("id,status,panorama,markets,tmec,calendar").eq("edition_date", hoy()).maybeSingle();

    /* Se considera "edición real" la que trae panorama: eso solo lo escribe
       quien redacta. Si existe, el piso se retira y no se toca nada más. */
    const hayEdicionReal = !!(edHoy && edHoy.status === "published" && edHoy.panorama);

    let piso: any = { aplicado: false, motivo: "", items: 0 };

    if (hayEdicionReal) {
      /* Limpieza: si el piso había publicado ítems y ya llegó la edición
         redactada, los provisionales se retiran para no duplicar hechos. */
      const { count } = await db.from("news_items")
        .delete({ count: "exact" }).eq("edition_id", edHoy!.id).eq("origen", "piso_institucional");
      piso.motivo = "ya hay edición redactada hoy";
      if (count) { piso.motivo += `; se retiraron ${count} ítem(s) provisionales`; }
      nota("piso", true, piso.motivo);
    } else {
      const inst = cand.filter((c) => c.source_tier === "institucional").slice(0, MAX_PISO);
      if (!inst.length) {
        piso.motivo = "sin hechos institucionales nuevos: no se publica una edición vacía";
        nota("piso", true, piso.motivo);
      } else {
        /* Hereda los bloques de datos de la última edición publicada para no
           nacer con los paneles de mercado vacíos. */
        let heredado: any = {};
        if (!edHoy?.markets || !edHoy?.tmec) {
          const { data: ult } = await db.from("editions").select("markets,tmec,calendar")
            .eq("status", "published").lt("edition_date", hoy())
            .order("edition_date", { ascending: false }).limit(1).maybeSingle();
          if (ult) heredado = {
            markets: edHoy?.markets ?? ult.markets ?? null,
            tmec: edHoy?.tmec ?? ult.tmec ?? null,
            calendar: edHoy?.calendar ?? ult.calendar ?? null,
          };
        }

        const { data: ed, error: eEd } = await db.from("editions").upsert([{
          edition_date: hoy(), status: "published",
          window_es: VENTANA_PISO.es, window_en: VENTANA_PISO.en,
          window_ja: VENTANA_PISO.ja, window_de: VENTANA_PISO.de,
          panorama: null,                       // se deja NULO a propósito
          analysis: null, watch: null,
          aviso: AVISO_PISO,                    // la interfaz lo muestra arriba
          ...heredado,
        }], { onConflict: "edition_date" }).select().single();
        if (eEd) throw new Error("no se pudo escribir la edición del piso: " + eEd.message);

        /* Se reemplazan solo los provisionales anteriores del mismo día. */
        await db.from("news_items").delete().eq("edition_id", ed.id).eq("origen", "piso_institucional");

        const filas = inst.map((c) => ({
          edition_id: ed.id, pub_date: c.fecha, topic: c.topic,
          level: c.nivel_sugerido,              // nunca rojo: lo garantiza clasificar()
          sentiment: "neu", conf: 1,
          state: null, city: null, lat: null, lng: null,
          source: c.fuente, url: c.url,
          /* Texto ORIGINAL en los dos idiomas obligatorios, con la marca de
             que no está traducido. La interfaz lo declara al lector. */
          title: { es: c.titulo, en: c.titulo },
          summary: { es: c.resumen || c.titulo, en: c.resumen || c.titulo },
          sectors: ["automotriz"], impl: null, client_id: null,
          usmca_ref: c.usmca_ref, source_tier: c.source_tier,
          sin_traducir: true, origen: "piso_institucional",
        }));
        let ok = 0; const malos: string[] = [];
        for (const f of filas) {
          const { error } = await db.from("news_items").insert([f]);
          if (error) malos.push(`${String(f.url).slice(0, 50)}: ${error.message.slice(0, 80)}`);
          else ok++;
        }
        piso = { aplicado: true, items: ok, motivo: "no había edición redactada hoy" };
        if (malos.length) salud.push({ source: "curar:piso_insercion", ok: false, detail: malos.slice(0, 3).join(" | ") });
        nota("piso", ok > 0, `publicados ${ok} hecho(s) institucional(es) sin análisis`);

        /* Los que entraron al piso quedan marcados para que quien redacte sepa
           que ya están al aire y solo tenga que analizarlos. */
        await db.from("curation_inbox").update({ estado: "en_piso" })
          .in("url", inst.map((c) => c.url));
      }
    }

    /* ---------- bitácora ---------- */
    await db.from("source_health").insert(salud.map((s) => ({
      run_date: hoy(), run_mode: modo, source: s.source, ok: s.ok,
      detail: s.detail?.slice(0, 300) ?? null,
    })));
    await db.from("admin_audit").insert({
      accion: "pre-curaduría determinista", entidad: "curation_inbox",
      detalle: {
        fecha: hoy(), modo, ingeridos: arts.length, candidatos_nuevos: enBandeja,
        piso: piso, fuentes_con_falla: salud.filter((s) => !s.ok).map((s) => s.source),
      },
    });

    return Response.json({
      fecha: hoy(), modo,
      articulos_ingeridos: arts.length,
      candidatos_nuevos: enBandeja,
      institucionales: cand.filter((c) => c.source_tier === "institucional").length,
      con_base_juridica: cand.filter((c) => c.usmca_ref).length,
      urgentes_detectados: cand.filter((c) => c.prioridad >= 70).length,
      piso_institucional: piso,
      redaccion: hayEdicionReal
        ? "la edición redactada del día ya está publicada"
        : "pendiente: la escribe la tarea programada de Claude leyendo curation_inbox",
      fuentes_con_falla: salud.filter((s) => !s.ok).map((s) => s.source),
      nota: "Esta función NO usa ningún modelo de lenguaje ni llave de IA. No redacta, no traduce y nunca clasifica en rojo por su cuenta.",
    });
  } catch (e) {
    await db.from("source_health").insert([{
      run_date: hoy(), run_mode: modo, source: "curar:fatal", ok: false,
      detail: String(e).slice(0, 300),
    }]);
    return Response.json({ error: String(e).slice(0, 500) }, { status: 500 });
  }
});
