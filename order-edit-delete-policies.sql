-- Run once in the Supabase SQL Editor.
--
-- orders-schema.sql only ever granted the admin role SELECT and UPDATE on
-- orders, and SELECT-only on order_items. Deleting an order (or editing its
-- line items) needs more: a DELETE policy on orders itself, and INSERT/
-- UPDATE/DELETE on order_items — the last of those matters even for a plain
-- order delete, because the order_items row is removed via the table's
-- `on delete cascade`, and a cascade delete is still subject to RLS on the
-- child table for a non-superuser role like the logged-in admin.

-- drop-if-exists first on each policy makes this script safe to re-run —
-- a prior partial run (e.g. one statement failing mid-script) can leave
-- some of these already in place, and CREATE POLICY has no IF NOT EXISTS.

drop policy if exists "Admin can delete orders" on orders;
create policy "Admin can delete orders" on orders for delete using (auth.role() = 'authenticated');

drop policy if exists "Admin can insert order items" on order_items;
create policy "Admin can insert order items" on order_items for insert with check (auth.role() = 'authenticated');

drop policy if exists "Admin can update order items" on order_items;
create policy "Admin can update order items" on order_items for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "Admin can delete order items" on order_items;
create policy "Admin can delete order items" on order_items for delete using (auth.role() = 'authenticated');

-- invoices-storage-policy.sql only granted SELECT on the "invoices" bucket
-- (for signed-URL downloads). Deleting an order also removes its invoice
-- PDF from storage directly from the admin's logged-in session, which
-- needs its own DELETE policy — the generate-invoice function's own
-- uploads/overwrites go through the service-role key and bypass this.
drop policy if exists "Admin can delete invoices bucket objects" on storage.objects;
create policy "Admin can delete invoices bucket objects"
on storage.objects for delete
to authenticated
using (bucket_id = 'invoices');
