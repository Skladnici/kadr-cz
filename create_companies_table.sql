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

-- The backend is the only intended caller of this table (it holds
-- SUPABASE_KEY as a server-side secret and gates every request behind
-- its own site-wide login before ever reaching Supabase) — RLS is left
-- disabled here on that assumption. If SUPABASE_KEY in your deployment
-- is the public "anon" key rather than "service_role", enable RLS and
-- add a policy restricting access, since an anon key is otherwise
-- readable/usable by anyone who extracts it from the deployed backend.
-- alter table companies enable row level security;
