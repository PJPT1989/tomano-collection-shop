-- Run once in the Supabase SQL Editor. Safe on live data — adds new things
-- only, doesn't touch existing product prices (they keep meaning CZK,
-- since price_currency defaults to 'CZK' for all current rows, matching
-- how they were originally entered).

create table exchange_rates (
  id bigint generated always as identity primary key,
  rate_date date not null unique,
  czk_per_eur numeric not null,
  fetched_at timestamptz not null default now()
);

alter table exchange_rates enable row level security;

create policy "Public can read exchange rates"
  on exchange_rates for select
  using (true);

-- Grants are separate from the policy above and both are required. From
-- 2026-10-30 Supabase no longer adds them to newly created tables, so
-- without these a rebuild from this file leaves the table unreachable
-- through the Data API.
--
-- anon needs select because every page converts prices using the daily
-- rate. Writes come only from the fetch-exchange-rate Edge Function.
grant select on exchange_rates to anon, authenticated;
grant select, insert, update, delete on exchange_rates to service_role;
grant usage, select on sequence exchange_rates_id_seq to service_role;

alter table products add column if not exists price_currency text not null default 'CZK'
  check (price_currency in ('CZK', 'EUR'));

-- price was `integer`, which can't hold a decimal EUR amount like 49.99.
alter table products alter column price type numeric using price::numeric;

-- The old `eur` column is no longer written to or read by the app (EUR is
-- now always computed live from price + price_currency + today's rate).
-- Left in place rather than dropped, in case you want to keep it as a
-- historical reference.
