-- Run once in the Supabase SQL Editor, AFTER creating a storage bucket
-- named "labels" via Dashboard -> Storage -> New bucket. Leave "Public
-- bucket" OFF: a shipping label carries the customer's name and address,
-- the same reason the invoices bucket is private.
--
-- These policies let the logged-in admin read labels (to print them) and
-- delete them (when an order is deleted). The gls-create-label function
-- uploads with the service-role key, which bypasses both.

drop policy if exists "Admin can read labels bucket" on storage.objects;
create policy "Admin can read labels bucket"
on storage.objects for select
to authenticated
using (bucket_id = 'labels');

drop policy if exists "Admin can delete labels bucket objects" on storage.objects;
create policy "Admin can delete labels bucket objects"
on storage.objects for delete
to authenticated
using (bucket_id = 'labels');
