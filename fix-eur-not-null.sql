-- Run once in the Supabase SQL Editor. Fixes "null value in column eur
-- violates not-null constraint" when saving a product from admin.
--
-- Why: the eur column is deprecated (EUR is now always computed live from
-- price + price_currency + the daily CNB rate), so the admin form no
-- longer sends a value for it. But it was still marked NOT NULL from the
-- original schema, and Postgres enforces NOT NULL on upsert even when the
-- write ends up being an update. Dropping the constraint (not the column
-- itself, so old data is preserved) fixes this.

alter table products alter column eur drop not null;
