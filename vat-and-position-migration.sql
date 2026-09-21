-- Run once in the Supabase SQL Editor. Safe to run on your live database —
-- it only adds new things, it does not touch your existing product rows'
-- name/price/stock/etc, and it does NOT truncate anything (unlike seed.sql,
-- do not re-run seed.sql now that you've edited live data through admin).

create table if not exists vat_rates (
  id serial primary key,
  name text not null,
  rate numeric not null
);

alter table vat_rates enable row level security;

create policy "Public can read vat rates"
  on vat_rates for select
  using (true);

create policy "Only logged-in users can write vat rates"
  on vat_rates for all
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

alter table products add column if not exists position integer not null default 0;
alter table products add column if not exists vat_rate_id integer references vat_rates(id);

-- One-time: give your existing products a sensible starting order (matches
-- how they're ordered today) so nothing visually jumps around after this
-- migration. You can freely reorder from admin afterwards.
with ranked as (
  select id, row_number() over (partition by cat order by created_at) as rn
  from products
)
update products p set position = ranked.rn
from ranked
where p.id = ranked.id;
