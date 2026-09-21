-- Run once in the Supabase SQL Editor, AFTER the fetch-prices Edge Function
-- has been deployed. Schedules it to run once a day. The URL below already
-- has your project ref filled in; the Authorization header uses your public
-- anon key (safe to use here — it only proves the request is a legitimate
-- call to your project, the function itself does the real work server-side
-- with the service-role key).

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'daily-price-fetch',
  '0 6 * * *',  -- 06:00 UTC = 07:00/08:00 in Czech time depending on DST
  $$
  select net.http_post(
    url := 'https://jcxiktmftokritzxrrxx.supabase.co/functions/v1/fetch-prices',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjeGlrdG1mdG9rcml0enhycnh4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk5ODgwNDYsImV4cCI6MjEwNTU2NDA0Nn0.zF5EgmJy_6YzOD7smdpUycH_Y3jEuP4XhthI3t_sW1A',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To check past runs later: select * from cron.job_run_details order by start_time desc limit 20;
-- To stop it if needed: select cron.unschedule('daily-price-fetch');
