-- Run once in the Supabase SQL Editor, AFTER the fetch-exchange-rate Edge
-- Function has been deployed (Dashboard -> Edge Functions -> Deploy a new
-- function -> Via Editor -> name it exactly "fetch-exchange-rate").
-- Scheduled for 15:00 UTC, after CNB's ~14:30 CET daily fixing is published.
-- If you already ran price-history-cron.sql, pg_cron/pg_net are already
-- enabled and those two "create extension" lines below are harmless no-ops.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'daily-exchange-rate-fetch',
  '0 15 * * *',
  $$
  select net.http_post(
    url := 'https://jcxiktmftokritzxrrxx.supabase.co/functions/v1/fetch-exchange-rate',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjeGlrdG1mdG9rcml0enhycnh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5ODgwNDYsImV4cCI6MjEwNTU2NDA0Nn0.zF5EgmJy_6YzOD7smdpUycH_Y3jEuP4XhthI3t_sW1A',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
