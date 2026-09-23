-- Run this once in the Supabase SQL Editor, after creating the
-- "product-images" storage bucket. It lets your logged-in admin account
-- upload/replace images; public read access already comes from the
-- bucket's "Public bucket" toggle.
--
-- Easy to skip without noticing: every product image in the shop today was
-- committed to the repo rather than uploaded, so nothing ever wrote to
-- this bucket. The omission only surfaces the first time a product is
-- saved with an image, as "new row violates row-level security policy" —
-- which reads like a problem with the products table rather than storage,
-- because the upload happens first and its error is what you see.
--
-- drop-if-exists so this is safe to re-run: the SQL editor executes a
-- pasted script as one transaction, so tripping on an already-applied
-- statement rolls back everything else with it.

drop policy if exists "Authenticated can upload product images" on storage.objects;
create policy "Authenticated can upload product images"
on storage.objects for insert
to authenticated
with check (bucket_id = 'product-images');

-- Replacing an existing object rather than adding one. WITH CHECK as well
-- as USING: without it, any write that Postgres treats as an update — an
-- upsert, for instance — is rejected even though USING would allow it.
drop policy if exists "Authenticated can update product images" on storage.objects;
create policy "Authenticated can update product images"
on storage.objects for update
to authenticated
using (bucket_id = 'product-images')
with check (bucket_id = 'product-images');

-- So an image can be removed rather than orphaned. Uploaded filenames
-- carry a timestamp, so changing a product's picture leaves the previous
-- file behind with nothing pointing at it — and without this policy there
-- is no way to clear those out from the browser at all.
drop policy if exists "Authenticated can delete product images" on storage.objects;
create policy "Authenticated can delete product images"
on storage.objects for delete
to authenticated
using (bucket_id = 'product-images');
