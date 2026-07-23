-- Schema for the generation_log table + generation_stats view used by
-- backend/app/main.py: POST /api/fill writes one row here on every
-- successful document generation; GET /api/stats reads generation_stats.
-- Run this once in the Supabase SQL editor, same as
-- create_companies_table.sql.
--
-- company_name is a plain text snapshot (the name at the moment of
-- generation), not a foreign key to companies.id — renaming or deleting
-- a company later must not retroactively change or orphan historical
-- stats. employee_name is the same kind of snapshot (first + last name
-- at generation time), added for StatsWidget.jsx's per-person signing
-- status — this table did previously avoid storing any personal data,
-- but the per-person breakdown needs a name to group and label rows by.

create table if not exists generation_log (
    id uuid primary key default gen_random_uuid(),
    company_name text,
    employee_name text,
    document_type text not null,
    created_at timestamptz not null default now(),
    signed_at timestamptz
);

-- Additive migration for databases created before employee_name/signed_at
-- existed — safe to re-run, and a no-op once already applied.
alter table generation_log add column if not exists employee_name text;
alter table generation_log add column if not exists signed_at timestamptz;

-- Rows logged before this feature existed have no real signing status on
-- record and no employee_name to ever surface a per-person toggle for —
-- default them to "signed" (as of their own creation time) rather than
-- leaving every company that generated documents before this migration
-- permanently red with no way to clear it.
update generation_log set signed_at = created_at where signed_at is null;

create index if not exists generation_log_company_name_idx on generation_log (company_name);
create index if not exists generation_log_created_at_idx on generation_log (created_at);

-- /api/stats reads from this view rather than pulling every row into
-- Python to aggregate — PostgREST's auto-generated REST API has no
-- query-string syntax for GROUP BY/count(), so the aggregation lives
-- here instead. coalesce() folds "no company selected" (NULL) into the
-- same "Bez firmy" bucket the frontend widget shows, rather than a
-- separate `null`-keyed row alongside a possible real company literally
-- named "Bez firmy" (accepted as a vanishingly unlikely name clash).
-- all_signed is true only when every document logged for that company
-- has a signed_at — a single unsigned row makes the whole company red.
create or replace view generation_stats as
select
    coalesce(company_name, 'Bez firmy') as company_name,
    count(*) as document_count,
    bool_and(signed_at is not null) as all_signed
from generation_log
group by coalesce(company_name, 'Bez firmy')
order by document_count desc;

-- Same aggregation as generation_stats above, but broken down by
-- document_type too — powers StatsWidget.jsx's click-to-expand detail
-- under each company row (e.g. "DPP: 1 · HPP: 3 · Ukončení poměru: 1").
-- Kept as its own view rather than widening generation_stats itself, so
-- the original company-only totals endpoint/tests keep their existing
-- shape untouched.
create or replace view generation_stats_by_type as
select
    coalesce(company_name, 'Bez firmy') as company_name,
    document_type,
    count(*) as document_count
from generation_log
group by coalesce(company_name, 'Bez firmy'), document_type
order by company_name, document_count desc;

-- Per-person breakdown under each company — powers the per-person status
-- dots in StatsWidget.jsx. Rows with no employee_name (blank fields at
-- generation time, or historical rows from before this column existed)
-- are excluded here rather than folded into an "Unknown" bucket: there's
-- no person to show a name or a toggle-able dot for, though those rows
-- still count toward generation_stats' company-level document_count and
-- all_signed above.
create or replace view generation_stats_by_person as
select
    coalesce(company_name, 'Bez firmy') as company_name,
    employee_name,
    count(*) as document_count,
    bool_and(signed_at is not null) as all_signed
from generation_log
where employee_name is not null and trim(employee_name) <> ''
group by coalesce(company_name, 'Bez firmy'), employee_name
order by company_name, employee_name;

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
-- update, not just select/insert: /api/stats/sign PATCHes signed_at on
-- the underlying rows when someone clicks a person's status dot.
grant select, insert, update on generation_log to anon, authenticated, service_role;
grant select on generation_stats to anon, authenticated, service_role;
grant select on generation_stats_by_type to anon, authenticated, service_role;
grant select on generation_stats_by_person to anon, authenticated, service_role;

-- Run after any of the above changes schema-cache-visible state
-- (CREATE/GRANT) — Supabase's Dashboard SQL editor usually fires this
-- automatically, but it doesn't hurt to be explicit, and it's required
-- if these statements are ever run through a direct psql connection
-- instead.
NOTIFY pgrst, 'reload schema';
