-- The products table. NOT needed for the running shop — this table already
-- exists and nothing here changes it. It is written down so the schema can
-- be rebuilt from this repo, which until now it could not: `products` was
-- created in the dashboard and only ever existed in the live database,
-- while seed.sql assumes it is already there.
--
-- That mattered because the recovery plan is "schema from the repo, data
-- from the backup". Without this file that plan quietly did not work.
--
-- RECONSTRUCTED, not exported. The added columns and their types come from
-- the migrations in this repo, which are exact. The original columns are
-- inferred from what seed.sql writes and what the live table returns, so
-- widths and defaults may differ in detail. Before trusting it for a real
-- rebuild, compare against the live table:
--
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_name = 'products' order by ordinal_position;
--
-- Policies live in products-policies.sql; the grants below are separate
-- from those and both are required. From 2026-10-30 Supabase no longer
-- adds grants automatically to new tables, so a table created without them
-- is invisible to the Data API however correct its policies are.

create table if not exists products (
  id text primary key,
  cat text not null,                    -- 'draft' | 'collector' | 'set'
  name text not null,
  price numeric not null,               -- widened from integer by currency-migration.sql
  eur integer,                          -- deprecated; EUR is computed live from price + rate
  stock integer not null default 0,
  img text,
  description text,
  links jsonb default '[]'::jsonb,      -- [{ text, href }]
  created_at timestamptz not null default now(),

  price_currency text not null default 'CZK' check (price_currency in ('CZK', 'EUR')),
  vat_rate_id integer references vat_rates(id),
  position integer not null default 0,
  ean text,
  weight_g integer not null default 1000,
  mtgstocks_id integer
);

alter table products enable row level security;

-- Read by the shop without logging in; written only by the admin account.
grant select on products to anon;
grant select, insert, update, delete on products to authenticated;
grant select, insert, update, delete on products to service_role;
