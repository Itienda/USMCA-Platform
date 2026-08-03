// ============================================================
// PRODENSA · USMCA Intelligence — Edge Function: refresh-markets (v2.3)
// ------------------------------------------------------------
// Sustituye el paso de mercados de las tareas de Claude: corre por
// cron de Supabase (TODOS LOS DÍAS, 8:05 y 12:25 hora centro MX) y actualiza el
// bloque `markets` de la ÚLTIMA edición publicada, directo en la base.
// La app lo muestra al abrir — sin Claude, sin re-deploy de Netlify.
//
// Fuentes (todo HTTP, con las mismas guardas del pipeline local):
//   · Banxico SIE (oportuno + 400 días para sparklines) — verifica el
//     TÍTULO de cada serie antes de publicarla (guarda anti-ID-cambiado)
//   · FRED (Fed funds nivel; PCE e INDPRO como variación anual)
//   · Frankfurter (FX del día + serie 30 días)
//   · CBP Border Wait Times (cruces comerciales)
//   · Banco Mundial (IED y manufactura: MEX/VNM/IND/THA)
//   · OilPriceAPI (ENERGÍA: diésel, gas natural, WTI, Brent)
// Lo que una fuente no entregue se HEREDA del bloque anterior y se
// declara en source_health — nunca se inventa una cifra.
//
// Secretos: BANXICO_TOKEN, FRED_API_KEY, OILPRICE_API_KEY
// Cron: ya programado en CARGAR_EN_SUPABASE_v3.2.sql. Invocable a mano:
//   curl -X POST https://<ref>.supabase.co/functions/v1/refresh-markets \
//        -H "Authorization: Bearer <service_role_key>"
// ============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const BANXICO = [
  { id: "SF61745", clave: "objetivo",   re: /Tasa objetivo/i,                  et: { es: "Tasa objetivo Banxico", en: "Banxico policy rate", ja: "メキシコ中銀政策金利" }, fmt: (v: number) => v.toFixed(2) + "%", fecha: false },
  { id: "SF60648", clave: "tiie28",     re: /TIIE a 28/i,                      et: { es: "TIIE 28 días", en: "TIIE 28-day", ja: "TIIE 28日物" }, fmt: (v: number) => v.toFixed(2) + "%" },
  { id: "SF43936", clave: "cetes28",    re: /Cetes a 28/i,                     et: { es: "Cetes 28 días", en: "Cetes 28-day", ja: "セテス28日物" }, fmt: (v: number) => v.toFixed(2) + "%" },
  { id: "SP30578", clave: "inpc",       re: /Precios al consumidor.*variaci/i, et: { es: "Inflación INPC (anual)", en: "CPI inflation (y/y)", ja: "消費者物価上昇率（前年比）" }, fmt: (v: number) => v.toFixed(2) + "%" },
  { id: "SP74665", clave: "inpc_nosub", re: /No subyacente.*Anual/i,           et: { es: "Inflación no subyacente (anual)", en: "Non-core inflation (y/y)", ja: "非コア物価上昇率（前年比）" }, fmt: (v: number) => v.toFixed(2) + "%" },
  { id: "SF43718", clave: "fix",        re: /FIX/i,                            et: { es: "USD/MXN FIX", en: "USD/MXN FIX", ja: "USD/MXN FIX" }, fmt: (v: number) => v.toFixed(4) },
  { id: "SF43707", clave: "reservas",   re: /Reserva Internacional/i,          et: { es: "Reserva internacional (mdd)", en: "International reserves (USD mn)", ja: "外貨準備（百万ドル）" }, fmt: (v: number) => v.toLocaleString("en-US") },
  { id: "SP68257", clave: "udis",       re: /UDIS/i,                           et: { es: "Valor de la UDI", en: "UDI value", ja: "UDI（物価連動単位）" }, fmt: (v: number) => v.toFixed(6) },
];
const FRED = [
  { serie: "FEDFUNDS", modo: "nivel", et: { es: "Tasa Fed (efectiva)", en: "Fed funds rate (effective)", ja: "FF金利（実効）" } },
  { serie: "PCEPILFE", modo: "anual", et: { es: "PCE subyacente EE. UU. (anual)", en: "U.S. core PCE (y/y)", ja: "米コアPCE（前年比）" } },
  { serie: "INDPRO",   modo: "anual", et: { es: "Producción industrial EE. UU. (anual)", en: "U.S. industrial production (y/y)", ja: "米鉱工業生産（前年比）" } },
];
// ENERGÍA (punto 1 de Isaac, 30-jul-2026): sección alimentada por OilPriceAPI
const OILPRICE = [
  { code: "DIESEL_USD",      key: "diesel", unit: "USD/gal",   name: { es: "Diésel EE. UU.", en: "U.S. diesel", ja: "米ディーゼル" } },
  { code: "NATURAL_GAS_USD", key: "natgas", unit: "USD/MMBtu", name: { es: "Gas natural (Henry Hub)", en: "Natural gas (Henry Hub)", ja: "天然ガス（ヘンリーハブ）" } },
  { code: "WTI_USD",         key: "wti",    unit: "USD/bbl",   name: { es: "Petróleo WTI", en: "WTI crude", ja: "WTI原油" } },
  { code: "BRENT_CRUDE_USD", key: "brent",  unit: "USD/bbl",   name: { es: "Petróleo Brent", en: "Brent crude", ja: "ブレント原油" } },
];
// INEGI · Banco de Indicadores Económicos (BIE) — paquete industrial.
// FORMATO CORRECTO (doc oficial): .../INDICATOR/{ids}/es/{AREA}/{recientes}/{fuente}/2.0/{token}?type=json
// El bug de la v1 era AREA="0700" (no es nacional) y recientes=false (serie completa):
// lo correcto es AREA="00" (Estados Unidos Mexicanos) y "true" (dato más reciente).
// Cada indicador se VERIFICA contra el título que devuelve el catálogo CL_INDICATOR:
// si INEGI cambia una clave, la serie se descarta con aviso en vez de publicar el dato
// equivocado bajo la etiqueta correcta (misma guarda que Banxico).
const INEGI_AREA = "00";
const INEGI_FUENTE = "BIE";
const INEGI = [
  { id: "444612", clave: "desempleo",  re: /desocupaci|desempleo/i,                    et: { es: "Tasa de desocupación", en: "Unemployment rate", ja: "失業率" }, suf: "%" },
  { id: "496150", clave: "igae",       re: /IGAE|actividad econ[oó]mica/i,             et: { es: "IGAE (actividad económica)", en: "IGAE (economic activity)", ja: "IGAE（総合経済活動指数）" }, suf: "" },
  { id: "383152", clave: "manufactura",re: /manufactur|industrial/i,                   et: { es: "Producción manufacturera", en: "Manufacturing output", ja: "製造業生産" }, suf: "" },
  { id: "133183", clave: "expo_manu",  re: /exportaci.*manufactur|manufactur.*exporta/i, et: { es: "Exportaciones manufactureras (mdd)", en: "Manufacturing exports (USD mn)", ja: "製造業輸出（百万ドル）" }, suf: "" },
];

const CBP_PORTS = [
  { re: /Laredo.*World Trade/i,       name: "Nuevo Laredo — World Trade Bridge", lat: 27.6006, lng: -99.5384 },
  { re: /Colombia/i,                  name: "Colombia — Solidarity Bridge",      lat: 27.7096, lng: -99.7561 },
  { re: /Pharr/i,                     name: "Reynosa — Pharr Int'l Bridge",      lat: 26.0663, lng: -98.2044 },
  { re: /Ysleta|Zaragoza/i,           name: "Cd. Juárez — Ysleta/Zaragoza",      lat: 31.6707, lng: -106.3358 },
  { re: /Otay Mesa(?! East)/i,        name: "Tijuana — Otay Mesa",               lat: 32.5496, lng: -116.9386 },
  { re: /Eagle Pass.*(II|2|Camino)/i, name: "Piedras Negras — Eagle Pass II",    lat: 28.7031, lng: -100.5117 },
];
const WB = [
  { ind: "BX.KLT.DINV.CD.WD", et: { es: "IED neta (USD)", en: "Net FDI inflows (USD)", ja: "対内直接投資（純額）" }, fmt: (v: number) => (v / 1e9).toFixed(1) + " mmd" },
  { ind: "NV.IND.MANF.ZS",    et: { es: "Manufactura (% del PIB)", en: "Manufacturing (% of GDP)", ja: "製造業（GDP比）" }, fmt: (v: number) => v.toFixed(1) + "%" },
];

const hoy = () => new Date().toISOString().slice(0, 10);
const hace = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
async function jget(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  /* SEGURIDAD (hallazgo de la revisión full-stack, 31-jul-2026):
     solo el cron (service_role) o un admin pueden dispararla. Antes, cualquier
     usuario autenticado podía invocarla en bucle y quemar cuota de APIs. */
  const auth = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const db = createClient(Deno.env.get("SUPABASE_URL")!, SRK);
  if (auth !== SRK) {
    const { data: u } = await db.auth.getUser(auth);
    if (!u?.user) return Response.json({ error: "no autorizado" }, { status: 401 });
    const { data: p } = await db.from("profiles").select("role").eq("id", u.user.id).maybeSingle();
    if (p?.role !== "admin") return Response.json({ error: "requiere rol admin" }, { status: 403 });
  }
  const BX = Deno.env.get("BANXICO_TOKEN"), FR = Deno.env.get("FRED_API_KEY"), OP = Deno.env.get("OILPRICE_API_KEY");
  const salud: { source: string; ok: boolean; detail?: string }[] = [];
  const nota = (source: string, ok: boolean, detail = "") => salud.push({ source, ok, detail });

  // edición destino: la última publicada
  const { data: ed, error: e0 } = await db.from("editions")
    .select("id,edition_date,markets").eq("status", "published")
    .order("edition_date", { ascending: false }).limit(1).maybeSingle();
  if (e0 || !ed) return Response.json({ error: "sin edición publicada destino: " + (e0?.message ?? "vacío") }, { status: 500 });
  const prev = ed.markets ?? {};

  // ---- Banxico (oportuno + histórico para sparklines) ----
  const macro: any[] = []; const spark: Record<string, number[]> = {};
  const num = (x: string) => Number(String(x).replace(/,/g, ""));
  if (BX) {
    const ids = BANXICO.map((s) => s.id).join(",");
    try {
      const h = await jget(`https://www.banxico.org.mx/SieAPIRest/service/v1/series/${ids}/datos/${hace(400)}/${hoy()}?token=${BX}`);
      for (const s of h?.bmx?.series ?? []) {
        const cat = BANXICO.find((b) => b.id === s.idSerie);
        if (cat && Array.isArray(s.datos)) {
          const vals = s.datos.map((d: any) => num(d.dato)).filter((v: number) => !isNaN(v));
          if (vals.length >= 2) spark[cat.clave] = vals.slice(-24);
        }
      }
      const j = await jget(`https://www.banxico.org.mx/SieAPIRest/service/v1/series/${ids}/datos/oportuno?token=${BX}`);
      for (const cat of BANXICO) {
        const s = (j?.bmx?.series ?? []).find((x: any) => x.idSerie === cat.id);
        const d = s?.datos?.[0];
        if (!s || !d) { nota("banxico:" + cat.clave, false, "sin dato"); continue; }
        if (!cat.re.test(s.titulo ?? "")) { nota("banxico:" + cat.clave, false, `título inesperado: ${s.titulo}`); continue; }
        const v = num(d.dato); if (isNaN(v)) { nota("banxico:" + cat.clave, false, "dato no numérico"); continue; }
        const f = (d.fecha ?? "").split("/").reverse().join("-");
        const et: any = {}; for (const l of ["es", "en", "ja"]) et[l] = cat.fecha === false ? (cat.et as any)[l] : `${(cat.et as any)[l]} (${f})`;
        const item: any = { name: et, v: cat.fmt(v) };
        if (spark[cat.clave]) item.spark = spark[cat.clave];
        macro.push(item);
      }
      nota("banxico", true);
    } catch (e) { nota("banxico", false, String(e)); }
  } else nota("banxico", false, "BANXICO_TOKEN sin configurar");

  // ---- FRED ----
  if (FR) {
    for (const s of FRED) {
      try {
        const j = await jget(`https://api.stlouisfed.org/fred/series/observations?series_id=${s.serie}&api_key=${FR}&file_type=json&sort_order=desc&limit=${s.modo === "anual" ? 13 : 2}`);
        const obs = (j.observations ?? []).filter((o: any) => o.value !== ".");
        if (!obs.length) throw new Error("sin observaciones");
        let v: number, f = obs[0].date;
        if (s.modo === "anual") {
          const a = +obs[0].value, b = +obs[12]?.value;
          if (!b) throw new Error("sin base 12m"); v = (a / b - 1) * 100;
        } else v = +obs[0].value;
        const et: any = {}; for (const l of ["es", "en", "ja"]) et[l] = `${(s.et as any)[l]} (${f})`;
        macro.push({ name: et, v: v.toFixed(2) + "%" });
        nota("fred:" + s.serie, true);
      } catch (e) { nota("fred:" + s.serie, false, String(e)); }
    }
  } else nota("fred", false, "FRED_API_KEY sin configurar");

  // ---- INEGI (paquete industrial, con verificación de título) ----
  const ING = Deno.env.get("INEGI_TOKEN");
  if (ING) {
    for (const s of INEGI) {
      try {
        const base = "https://www.inegi.org.mx/app/api/indicadores/desarrolladores/jsonxml";
        // a) título oficial del indicador (catálogo) — la guarda anti-ID-cambiado
        let titulo = "";
        try {
          const meta = await jget(`${base}/CL_INDICATOR/${s.id}/es/${INEGI_FUENTE}/2.0/${ING}?type=json`);
          titulo = meta?.CODE?.[0]?.Description ?? "";
        } catch { /* si el catálogo falla, se valida solo con el dato */ }
        if (titulo && !s.re.test(titulo)) { nota("inegi:" + s.clave, false, `título inesperado: ${titulo.slice(0, 80)}`); continue; }
        // b) dato más reciente, área nacional
        const j = await jget(`${base}/INDICATOR/${s.id}/es/${INEGI_AREA}/true/${INEGI_FUENTE}/2.0/${ING}?type=json`);
        const obs = j?.Series?.[0]?.OBSERVATIONS?.[0];
        if (!obs || obs.OBS_VALUE == null) throw new Error("sin observación");
        const v = Number(obs.OBS_VALUE); if (isNaN(v)) throw new Error("dato no numérico");
        const per = String(obs.TIME_PERIOD ?? "");
        const et: any = {}; for (const l of ["es", "en", "ja"]) et[l] = `${(s.et as any)[l]}${per ? " (" + per + ")" : ""}`;
        macro.push({ name: et, v: (Math.abs(v) >= 1000 ? v.toLocaleString("en-US") : v.toFixed(2)) + s.suf });
        nota("inegi:" + s.clave, true, titulo.slice(0, 60));
      } catch (e) { nota("inegi:" + s.clave, false, String(e).slice(0, 120)); }
    }
  } else nota("inegi", false, "INEGI_TOKEN sin configurar");

  // ---- Frankfurter (FX) ----
  let fx_fallback = prev.fx_fallback ?? {}, fx_series = prev.fx_series;
  try {
    const j = await jget("https://api.frankfurter.dev/v1/latest?base=USD&symbols=MXN,JPY");
    fx_fallback = { usdmxn: j.rates.MXN, usdjpy: j.rates.JPY };
    const h = await jget(`https://api.frankfurter.dev/v1/${hace(30)}..${hoy()}?base=USD&symbols=MXN,JPY`);
    const labels = Object.keys(h.rates ?? {});
    if (labels.length) fx_series = { source: "Frankfurter (referencia BCE)", start: labels[0], end: labels[labels.length - 1],
      labels, mxn: labels.map((k) => h.rates[k].MXN), jpy: labels.map((k) => h.rates[k].JPY) };
    nota("frankfurter", true);
  } catch (e) { nota("frankfurter", false, String(e)); }

  // ---- OilPriceAPI (ENERGÍA) ----
  let commodities = prev.commodities;
  if (OP) {
    const items: any[] = [];
    for (const c of OILPRICE) {
      try {
        const j = await jget(`https://api.oilpriceapi.com/v1/prices/latest?by_code=${c.code}`, { Authorization: `Token ${OP}` });
        const p = j?.data?.price;
        if (p == null) throw new Error("sin precio");
        items.push({ key: c.key, name: c.name, v: Number(p).toFixed(2), usd: Number(p), unit: c.unit,
          source: "OilPriceAPI", date: (j.data.created_at ?? "").slice(0, 10) || hoy() });
        nota("oilprice:" + c.code, true);
      } catch (e) { nota("oilprice:" + c.code, false, String(e)); }
    }
    if (items.length) commodities = { sector: "automotriz", updated: hoy(), items };
  } else nota("oilprice", false, "OILPRICE_API_KEY sin configurar — sección de energía hereda/declara sin dato");

  // ---- CBP ----
  let border_waits = prev.border_waits;
  try {
    const j = await jget("https://bwt.cbp.gov/api/bwtnew");
    const crossings = CBP_PORTS.map((p) => {
      const row = (j as any[]).find((x) => p.re.test(`${x.port_name ?? ""} ${x.crossing_name ?? ""}`));
      const d = row?.commercial_vehicle_lanes?.standard_lanes?.delay_minutes;
      return { name: p.name, lat: p.lat, lng: p.lng, commercial_min: d === "" || d == null ? null : +d,
        lanes: row?.commercial_vehicle_lanes?.standard_lanes?.lanes_open ? `${row.commercial_vehicle_lanes.standard_lanes.lanes_open} carril(es)` : undefined };
    });
    border_waits = { updated: hoy(), source: "CBP Border Wait Times", crossings };
    nota("cbp", true);
  } catch (e) { nota("cbp", false, String(e)); }

  // ---- Banco Mundial ----
  let nearshoring = prev.nearshoring;
  try {
    const indicators: any[] = [];
    for (const w of WB) {
      const j = await jget(`https://api.worldbank.org/v2/country/MEX;VNM;IND;THA/indicator/${w.ind}?format=json&mrnev=1&per_page=20`);
      const rows = Array.isArray(j) ? j[1] : null;
      const countries: Record<string, string> = {}; let period = "";
      for (const r of rows ?? []) {
        const iso = r.countryiso3code; if (iso && r.value != null && !(iso in countries)) { countries[iso] = w.fmt(r.value); period ||= r.date; }
      }
      if (Object.keys(countries).length) indicators.push({ name: w.et, countries, period });
    }
    if (indicators.length) { nearshoring = { updated: hoy(), source: "Banco Mundial (API abierta)", indicators }; nota("worldbank", true); }
    else nota("worldbank", false, "sin filas");
  } catch (e) { nota("worldbank", false, String(e)); }

  // ---- ensamblar y escribir (lo faltante se hereda DECLARADO) ----
  const markets = {
    updated: hoy(),
    fx_fallback, fx_series,
    indices: [],                            // RETIRADOS 31-jul-2026: sin fuente automática, envejecían sin aviso
    macro: macro.length ? macro : (prev.macro ?? []),
    border_waits, commodities,
    trade_flows: prev.trade_flows,          // semanal: lo sube la corrida editorial
    nearshoring,
  };
  const { error: eW } = await db.from("editions").update({ markets }).eq("id", ed.id);
  if (eW) return Response.json({ error: "no se pudo escribir markets: " + eW.message }, { status: 500 });

  const fallas = salud.filter((s) => !s.ok);
  await db.from("source_health").insert(salud.map((s) => ({ run_date: hoy(), run_mode: "manual", source: s.source, ok: s.ok, detail: s.detail?.slice(0, 300) ?? null })));
  return Response.json({
    edicion: ed.edition_date, indicadores: macro.length,
    inegi: salud.filter((s) => s.source.startsWith("inegi:") && s.ok).map((s) => s.source.slice(6)),
    energia: commodities?.updated === hoy() ? commodities.items.map((i: any) => `${i.key}=${i.v}`) : "heredada/sin dato",
    cruces_cbp: border_waits?.updated === hoy() ? border_waits.crossings.filter((c: any) => c.commercial_min != null).length : "heredado",
    fuentes_con_falla: fallas.map((f) => `${f.source}: ${f.detail}`),
  });
});
