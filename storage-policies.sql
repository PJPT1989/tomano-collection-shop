-- Run this once in the Supabase SQL Editor, after creating the
-- "product-images" storage bucket. It lets your logged-in admin account
-- upload/replace images; public read access already comes from the
-- bucket's "Public bucket" toggle.

create policy "Authenticated can upload product images"
on storage.objects for insert
to authenticated
with check (bucket_id = 'product-images');

create policy "Authenticated can update product images"
on storage.objects for update
to authenticated
using (bucket_id = 'product-images');
