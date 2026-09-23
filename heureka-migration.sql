-- Run once in the Supabase SQL Editor. Safe to re-run.
--
-- Adds the EAN needed by the Heureka product feed. EAN is only mandatory
-- for books, films and music, so products without one still appear — they
-- just pair to Heureka's catalogue less reliably, since EAN is the
-- strongest pairing signal they have.
--
-- The values below were taken from the shop's existing Heureka feed rather
-- than typed in, so they are the same codes Heureka already associates with
-- these products. They are normalised to 13 digits: the old feed mixed
-- 12-digit UPCs with 13-digit EANs for no reason, and a UPC-A becomes a
-- valid EAN-13 simply by prefixing a zero.
--
-- Deliberately NOT populated here:
--   sos-cl / sos-dr  the old feed gives both the same EAN (195166316703),
--                    which cannot be right for two different products, and
--                    guessing which one owns it would guarantee a mispair
--   dsk-cl, ecl-cl, fin-cl, fra-dr, hob-dr, ltr-dr, mom-dr, otl-cl
--                    never had one in the old feed
-- Read those off the boxes — the barcode on the product is authoritative in
-- a way no lookup service is for sealed Magic product.

alter table products add column if not exists ean text;

update products set ean = v.ean from (values
  ('blb-dr', '0195166257112'),
  ('fdn-cl', '0195166261898'),
  ('hob-cl', '0195166321905'),
  ('inr-cl', '0195166270050'),
  ('inr-dr', '0195166269962'),
  ('lci-cl', '0195166229973'),
  ('mh3-dr', '0195166253602'),
  ('mkm-cl', '0195166244884'),
  ('mkm-dr', '0195166248905'),
  ('mom-st', '0195166207247'),
  ('msh-cl', '0195166314075'),
  ('otl-dr', '0195166252391'),
  ('snl-dr', '0195166120195'),
  ('spm-cl', '0195166289915'),
  ('tla-cl', '0195166290461'),
  ('tla-dr', '0195166290416'),
  ('tmt-cl', '0195166308180'),
  ('tmt-dr', '0195166308036')
) as v(id, ean)
where products.id = v.id;
