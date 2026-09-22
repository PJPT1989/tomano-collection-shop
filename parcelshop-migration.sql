-- Run once in the Supabase SQL Editor. Safe to re-run.
--
-- Adds GLS ParcelShop (PSD) delivery as its own shipping method, so orders
-- can be sent to a pickup point the customer chooses on the GLS map.
--
-- The shop's address is NOT stored in new columns: when a ParcelShop is
-- chosen, its address goes into the existing shipping_street/city/zip
-- fields. That is what GLS themselves require — the delivery address on a
-- PSD label has to be the ParcelShop's, with the customer named only as the
-- contact person — and it means the invoice, the confirmation e-mails and
-- the admin detail all show the right delivery address without any of them
-- needing to know ParcelShops exist. Only the shop's identity needs new
-- columns: pickup_point_id is the value the label API later takes as the
-- PSD service parameter (e.g. 26711-GLSCZ_DEPO47), and the name is kept so
-- staff and customers see a place rather than a code.

alter table orders drop constraint if exists orders_shipping_method_check;
alter table orders add constraint orders_shipping_method_check
  check (shipping_method in ('gls', 'gls_parcelshop', 'zasilkovna', 'ceska_posta'));

alter table orders add column if not exists pickup_point_id text;
alter table orders add column if not exists pickup_point_name text;

-- A pickup point is required for exactly the method that delivers to one.
alter table orders drop constraint if exists orders_pickup_point_required;
alter table orders add constraint orders_pickup_point_required
  check (shipping_method <> 'gls_parcelshop' or pickup_point_id is not null);

-- shipments.carrier deliberately stays as it is: a ParcelShop parcel is
-- still carried by GLS, and the pickup point lives in its own column there.
