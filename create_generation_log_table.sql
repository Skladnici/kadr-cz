-- Schema for the generation_log table + generation_stats view used by
-- backend/app/main.py: POST /api/fill writes one row here on every
-- successful document generation; GET /api/stats reads generation_stats.
-- Run this once in the Supabase SQL editor, same as
-- create_companies_table.sql.
--
-- company_name is a plain text snapshot (the name at the moment of
-- generation), not a foreign key to companies.id — renaming or deleting
-- a company later must not retroactively change or orphan historical
-- stats. No employee/personal data is stored here — only company name,
-- document type, and a timestamp.

create table if not exists generation_log (
    id uuid primary key default gen_random_uuid(),
    company_name text,
    document_type text not null,
    created_at timestamptz not null default now()
);

create index if not exists generation_log_company_name_idx on generation_log (company_name);
create index if not exists generation_log_created_at_idx on generation_log (created_at);

-- /api/stats reads from this view rather than pulling every row into
-- Python to aggregate — PostgREST's auto-generated REST API has no
-- query-string syntax for GROUP BY/count(), so the aggregation lives
-- here instead. coalesce() folds "no company selected" (NULL) into the
-- same "Bez firmy" bucket the frontend widget shows, rather than a
-- separate `null`-keyed row alongside a possible real company literally
-- named "Bez firmy" (accepted as a vanishingly unlikely name clash).
create or replace view generation_stats as
select
    coalesce(company_name, 'Bez firmy') as company_name,
    count(*) as document_count
from generation_log
group by coalesce(company_name, 'Bez firmy')
order by document_count desc;

-- Same reasoning/assumption as create_companies_table.sql: the backend
-- is the only intended caller (holds SUPABASE_KEY as a server-side
-- secret, gates every request behind its own site-wide login before
-- ever reaching Supabase), so RLS is left disabled here.
-- alter table generation_log enable row level security;

-- A table/view created via raw SQL (unlike Supabase's Table Editor UI,
-- which grants this automatically) has no privileges for the
-- anon/authenticated/service_role roles PostgREST's API keys map to —
-- without this, PostgREST's schema-cache introspection silently omits
-- the object entirely, so /api/stats and the /api/fill logging fail
-- with "Could not find the table ... in the schema cache" (PGRST205)
-- even though the table/view genuinely exists and RLS is disabled.
grant select, insert on generation_log to anon, authenticated, service_role;
grant select on generation_stats to anon, authenticated, service_role;

-- Run after any of the above changes schema-cache-visible state
-- (CREATE/GRANT) — Supabase's Dashboard SQL editor usually fires this
-- automatically, but it doesn't hurt to be explicit, and it's required
-- if these statements are ever run through a direct psql connection
-- instead.
NOTIFY pgrst, 'reload schema';
