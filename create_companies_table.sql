-- Schema for the shared "companies" table used by backend/app/main.py
-- (GET/POST/PUT/DELETE /api/companies). Run this once in the Supabase
-- SQL editor when setting up a new project.
--
-- This file didn't exist in the repository even though the app has
-- depended on it since the companies feature was added — reconstructed
-- from how main.py actually queries the table (see CompanyIn, and the
-- id/name/ico/dic/address/representative fields it reads and writes).
-- If your real Supabase table differs from this, the code is the
-- source of truth for what it *requires*; this file exists so the
-- schema can be reproduced/audited instead of only existing by
-- Dashboard-clicking.

create table if not exists companies (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    ico text,
    dic text,
    address text,
    representative text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- main.py sorts with ?order=name.asc on every GET /api/companies.
create index if not exists companies_name_idx on companies (name);

-- Keeps updated_at accurate on every edit — not read by the backend
-- today, but useful for auditing who/what changed a shared record.
create or replace function set_companies_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists companies_set_updated_at on companies;
create trigger companies_set_updated_at
    before update on companies
    for each row
    execute function set_companies_updated_at();

-- RLS: enabled, service_role only. The backend is the only intended
-- caller of this table (SUPABASE_KEY is a server-side secret, and every
-- request is gated behind the site-wide login before ever reaching
-- Supabase) — but that assumption alone isn't a real control if
-- SUPABASE_KEY itself is (or ever becomes) the public "anon"/publishable
-- key rather than "secret"/service_role: that key is *designed* to be
-- safe to expose client-side, so without RLS it grants full read/write
-- to anyone who has the project URL and that key, site login or not.
-- This policy is the actual enforcement; the secret key on the backend
-- is what lets it keep working.
--
-- service_role already bypasses RLS at the Postgres role level
-- regardless of policy — that's the defining property of the role, not
-- something a policy grants it — so this policy's real effect is
-- denying every OTHER role (anon, authenticated) the moment RLS turns
-- on, since none of them match `to service_role`. Written explicitly
-- anyway rather than left implicit, so the intent is visible in the
-- schema itself.
alter table companies enable row level security;

drop policy if exists "service_role_only" on companies;
create policy "service_role_only" on companies
    for all
    to service_role
    using (true)
    with check (true);

-- revoke first — belt-and-suspenders against whatever broader grant
-- might already exist on the live project (e.g. auto-granted by the
-- Table Editor UI, or from before this file existed at all) that this
-- script alone wouldn't otherwise know to remove.
revoke all on companies from anon, authenticated;
grant select, insert, update, delete on companies to service_role;

-- Run after any of the above changes schema-cache-visible state
-- (CREATE/GRANT/REVOKE/policy) — Supabase's Dashboard SQL editor
-- usually fires this automatically, but it doesn't hurt to be explicit,
-- and it's required if these statements are ever run through a direct
-- psql connection instead.
NOTIFY pgrst, 'reload schema';
