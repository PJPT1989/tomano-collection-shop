-- Run once in the Supabase SQL Editor. Creates the full order data model
-- up front (orders, order_items now-active; shipments and invoices exist
-- but stay empty until we build steps 5/6 that use them), so we don't need
-- another migration later just to add tables.

create table orders (
  id bigint generated always as identity primary key,
  status text not null default 'new' check (status in ('new', 'in_progress', 'done', 'cancelled')),
  created_by text not null default 'customer' check (created_by in ('customer', 'admin')),

  customer_name text not null,
  customer_email text not null,
  customer_phone text,

  billing_street text not null,
  billing_city text not null,
  billing_zip text not null,
  billing_country text not null default 'Česká republika',

  shipping_street text not null,
  shipping_city text not null,
  shipping_zip text not null,
  shipping_country text not null default 'Česká republika',

  shipping_method text not null check (shipping_method in ('gls', 'zasilkovna', 'ceska_posta')),
  shipping_cost_czk numeric not null default 0,

  payment_method text not null check (payment_method in ('card', 'bank_transfer', 'cod')),
  paid boolean not null default false,
  paid_at timestamptz,
  gopay_payment_id text,
  gopay_status text,

  total_czk numeric not null,
  notes text,

  created_at timestamptz not null default now()
);

create table order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id) on delete cascade,
  product_id text references products(id) on delete set null,

  name_snapshot text not null,
  unit_price numeric not null,
  price_currency text not null,
  unit_price_czk numeric not null, -- unit price converted to CZK at order time, for consistent invoicing
  vat_rate numeric, -- percent, snapshotted from the product's assigned VAT rate at order time
  qty integer not null check (qty > 0),
  line_total_czk numeric not null
);

create table shipments (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id) on delete cascade,
  carrier text not null check (carrier in ('gls', 'zasilkovna', 'ceska_posta')),
  pickup_point_id text,
  carrier_shipment_id text,
  tracking_number text,
  label_url text,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table invoices (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id) on delete cascade,
  invoice_number text not null unique,
  issued_at timestamptz not null default now(),
  pdf_url text,
  sent_to_customer_at timestamptz
);

alter table orders enable row level security;
alter table order_items enable row level security;
alter table shipments enable row level security;
alter table invoices enable row level security;

-- No public read/write at all on any of these — only your logged-in admin
-- account can see or touch orders. Writes from checkout happen through the
-- create-order Edge Function, which uses the service-role key and so
-- bypasses RLS entirely (that's intentional, not a gap).

create policy "Admin can read orders" on orders for select using (auth.role() = 'authenticated');
create policy "Admin can update orders" on orders for update using (auth.role() = 'authenticated');

create policy "Admin can read order items" on order_items for select using (auth.role() = 'authenticated');

create policy "Admin can read shipments" on shipments for select using (auth.role() = 'authenticated');
create policy "Admin can write shipments" on shipments for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "Admin can read invoices" on invoices for select using (auth.role() = 'authenticated');
create policy "Admin can write invoices" on invoices for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Grants are a separate layer from the policies above and both are
-- required. From 2026-10-30 Supabase stops adding them automatically to
-- newly created tables, so without these a rebuild from this file would
-- produce tables that look correct and are unreachable through the API,
-- failing every query with "permission denied".
--
-- No anon grants deliberately: nothing about an order should be readable
-- without logging in. Checkout writes through the create-order Edge
-- Function, which uses the service-role key.

grant select, insert, update, delete on orders to authenticated;
grant select, insert, update, delete on order_items to authenticated;
grant select, insert, update, delete on shipments to authenticated;
grant select, insert, update, delete on invoices to authenticated;

grant select, insert, update, delete on orders to service_role;
grant select, insert, update, delete on order_items to service_role;
grant select, insert, update, delete on shipments to service_role;
grant select, insert, update, delete on invoices to service_role;

grant usage, select on sequence orders_id_seq to authenticated, service_role;
grant usage, select on sequence order_items_id_seq to authenticated, service_role;
grant usage, select on sequence shipments_id_seq to authenticated, service_role;
grant usage, select on sequence invoices_id_seq to authenticated, service_role;
