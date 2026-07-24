-- Schema for the sign_links table powering the employee e-signature flow
-- (backend/app/main.py: POST /api/sign-links creates a row right after a
-- contract is generated; the public /api/podepsat/{token}* routes read
-- and update it as the employee reads, signs, and downloads). Run this
-- once in the Supabase SQL editor, same as create_companies_table.sql /
-- create_generation_log_table.sql. Run this file BEFORE (re-)running
-- create_generation_log_table.sql — its generation_stats_by_person view
-- reads from sign_links and will fail to create if this table doesn't
-- exist yet.
--
-- No generated file is ever persisted on disk for this flow — `fields`
-- is a full snapshot of the exact FillRequest payload used to generate
-- the contract, and the contract .docx/.pdf is re-rendered on demand
-- (at read-time, sign-time, and every download) from `fields` +
-- `signature_image` via blank_service.render_signed_contract(). That
-- sidesteps Render's ephemeral filesystem — a redeploy or free-tier
-- restart between "link created" and "employee signs" would otherwise
-- silently orphan the pending link — at the cost of one extra
-- LibreOffice conversion per view/download instead of zero.
--
-- token is the ONLY thing gating access to a public, unauthenticated
-- route — same 128-bit uuid4-hex trust model as the existing
-- /api/download tokens (see blank_service.py's own comment on that).

create table if not exists sign_links (
    token text primary key,
    template_id text not null,
    fields jsonb not null,
    company_name text,
    employee_name text,
    signature_image text,                -- base64 PNG; set once, when the employee signs
    signed_at timestamptz,               -- null until signed
    employee_downloaded_at timestamptz,  -- null until the employee's one-time download; once set, the public routes treat this token as used up
    created_at timestamptz not null default now()
);

create index if not exists sign_links_company_employee_idx on sign_links (company_name, employee_name);

-- Same reasoning/assumption as the other tables here: the backend is the
-- only intended caller (holds SUPABASE_KEY as a server-side secret), and
-- every request is gated either by the site-wide login (admin routes) or
-- by the token itself (public /api/podepsat/* routes) before ever
-- reaching Supabase — so RLS is left disabled here.
-- alter table sign_links enable row level security;

-- A table created via raw SQL (unlike Supabase's Table Editor UI, which
-- grants this automatically) has no privileges for the
-- anon/authenticated/service_role roles PostgREST's API keys map to —
-- without this, PostgREST's schema-cache introspection silently omits
-- it entirely, and every /api/sign-links or /api/podepsat/* call fails
-- with "Could not find the table ... in the schema cache" (PGRST205)
-- even though the table genuinely exists.
grant select, insert, update on sign_links to anon, authenticated, service_role;

-- Run after any of the above changes schema-cache-visible state
-- (CREATE/GRANT) — Supabase's Dashboard SQL editor usually fires this
-- automatically, but it doesn't hurt to be explicit, and it's required
-- if these statements are ever run through a direct psql connection
-- instead.
NOTIFY pgrst, 'reload schema';
