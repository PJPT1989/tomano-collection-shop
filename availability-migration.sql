-- Availability status and release date for products.
-- Run once in the Supabase SQL Editor. Safe to re-run.
--
-- Until now a product was either "Skladem N Ks" or "Skladem 0" - there was no
-- way to sell something that hasn't been released yet. Products now carry an
-- availability status and a release date:
--
--   available  "Skladem"     - on hand, the default for every existing product
--   presale    "Předprodej"  - ordered from the distributor, not released yet;
--                              orderable up to `stock`, switched to available
--                              by hand when the goods actually arrive
--
-- Statuses are a table rather than a check constraint because more are
-- expected; adding one is an insert here (plus display code if it needs any).
-- `release_date` is for every product, not only presales: the plan is to sort
-- the shop by it later, so current stock will get dates too.
--
-- The supplier bot (cernyrytir-news-watcher) creates presale products when it
-- orders a whole case; see supabase/functions/supplier-product.

create table if not exists availability_statuses (
  code text primary key,
  label text not null,        -- shown to customers (Czech)
  position integer not null default 0
);

insert into availability_statuses (code, label, position) values
  ('available', 'Skladem', 1),
  ('presale', 'Předprodej', 2)
on conflict (code) do nothing;

alter table availability_statuses enable row level security;

drop policy if exists "Public can read availability statuses" on availability_statuses;
create policy "Public can read availability statuses" on availability_statuses for select using (true);

drop policy if exists "Admin can manage availability statuses" on availability_statuses;
create policy "Admin can manage availability statuses" on availability_statuses for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Explicit grants: from 2026-10-30 Supabase no longer adds them to new tables.
grant select on availability_statuses to anon;
grant select, insert, update, delete on availability_statuses to authenticated;
grant select, insert, update, delete on availability_statuses to service_role;

alter table products add column if not exists availability text not null default 'available';
alter table products add column if not exists release_date date;

alter table products drop constraint if exists products_availability_fkey;
alter table products add constraint products_availability_fkey
  foreign key (availability) references availability_statuses(code);

-- Check:
--   select code, label from availability_statuses order by position;
--   select id, availability, release_date from products order by cat, position limit 5;
