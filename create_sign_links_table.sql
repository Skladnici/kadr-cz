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
--
-- A row's lifetime, whichever ends it first (see main.py's own comment
-- on _fetch_sign_link/_cleanup_expired_sign_links for the full reasoning):
--   1. The admin downloads it — deleted right after serving the file.
--   2. 24h since signed_at, once signed.
--   3. 24h since created_at, if never signed.
-- No separate scheduler for #2/#3 — checked lazily whenever a token is
-- looked up, plus an opportunistic sweep on link creation and on every
-- poll of the corner "recently signed" notifier.

create table if not exists sign_links (
    token text primary key,
    template_id text not null,
    fields jsonb not null,
    company_name text,
    employee_name text,
    signature_image text,                -- base64 PNG; set once, when the employee signs
    signed_at timestamptz,               -- null until signed
    employee_downloaded_at timestamptz,  -- informational only (see main.py) — does not gate access; the employee can re-download until the row itself expires or the admin downloads it
    created_at timestamptz not null default now()
);

create index if not exists sign_links_company_employee_idx on sign_links (company_name, employee_name);

-- RLS: enabled, service_role only (see create_companies_table.sql's own
-- RLS section for the full reasoning). This table is the most sensitive
-- of the three — it holds `fields` (the complete contract payload,
-- including the employee's ID/visa numbers and address) and, once
-- signed, a base64 signature image — so a leaked publishable key
-- reaching it directly would be worse than for companies/generation_log.
-- The token-as-auth model on /api/podepsat/* (see the file header above)
-- is a site-perimeter control, not a database one; this policy is what
-- actually stops a direct Supabase REST call that skips the backend
-- entirely, regardless of whether it presents a valid token.
--
-- service_role already bypasses RLS at the Postgres role level
-- regardless of policy, so this policy's real effect is denying every
-- OTHER role (anon, authenticated) the moment RLS turns on.
alter table sign_links enable row level security;

drop policy if exists "service_role_only" on sign_links;
create policy "service_role_only" on sign_links
    for all
    to service_role
    using (true)
    with check (true);

-- A table created via raw SQL (unlike Supabase's Table Editor UI, which
-- grants this automatically) has no privileges for the
-- anon/authenticated/service_role roles PostgREST's API keys map to —
-- without this, PostgREST's schema-cache introspection silently omits
-- it entirely, and every /api/sign-links or /api/podepsat/* call fails
-- with "Could not find the table ... in the schema cache" (PGRST205)
-- even though the table genuinely exists. delete is required too —
-- both the admin's one-time download and the 24h TTL sweep issue DELETEs.
--
-- revoke first — belt-and-suspenders against whatever broader grant
-- might already exist on the live project that this script alone
-- wouldn't otherwise know to remove.
revoke all on sign_links from anon, authenticated;
grant select, insert, update, delete on sign_links to service_role;

-- Run after any of the above changes schema-cache-visible state
-- (CREATE/GRANT/REVOKE/policy) — Supabase's Dashboard SQL editor
-- usually fires this automatically, but it doesn't hurt to be explicit,
-- and it's required if these statements are ever run through a direct
-- psql connection instead.
NOTIFY pgrst, 'reload schema';
