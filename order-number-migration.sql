-- Run once in the Supabase SQL Editor.
--
-- Gives orders their own customer-facing number in the same YYYY###### form
-- the invoice series already uses, so numbering carries across the cutover
-- from the shop this project replaces instead of restarting at 1. `id` stays
-- the internal key used for every lookup and foreign key; order_number is
-- what customers, invoices, e-mails and the payment gateway see.
--
-- The 2026 series starts at 100 because the shop being replaced had already
-- issued order numbers into the 60s and invoices into the 40s, so 100 clears
-- both with room to spare and makes the origin of a number obvious at a
-- glance. From 2027 the series is ours alone and starts at 1 — which is why
-- the floor is written as a one-year special case rather than a permanent
-- offset. generate-invoice's nextInvoiceNumber() has the matching floor.

-- Written to be safe to re-run: the SQL editor executes a pasted script as
-- one transaction, so a second run that trips on an already-applied
-- statement rolls the whole thing back and tells you nothing useful.

alter table orders add column if not exists order_number text unique;

create or replace function assign_order_number() returns trigger as $$
declare
  prefix text := to_char(now(), 'YYYY');
  first_seq int := case when prefix = '2026' then 100 else 1 end;
  next_seq int;
begin
  if new.order_number is not null then
    return new;
  end if;

  -- Read-then-write, so two orders inserted in the same instant could pick
  -- the same number; the unique constraint turns that into a failed insert
  -- rather than a duplicate. At this shop's volume that trade is fine, and
  -- it matches how invoice numbers are already allocated.
  select coalesce(max(substring(order_number from 5)::int) + 1, first_seq)
    into next_seq
    from orders
   where order_number like prefix || '%';

  new.order_number := prefix || lpad(next_seq::text, 6, '0');
  return new;
end;
$$ language plpgsql;

drop trigger if exists orders_assign_order_number on orders;
create trigger orders_assign_order_number
  before insert on orders
  for each row execute function assign_order_number();

-- Backfill the orders already in the table, so nothing downstream has to
-- cope with a null order_number.
update orders o
   set order_number = '2026' || lpad((99 + n.rn)::text, 6, '0')
  from (select id, row_number() over (order by id) as rn from orders where order_number is null) n
 where o.id = n.id;

alter table orders alter column order_number set not null;
