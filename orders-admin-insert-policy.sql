-- Run once in the Supabase SQL Editor, after orders-schema.sql.
-- orders-schema.sql only let your admin account read/update orders; this
-- adds the ability to create them too, needed for the "add a manual order
-- yourself" feature in the admin order dashboard. (Customer checkout still
-- goes through the create-order Edge Function, which uses the
-- service-role key and so doesn't need this policy at all.)

create policy "Admin can insert orders" on orders for insert
  with check (auth.role() = 'authenticated');

create policy "Admin can insert order items" on order_items for insert
  with check (auth.role() = 'authenticated');
