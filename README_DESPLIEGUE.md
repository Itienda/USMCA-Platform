# Despliegue — PRODENSA USMCA Intelligence Platform
### Supabase (auth + base de datos) + Netlify (hosting) · Costo: $0

---

## PARTE 1 — Supabase (15 min)

1. **Crear proyecto:** entra a [supabase.com](https://supabase.com) → Sign up (gratis, con tu correo @prodensa.com) → **New project**. Nombre: `usmca-intelligence`, región: `East US (North Virginia)` (la más cercana a MX), genera una contraseña de base de datos y guárdala.
2. **Crear las tablas:** en el menú lateral → **SQL Editor** → **New query** → pega TODO el contenido de `supabase_schema.sql` → **Run**. Debe decir "Success". Esto crea perfiles, membresías, suscriptores, ediciones, noticias, feedback y bitácora, con seguridad por fila (RLS) ya configurada.
3. **Activar auth por email:** **Authentication → Providers → Email**: activado por defecto. Recomendado para beta: desactiva "Confirm email" (Authentication → Providers → Email → Confirm email OFF) para dar de alta usuarios sin flujo de correo.
4. **Crear usuarios:** **Authentication → Users → Add user**: crea el tuyo (`itiendac@prodensa.com` — será admin automáticamente por el trigger) y el del contacto de MAZDA. Asigna contraseñas temporales.
5. **Copiar llaves:** **Settings → API**: copia `Project URL` y `anon public key`.
   ⚠️ La `service_role key` NUNCA va en el HTML — esa es solo para el pipeline (fase 2).
6. **Conectar la app:** abre `index.html`, busca al inicio del `<script>`:
   ```js
   const SUPABASE_URL = "";       // ← pega aquí el Project URL
   const SUPABASE_ANON_KEY = "";  // ← pega aquí la anon key
   ```
   Guarda. La pantalla de login cambia sola a email/contraseña.

## PARTE 2 — Netlify (5 min)

**Opción A — Drag & drop (la más rápida):**
1. Entra a [app.netlify.com](https://app.netlify.com) → Sign up gratis.
2. En **Sites**, arrastra la carpeta `USMCA_Deploy` completa a la zona "Drag and drop your site".
3. Netlify publica en segundos una URL tipo `https://usmca-intelligence.netlify.app`.
4. **Site configuration → Change site name** → ponle `prodensa-usmca` (URL: `prodensa-usmca.netlify.app`).

**Opción B — Desde GitHub (para actualizaciones automáticas):**
1. Crea repo privado `usmca-platform` en GitHub y sube `index.html` + `netlify.toml`.
2. Netlify → **Add new site → Import an existing project** → conecta el repo.
3. Cada push a `main` re-publica solo. El pipeline diario puede hacer commit del HTML actualizado (fase 2 con GitHub Actions, también gratis).

**Dominio propio (opcional):** Domain management → Add domain → `usmca.prodensa.com` → agrega el CNAME que Netlify te indique en tu DNS. HTTPS automático.

## PARTE 3 — Verificación

1. Abre la URL de Netlify → debe aparecer el login con logo PRODENSA.
2. Entra con tu usuario de Supabase → correo @prodensa.com ve el panel Admin.
3. Revisa: ticker de mercados arriba, FX en vivo en Mercados, reloj MX/Japón.
4. Prueba en el celular — la plataforma es responsiva.

## Notas de operación

- **Actualización diaria del contenido:** en beta, el pipeline de Cowork actualiza `index.html`; re-arrastra la carpeta a Netlify (10 seg) o usa la Opción B para que sea automático vía git.
- **Límites gratuitos:** Netlify 100 GB/mes de ancho de banda; Supabase 500 MB DB + 50k usuarios — sobra para docenas de clientes.
- **Los datos en localStorage** (favoritos, suscriptores, membresías demo) viven por navegador. Con Supabase conectado, el auth es real; la migración completa de datos a Postgres es fase 2 (las tablas ya están listas y el SQL incluye las políticas de seguridad).
- **Códigos demo:** mientras no configures Supabase, siguen funcionando MAZDA2026 y PRODENSA-ADMIN.
