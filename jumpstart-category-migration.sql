-- Jumpstart boxes get their own category, "Jumpstart boxes" (jumpstart.html).
-- Run once in the Supabase SQL Editor. Safe to re-run.
--
-- `cat` is plain text, so the category itself needs no schema change - this only
-- moves the Jumpstart boxes that were filed under draft, and gives them the
-- category's default weight of 800 g (a Jumpstart display is lighter than a
-- play box: 24 packs of 20 cards; see product-weight-migration.sql).

update products
set cat = 'jumpstart', weight_g = 800
where cat = 'draft'
  and (id like '%-js' or name ilike '%jumpstart%');

-- Check:
--   select id, cat, weight_g, name from products where cat = 'jumpstart';
