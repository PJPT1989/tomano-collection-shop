-- Run once in the Supabase SQL Editor, after vat-and-position-migration.sql.
-- Creates a VAT rate named "21" (21%) if it doesn't already exist, and
-- assigns it to any product that doesn't already have a VAT rate set.
-- Safe to re-run.

insert into vat_rates (name, rate)
select '21', 21
where not exists (select 1 from vat_rates where name = '21');

update products
set vat_rate_id = (select id from vat_rates where name = '21')
where vat_rate_id is null;
