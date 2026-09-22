-- Run once in the Supabase SQL Editor, AFTER creating a storage bucket
-- named "invoices" via Dashboard -> Storage -> New bucket. Leave the
-- "Public bucket" toggle OFF this time — invoices contain customer PII,
-- unlike product-images. This policy lets your logged-in admin account
-- generate short-lived signed URLs to view/download them; the
-- generate-invoice Edge Function itself uses the service-role key, which
-- bypasses this policy entirely for the actual upload.

create policy "Admin can read invoices bucket"
on storage.objects for select
to authenticated
using (bucket_id = 'invoices');
