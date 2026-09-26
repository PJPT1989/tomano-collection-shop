-- Products mirrored from the distributor (see DECISIONS.md, "Products
-- mirrored from the distributor"). Run once in the Supabase SQL Editor.
-- Safe to re-run.
--
-- 1. A third availability status, "Skladem u dodavatele", with a delivery
--    note shown next to it. The note is a column on the statuses table so
--    the wording can be changed without a deploy.
-- 2. products.supplier_managed - created and kept in sync by the supplier
--    bot; the bot's function can change only these rows.
--    products.hidden - not offered at all (category pages, Heureka, cart).
--    products.supplier_name - the distributor's product name, which is how
--    the bot recognises its products in the distributor's list.
-- 3. supplier_order_items - the queue of customer order lines the bot still
--    has to order from the distributor (or has, with the result).

-- 1. Status ---------------------------------------------------------------

alter table availability_statuses add column if not exists note text;

insert into availability_statuses (code, label, position, note) values
  ('supplier', 'Skladem u dodavatele', 3, 'odesíláme do 5–7 pracovních dnů')
on conflict (code) do update set label = excluded.label, note = excluded.note;

-- 2. Products -------------------------------------------------------------

alter table products add column if not exists supplier_managed boolean not null default false;
alter table products add column if not exists hidden boolean not null default false;
alter table products add column if not exists supplier_name text;

-- 3. Queue ----------------------------------------------------------------
--
-- One row per supplier-managed line of a customer order, written by
-- create-order. Status flow (only the bot moves it on):
--   pending  -> waiting to be ordered
--   ordering -> the bot is in the distributor's checkout; if it never comes
--               back from here, it becomes "unclear" - never retried, so a
--               box can't be ordered twice
--   ordered  -> placed at the distributor (ordered_qty may be less than qty)
--   failed   -> not ordered; `note` says why (sold out, price rose, ...)
--   unclear  -> may or may not have been ordered - check the distributor
-- unit_price_czk is what the customer paid per box: the bot orders only if
-- the distributor's price is still at most that.

create table if not exists supplier_order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id) on delete cascade,
  product_id text references products(id) on delete set null,
  supplier_name text not null,
  qty integer not null check (qty > 0),
  unit_price_czk numeric not null,
  status text not null default 'pending'
    check (status in ('pending', 'ordering', 'ordered', 'failed', 'unclear')),
  ordered_qty integer,
  supplier_order_id text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists supplier_order_items_status on supplier_order_items (status);

alter table supplier_order_items enable row level security;

-- Admin reads it (shown with the order) and may correct it by hand; the bot
-- goes through the supplier-sync function (service role); customers never
-- see it.
drop policy if exists "Admin can manage supplier order items" on supplier_order_items;
create policy "Admin can manage supplier order items" on supplier_order_items for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Explicit grants: from 2026-10-30 Supabase no longer adds them to new tables.
grant select, insert, update, delete on supplier_order_items to authenticated;
grant select, insert, update, delete on supplier_order_items to service_role;

-- Check:
--   select code, label, note from availability_statuses order by position;
--   select id, supplier_managed, hidden, supplier_name from products limit 5;
--   select count(*) from supplier_order_items;
