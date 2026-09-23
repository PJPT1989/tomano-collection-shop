-- Run once in the Supabase SQL Editor. Safe to re-run.
--
-- The products table's policies were only ever created in the dashboard,
-- so they weren't in this repo and nobody could see what they were. This
-- states them explicitly.
--
-- The gap that prompted it: creating a product in admin failed with "new
-- row violates row-level security policy". Every existing product arrived
-- through seed.sql in the SQL editor, which runs as service role and
-- bypasses RLS entirely, so an INSERT had genuinely never been attempted
-- through the browser.
--
-- Note admin saves with upsert, which is INSERT ... ON CONFLICT DO UPDATE.
-- Postgres checks the INSERT policy's WITH CHECK for the new row *and* the
-- UPDATE policy on the conflict path, so both have to be present for
-- editing an existing product to keep working.
--
-- These are permissive policies, so if the dashboard already holds
-- equivalents under different names, both apply and access is unchanged —
-- adding these can only widen, never restrict.

drop policy if exists "Public can read products" on products;
create policy "Public can read products" on products for select using (true);

drop policy if exists "Admin can insert products" on products;
create policy "Admin can insert products" on products for insert
  with check (auth.role() = 'authenticated');

drop policy if exists "Admin can update products" on products;
create policy "Admin can update products" on products for update
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

drop policy if exists "Admin can delete products" on products;
create policy "Admin can delete products" on products for delete
  using (auth.role() = 'authenticated');
