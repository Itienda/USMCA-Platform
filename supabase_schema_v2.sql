-- ============================================================
-- PRODENSA · USMCA Intelligence — Esquema v2 MULTICLIENTE
-- 29-jul-2026 · Ejecutar DESPUÉS de supabase_schema.sql
-- (Supabase Dashboard > SQL Editor > New query > Run)
--
-- Qué agrega sobre el esquema v1:
--   · Catálogos de sectores y temas (los 6 ejes originales son subconjunto)
--   · Matriz de planes con permisos (Básico/Profesional/Corporativo/Enterprise)
--   · Clientes (tenants) con corte propio: sectores, pesos, geografías,
--     umbral de rojo, idiomas, marca blanca, activos y corredores
--   · Multi-tenencia REAL: el corte por cliente se aplica con RLS en el
--     servidor — un cliente Básico no puede leer el acervo completo ni
--     la configuración de otros clientes, aunque abra el código fuente
--   · Flujo editorial (borrador→revisión→publicado), bitácora de alertas,
--     medición de uso, salud de fuentes y watchlist (bloques 2, 3 y 6)
-- ============================================================

-- ---------- 1) CATÁLOGOS ----------
create table if not exists public.sectors (
  id text primary key,              -- "automotriz"
  name jsonb not null,              -- {es,en,ja}
  active boolean not null default false
);
create table if not exists public.topics_catalog (
  id int primary key,               -- 1..N (1–6 = ejes originales)
  name jsonb not null,
  core boolean not null default false
);

insert into public.sectors (id,name,active) values
 ('automotriz','{"es":"Automotriz","en":"Automotive","ja":"自動車"}',true),
 ('electronica','{"es":"Electrónica","en":"Electronics","ja":"電子機器"}',false),
 ('aeroespacial','{"es":"Aeroespacial","en":"Aerospace","ja":"航空宇宙"}',false),
 ('dispositivos_medicos','{"es":"Dispositivos médicos","en":"Medical devices","ja":"医療機器"}',false),
 ('electrodomesticos','{"es":"Electrodomésticos","en":"Home appliances","ja":"家電"}',false),
 ('metalmecanica','{"es":"Metalmecánica","en":"Metal-mechanic","ja":"金属加工"}',false),
 ('agroalimentario','{"es":"Agroalimentario","en":"Agri-food","ja":"農業食品"}',false),
 ('logistica','{"es":"Logística y transporte","en":"Logistics & transport","ja":"物流・運輸"}',false),
 ('energia','{"es":"Energía","en":"Energy","ja":"エネルギー"}',false)
on conflict (id) do nothing;

insert into public.topics_catalog (id,name,core) values
 (1,'{"es":"México–EE. UU. / T-MEC","en":"Mexico–U.S. / USMCA","ja":"米墨関係・USMCA"}',true),
 (2,'{"es":"Gobierno mexicano","en":"Mexican government","ja":"メキシコ政府"}',true),
 (3,'{"es":"Industria del sector","en":"Sector industry","ja":"当該産業"}',true),
 (4,'{"es":"Reformas laborales","en":"Labor reforms","ja":"労働改革"}',true),
 (5,'{"es":"Seguridad","en":"Security","ja":"治安"}',true),
 (6,'{"es":"Política nacional y local","en":"National & local politics","ja":"国政・地方政治"}',true),
 (7,'{"es":"Aranceles a insumos y materias primas","en":"Input tariffs & raw materials","ja":"原材料・部品関税"}',false),
 (8,'{"es":"Aduanas, IMMEX y facilitación","en":"Customs, IMMEX & trade facilitation","ja":"税関・IMMEX・貿易円滑化"}',false),
 (9,'{"es":"Economía y tipo de cambio","en":"Economy & FX","ja":"経済・為替"}',false),
 (10,'{"es":"Infraestructura y logística","en":"Infrastructure & logistics","ja":"インフラ・物流"}',false),
 (11,'{"es":"Energía y regulación ambiental","en":"Energy & environmental regulation","ja":"エネルギー・環境規制"}',false),
 (12,'{"es":"Talento y migración laboral","en":"Talent & labor migration","ja":"人材・労働移動"}',false)
on conflict (id) do nothing;

-- ---------- 2) PLANES (matriz de permisos en UN lugar) ----------
create table if not exists public.plans (
  id text primary key,              -- basico | profesional | corporativo | enterprise
  label text not null,
  price_mxn numeric,
  price_usd numeric,
  users_cap int,                    -- null/0 = sin tope
  features jsonb not null           -- misma forma que const PLANS del HTML
);
insert into public.plans (id,label,price_mxn,price_usd,users_cap,features) values
 ('basico','Básico',4900,null,1,'{"export_pdf":true,"export_csv_json":false,"alerts_email":false,"alerts_wa":false,"archive_days":90,"markets_full":false,"map_assets":false,"whitelabel":false,"watchlist":false,"api_read":false,"user_admin":false,"dedicated":false,"lang_ja":false,"report_builder":false,"proximity_alerts":false,"exec_report":false}'),
 ('profesional','Profesional',7900,null,5,'{"export_pdf":true,"export_csv_json":true,"alerts_email":true,"alerts_wa":false,"archive_days":0,"markets_full":true,"map_assets":true,"whitelabel":false,"watchlist":false,"api_read":false,"user_admin":false,"dedicated":false,"lang_ja":false,"report_builder":true,"proximity_alerts":false,"exec_report":false}'),
 ('corporativo','Corporativo',19900,null,25,'{"export_pdf":true,"export_csv_json":true,"alerts_email":true,"alerts_wa":true,"archive_days":0,"markets_full":true,"map_assets":true,"whitelabel":true,"watchlist":true,"api_read":true,"user_admin":true,"dedicated":false,"lang_ja":false,"report_builder":true,"proximity_alerts":true,"exec_report":false}'),
 ('enterprise','Enterprise',null,4500,null,'{"export_pdf":true,"export_csv_json":true,"alerts_email":true,"alerts_wa":true,"archive_days":0,"markets_full":true,"map_assets":true,"whitelabel":true,"watchlist":true,"api_read":true,"user_admin":true,"dedicated":true,"lang_ja":true,"report_builder":true,"proximity_alerts":true,"exec_report":true}')
on conflict (id) do nothing;

-- ---------- 3) CLIENTES (tenants) ----------
create table if not exists public.clients (
  id text primary key,              -- "mazda"
  name text not null,
  plan text not null references public.plans(id),
  dedicated boolean not null default false,   -- curaduría dedicada (Enterprise)
  sectors text[] not null default '{automotriz}',
  weights jsonb not null default '{"1":10,"2":8,"3":9,"4":7,"5":7,"6":6}',
  geos text[] not null default '{}',
  red_threshold int not null default 70,
  langs text[] not null default '{es,en}',
  tz text not null default 'America/Mexico_City',
  brand jsonb not null default '{"logo":"","color":""}',
  hs_codes text[] not null default '{}',      -- fracciones arancelarias (bloque 5)
  price_override numeric,                     -- ej. Mazda 6,500 USD
  currency text not null default 'MXN' check (currency in ('MXN','USD')),
  annual boolean not null default false,      -- plan anual: paga 10, recibe 12
  indicator_alerts jsonb not null default '[]',  -- umbrales: [{metric,op,value}] (bloque 5.5)
  status text not null default 'activa' check (status in ('trial','activa','suspendida','vencida','cobranza')),
  trial_end date,
  renew_date date,
  created_at timestamptz not null default now()
);
insert into public.clients (id,name,plan,dedicated,sectors,geos,langs,tz,hs_codes,price_override,currency,status)
values ('mazda','MAZDA Motor de México','enterprise',true,'{automotriz}',
        '{Guanajuato,"Ciudad de México","Frontera Norte"}','{es,en,ja}','Asia/Tokyo','{8703}',6500,'USD','activa')
on conflict (id) do nothing;

-- perfiles → cliente (aislamiento por tenant)
alter table public.profiles add column if not exists client_id text references public.clients(id);

-- suscriptores: zona horaria para el horario silencioso de alertas (bloque 2)
alter table public.subscribers add column if not exists tz text not null default 'America/Mexico_City';

create or replace function public.my_client() returns text
language sql stable security definer set search_path = public as
$$ select client_id from profiles where id = auth.uid() $$;

-- ---------- 4) ACTIVOS Y CORREDORES DEL CLIENTE (bloque 4) ----------
create table if not exists public.client_assets (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.clients(id) on delete cascade,
  type text not null check (type in ('planta','proveedor','almacen','cruce','puerto','otro')),
  name text not null,
  lat numeric not null, lng numeric not null,
  radius_km numeric default 25,               -- radio de alerta por proximidad
  created_at timestamptz not null default now()
);
create table if not exists public.client_corridors (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.clients(id) on delete cascade,
  name text not null,
  waypoints jsonb not null,                   -- [[lat,lng],...]
  buffer_km numeric default 15,
  created_at timestamptz not null default now()
);
insert into public.client_assets (client_id,type,name,lat,lng)
select 'mazda','planta','Planta Salamanca',20.5703,-101.1957
where not exists (select 1 from public.client_assets where client_id='mazda' and name='Planta Salamanca');

-- ---------- 5) CONTENIDO v2 ----------
-- Ediciones: flujo editorial + editorial dedicado por cliente
alter table public.editions add column if not exists status text not null default 'published'
  check (status in ('draft','review','published'));
alter table public.editions add column if not exists client_overrides jsonb; -- {clientId:{panorama,analysis,watch}}

-- Noticias: acervo etiquetado + implicación por sector + ítems dedicados
alter table public.news_items add column if not exists sectors text[] not null default '{automotriz}';
alter table public.news_items add column if not exists impl jsonb;           -- {sector:{es,en,ja}, dedicated:{...}}
alter table public.news_items add column if not exists client_id text references public.clients(id);
alter table public.news_items drop constraint if exists news_items_topic_check;
alter table public.news_items add constraint news_items_topic_check
  check (topic between 1 and 99);  -- el catálogo topics_catalog es la fuente de verdad; tope laxo

-- ---------- 6) OPERACIÓN (bloques 2 y 3) ----------
-- Bitácora de entregas de alertas (WhatsApp/correo) — demuestra el SLA
create table if not exists public.alert_deliveries (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text unique not null,       -- (edición|item|destinatario|canal)
  client_id text references public.clients(id),
  edition_date date not null,
  news_url text,
  recipient text not null,                    -- teléfono o email
  channel text not null check (channel in ('whatsapp','email')),
  lang text not null default 'es',
  wamid text,                                 -- id de mensaje de Meta
  status text not null default 'queued'
    check (status in ('queued','sent','delivered','read','failed','escalated','skipped_quiet_hours')),
  error text,
  cost_usd numeric default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists alert_deliveries_client on public.alert_deliveries(client_id, edition_date);

-- Medición de uso por usuario (defiende renovaciones)
create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete set null,
  client_id text references public.clients(id),
  event text not null,                        -- login | read_item | report | alert_received | export
  meta jsonb,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_client on public.usage_events(client_id, created_at);

-- Salud de fuentes del pipeline
create table if not exists public.source_health (
  id uuid primary key default gen_random_uuid(),
  run_date date not null,
  run_mode text not null check (run_mode in ('matutina','mediodia','manual')),
  source text not null,                       -- banxico | fred | inegi | frankfurter | prensa | ...
  ok boolean not null,
  detail text,
  created_at timestamptz not null default now()
);

-- Watchlist de entidades (6.10)
create table if not exists public.watchlists (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.clients(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete cascade,
  entity text not null,
  created_at timestamptz not null default now(),
  unique(client_id, profile_id, entity)
);

-- ---------- 7) RLS: EL CORTE SE APLICA EN EL SERVIDOR ----------
alter table public.sectors enable row level security;
alter table public.topics_catalog enable row level security;
alter table public.plans enable row level security;
alter table public.clients enable row level security;
alter table public.client_assets enable row level security;
alter table public.client_corridors enable row level security;
alter table public.alert_deliveries enable row level security;
alter table public.usage_events enable row level security;
alter table public.source_health enable row level security;
alter table public.watchlists enable row level security;

-- Catálogos y planes: lectura para autenticados; escritura solo admin
create policy "read sectors" on public.sectors for select using (auth.role()='authenticated');
create policy "admin sectors" on public.sectors for all using (public.is_admin());
create policy "read topics" on public.topics_catalog for select using (auth.role()='authenticated');
create policy "admin topics" on public.topics_catalog for all using (public.is_admin());
create policy "read plans" on public.plans for select using (auth.role()='authenticated');
create policy "admin plans" on public.plans for all using (public.is_admin());

-- Clientes: cada quien SU registro; admin todos
create policy "own client" on public.clients for select using (id = public.my_client() or public.is_admin());
create policy "admin clients" on public.clients for all using (public.is_admin());
create policy "own assets" on public.client_assets for select using (client_id = public.my_client() or public.is_admin());
create policy "admin assets" on public.client_assets for all using (public.is_admin());
create policy "own corridors" on public.client_corridors for select using (client_id = public.my_client() or public.is_admin());
create policy "admin corridors" on public.client_corridors for all using (public.is_admin());

-- Ediciones: los clientes solo ven PUBLICADAS (flujo editorial con compuerta)
drop policy if exists "read editions" on public.editions;
create policy "read published editions" on public.editions for select
  using (public.is_admin() or status = 'published');

-- Noticias: corte por cliente EN EL SERVIDOR —
--   ítem del acervo si comparte sector con el cliente, o ítem dedicado propio.
drop policy if exists "read news" on public.news_items;
create policy "read news cut" on public.news_items for select using (
  public.is_admin()
  or (
    exists (select 1 from public.editions e where e.id = news_items.edition_id and e.status = 'published')
    and (
      (news_items.client_id is null and news_items.sectors &&
        (select c.sectors from public.clients c where c.id = public.my_client()))
      or news_items.client_id = public.my_client()
    )
  )
);

-- Entregas/uso/salud: cliente ve lo suyo; admin todo; inserciones vía service role
create policy "own deliveries" on public.alert_deliveries for select using (client_id = public.my_client() or public.is_admin());
create policy "admin deliveries" on public.alert_deliveries for all using (public.is_admin());
create policy "own usage" on public.usage_events for select using (client_id = public.my_client() or public.is_admin());
create policy "insert own usage" on public.usage_events for insert with check (profile_id = auth.uid());
create policy "admin usage" on public.usage_events for all using (public.is_admin());
create policy "admin health" on public.source_health for all using (public.is_admin());
create policy "own watchlist" on public.watchlists for select using (client_id = public.my_client() or public.is_admin());
create policy "manage own watchlist" on public.watchlists for insert with check (profile_id = auth.uid() and client_id = public.my_client());
create policy "delete own watchlist" on public.watchlists for delete using (profile_id = auth.uid());

-- ============================================================
-- NOTAS
-- 1. El pipeline escribe contenido con la SERVICE ROLE KEY vía la API REST
--    (el entorno de corridas no tiene DNS: las escrituras usan el patrón
--    plan→aplicar con el fetch del agente, igual que refrescar_mercados.mjs).
-- 2. El HTML sigue siendo UN archivo: es el cascarón de la interfaz. Con
--    Supabase configurado, los datos llegan por esta API con el corte ya
--    aplicado; los bloques embebidos quedan como modo demo/fallback.
-- 3. client_overrides en editions se filtra en la Edge Function / consulta:
--    al cliente solo se le entrega SU override, nunca el objeto completo.
-- ============================================================
