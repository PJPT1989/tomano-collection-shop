// Supabase Edge Function: fetch-exchange-rate
//
// Runs once a day (via a pg_cron schedule, see exchange-rate-cron.sql),
// after the Czech National Bank (CNB) publishes its daily fixing (~14:30
// CET). Fetches their public, unauthenticated daily.txt feed, parses out
// the EUR->CZK rate, and upserts one row per day into `exchange_rates`.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CNB_URL = "https://www.cnb.cz/en/financial-markets/foreign-exchange-market/central-bank-exchange-rate-fixing/central-bank-exchange-rate-fixing/daily.txt";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async () => {
  const res = await fetch(CNB_URL);
  if (!res.ok) {
    return new Response(JSON.stringify({ error: `CNB feed returned ${res.status}` }), { status: 502 });
  }

  const text = await res.text();
  const eurLine = text.split("\n").find((line) => line.startsWith("EMU|"));
  if (!eurLine) {
    return new Response(JSON.stringify({ error: "EUR row not found in CNB feed" }), { status: 502 });
  }

  // Format: Country|Currency|Amount|Code|Rate  e.g. "EMU|euro|1|EUR|24.350"
  const parts = eurLine.split("|");
  const rate = parseFloat(parts[4]);
  if (!rate || isNaN(rate)) {
    return new Response(JSON.stringify({ error: `Could not parse rate from "${eurLine}"` }), { status: 502 });
  }

  const today = new Date().toISOString().slice(0, 10);

  const { error } = await supabase
    .from("exchange_rates")
    .upsert({ rate_date: today, czk_per_eur: rate }, { onConflict: "rate_date" });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  return new Response(JSON.stringify({ status: "ok", rate_date: today, czk_per_eur: rate }), {
    headers: { "Content-Type": "application/json" },
  });
});
