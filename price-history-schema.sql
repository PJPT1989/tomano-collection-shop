-- Run once in the Supabase SQL Editor, before deploying the fetch-prices
-- Edge Function. Creates the table that stores one daily market-price
-- snapshot per product. Only the Edge Function (using the service-role key,
-- which bypasses RLS) writes to this table; the shop only ever reads it.

create table price_history (
  id bigint generated always as identity primary key,
  product_id text not null references products(id) on delete cascade,
  price numeric not null,
  currency text not null default 'USD',
  scraped_at timestamptz not null default now()
);

create index price_history_product_date_idx on price_history (product_id, scraped_at);

alter table price_history enable row level security;

create policy "Public can read price history"
  on price_history for select
  using (true);

-- Grants are separate from the policy above and both are required. From
-- 2026-10-30 Supabase stops adding them automatically to new tables, so a
-- rebuild from this file without them yields a table the Data API cannot
-- see, however correct the policy is.
--
-- anon needs select because the chart on the product page is public.
-- Writes come only from the fetch-prices Edge Function via service_role.
grant select on price_history to anon, authenticated;
grant select, insert, update, delete on price_history to service_role;
grant usage, select on sequence price_history_id_seq to service_role;
