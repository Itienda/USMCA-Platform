-- ============================================================
-- PRODENSA · USMCA Intelligence Platform — Esquema Supabase
-- Ejecutar en: Supabase Dashboard > SQL Editor > New query > Run
-- Plan gratuito: 500 MB de base, 50,000 usuarios auth — suficiente
-- ============================================================

-- 1) PERFILES (extiende auth.users; se crea solo al registrar usuario)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  company text,
  role text not null default 'client' check (role in ('client','admin')),
  lang text not null default 'es' check (lang in ('es','en','ja')),
  created_at timestamptz not null default now()
);

-- 2) MEMBRESÍAS (trial 7 días / mensual $6,500)
create table if not exists public.memberships (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete cascade,
  company text not null,
  access_code text unique not null,
  plan text not null check (plan in ('trial','mensual')),
  price_usd numeric not null default 6500,
  start_date date not null default current_date,
  status text not null default 'activa' check (status in ('activa','suspendida','vencida')),
  topics int[] not null default '{1,2,3,4,5,6}',
  created_at timestamptz not null default now()
);

-- 3) SUSCRIPTORES del reporte diario / alertas
create table if not exists public.subscribers (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid references public.memberships(id) on delete cascade,
  name text not null,
  email text,
  whatsapp text,
  lang text not null default 'es',
  channels text[] not null default '{email}',
  callmebot_key text,
  created_at timestamptz not null default now()
);

-- 4) EDICIONES (una por corrida del pipeline)
create table if not exists public.editions (
  id uuid primary key default gen_random_uuid(),
  edition_date date unique not null,
  window_es text, window_en text, window_ja text,
  panorama jsonb,   -- {es,en,ja}
  analysis jsonb,   -- {es,en,ja}
  watch jsonb,      -- {es:[],en:[],ja:[]}
  markets jsonb,    -- {updated, fx_fallback, indices, macro}
  calendar jsonb,
  created_at timestamptz not null default now()
);

-- 5) NOTICIAS
create table if not exists public.news_items (
  id uuid primary key default gen_random_uuid(),
  edition_id uuid references public.editions(id) on delete cascade,
  pub_date date not null,
  topic int not null check (topic between 1 and 6),
  level text not null check (level in ('rojo','amarillo','verde')),
  sentiment text not null check (sentiment in ('pos','neu','neg')),
  conf int not null default 1,
  state text, city text, lat numeric, lng numeric,
  source text not null, url text not null,
  title jsonb not null,   -- {es,en,ja}
  summary jsonb not null, -- {es,en,ja}
  created_at timestamptz not null default now()
);

-- 6) FEEDBACK por nota (calibración del semáforo)
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  news_id uuid references public.news_items(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete cascade,
  vote int not null check (vote in (1,-1)),
  created_at timestamptz not null default now(),
  unique(news_id, profile_id)
);

-- 7) BITÁCORA de administración
create table if not exists public.admin_log (
  id uuid primary key default gen_random_uuid(),
  actor uuid references public.profiles(id),
  event text not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- RLS (Row Level Security)
-- ============================================================
alter table public.profiles enable row level security;
alter table public.memberships enable row level security;
alter table public.subscribers enable row level security;
alter table public.editions enable row level security;
alter table public.news_items enable row level security;
alter table public.feedback enable row level security;
alter table public.admin_log enable row level security;

-- helper: ¿el usuario actual es admin?
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as
$$ select exists(select 1 from profiles where id = auth.uid() and role = 'admin') $$;

-- Perfiles: cada quien ve/edita el suyo; admin ve todos
create policy "own profile" on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "update own profile" on public.profiles for update using (id = auth.uid());

-- Membresías: el cliente ve la suya; admin todo
create policy "member reads own" on public.memberships for select using (profile_id = auth.uid() or public.is_admin());
create policy "admin manages memberships" on public.memberships for all using (public.is_admin());

-- Suscriptores: dueño de la membresía o admin
create policy "subs by membership" on public.subscribers for select
  using (public.is_admin() or membership_id in (select id from memberships where profile_id = auth.uid()));
create policy "admin manages subs" on public.subscribers for all using (public.is_admin());
create policy "self register" on public.subscribers for insert with check (true);

-- Ediciones y noticias: lectura para todo usuario autenticado; escritura solo admin/service
create policy "read editions" on public.editions for select using (auth.role() = 'authenticated');
create policy "admin writes editions" on public.editions for all using (public.is_admin());
create policy "read news" on public.news_items for select using (auth.role() = 'authenticated');
create policy "admin writes news" on public.news_items for all using (public.is_admin());

-- Feedback: cada usuario inserta/actualiza el suyo; admin lee todo
create policy "vote own" on public.feedback for insert with check (profile_id = auth.uid());
create policy "read own votes" on public.feedback for select using (profile_id = auth.uid() or public.is_admin());

-- Bitácora: solo admin
create policy "admin log" on public.admin_log for all using (public.is_admin());

-- ============================================================
-- Trigger: crear perfil automáticamente al registrarse un usuario
-- ============================================================
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.email),
          case when new.email like '%@prodensa.com' then 'admin' else 'client' end);
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- NOTAS
-- 1. El pipeline diario escribe ediciones/noticias con la SERVICE ROLE KEY
--    (Settings > API > service_role) — NUNCA pongas esa llave en el HTML.
-- 2. En el HTML solo va la ANON KEY (pública por diseño; RLS protege los datos).
-- 3. Usuarios @prodensa.com reciben rol admin automáticamente (trigger).
-- ============================================================
