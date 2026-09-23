-- Run once in the Supabase SQL Editor. Safe to re-run.
--
-- One id per product, from which everything else follows: the daily price
-- snapshot reads it, and the admin link finder fills TCGplayer, Cardmarket
-- and MTGStocks URLs from the same record.
--
-- Replaces the old arrangement where fetch-prices parsed a TCGplayer id out
-- of the product's link text — that broke silently for products whose links
-- hadn't been added yet, which is why fra-dr and hob-dr were never priced.
--
-- Every id below was verified rather than matched by name: MTGStocks
-- publishes the TCGplayer product id for each sealed product, and each one
-- agreed with the TCGplayer link already stored on the product. The two
-- exceptions are fra-dr and hob-dr, which had no link to check against —
-- those come from MTGStocks' own set and product naming.

alter table products add column if not exists mtgstocks_id integer;

update products set mtgstocks_id = v.mtgstocks_id from (values
  ('blb-dr', 7196),
  ('dsk-cl', 7666),
  ('ecl-cl', 10965),
  ('fdn-cl', 7760),
  ('fin-cl', 8894),
  ('fra-dr', 12546),
  ('hob-cl', 12561),
  ('hob-dr', 12558),
  ('inr-cl', 8486),
  ('inr-dr', 8483),
  ('lci-cl', 6042),
  ('ltr-dr', 5060),
  ('mh3-dr', 7229),
  ('mkm-cl', 6409),
  ('mkm-dr', 6410),
  ('mom-dr', 4819),
  ('mom-st', 4824),
  ('msh-cl', 11703),
  ('otl-cl', 7244),
  ('otl-dr', 7241),
  ('snl-dr', 3193),
  ('sos-cl', 11728),
  ('sos-dr', 11725),
  ('spm-cl', 9113),
  ('tla-cl', 10631),
  ('tla-dr', 10628),
  ('tmt-cl', 11188),
  ('tmt-dr', 11185)
) as v(id, mtgstocks_id)
where products.id = v.id;
