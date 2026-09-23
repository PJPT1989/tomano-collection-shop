-- Run once in the Supabase SQL Editor. Safe to re-run.
--
-- Packeta require a weight on every packet and price in bands, so one
-- figure for all products is not good enough here: a collector box weighs
-- around 400 g and a draft box around 1100 g, which straddles a band
-- boundary. Using the heavier figure for everything would overpay on every
-- collector order, and the lighter one would invite reweigh corrections.
--
-- Seeded per category so nothing has to be typed in, and NOT NULL with a
-- default so a product added later always has a usable weight rather than
-- failing the packet at the worst moment. Correct individual products in
-- admin as they get weighed — the number below is a category average, not
-- a measurement of each box.

alter table products add column if not exists weight_g integer not null default 1000;

-- Weighed rather than estimated, then rounded up a little. Precision buys
-- almost nothing here: Zásilkovna's first weight band for pickup points
-- runs to 5 kg at one flat price, so any normal order of one to four boxes
-- costs the same whatever we declare. Erring high protects the one case
-- that does cost something — under-declaring, which earns a reweigh and a
-- correction invoice. Draft boxes actually range 800-1100 g depending on
-- how many packs the set ships with; the top of that range is used for the
-- same reason.
update products set weight_g = case cat
  when 'collector' then 400
  when 'draft' then 1100
  when 'set' then 900
  else 1000
end;
