// Supabase Edge Function: fetch-prices
//
// Runs once a day via pg_cron (see price-history-cron.sql) and appends one
// market-price snapshot per product to `price_history`, which the chart on
// the product page reads.
//
// Prices come from MTGStocks, keyed on products.mtgstocks_id. This replaced
// a paid per-request API that was returning the same value for every
// product on every day — 26 products, zero variation over days, which is
// not something real market prices do. Worth remembering if these figures
// ever go flat again: that is the symptom to look for, and comparing two
// days of rows is the way to spot it.
//
// Keyed on a stored id rather than an id parsed out of the product's
// TCGplayer link, as it used to be — that silently skipped every product
// whose links hadn't been filled in yet.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// MTGStocks refuse requests that look automated — a plain "Mozilla/5.0"
// gets an HTML error page instead of JSON, which would otherwise look like
// an outage rather than a rejection.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function fetchMarketPrice(mtgstocksId: number): Promise<number | null> {
  const res = await fetch(`https://api.mtgstocks.com/sealed/${mtgstocksId}`, {
    headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`MTGStocks vrátil ${res.status} pro id ${mtgstocksId}`);

  const body = await res.json();
  // `market` is the figure their own product page headlines. `average` is
  // the mean of current listings, which reacts to a single optimistic
  // seller; market is derived from what actually sold.
  const price = body?.latestPrice?.market;
  return typeof price === "number" ? price : null;
}

Deno.serve(async () => {
  const { data: products, error } = await supabase
    .from("products")
    .select("id, mtgstocks_id")
    .not("mtgstocks_id", "is", null);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const results: { id: string; status: string; price?: number }[] = [];

  for (const product of products) {
    try {
      const price = await fetchMarketPrice(product.mtgstocks_id);
      if (price == null) {
        results.push({ id: product.id, status: "skipped: no market price" });
        continue;
      }

      const { error: insertError } = await supabase
        .from("price_history")
        .insert({ product_id: product.id, price, currency: "USD" });
      if (insertError) throw insertError;

      results.push({ id: product.id, status: "ok", price });
    } catch (err) {
      results.push({ id: product.id, status: `error: ${(err as Error).message}` });
    }

    // Be polite to an API that owes us nothing.
    await new Promise((r) => setTimeout(r, 400));
  }

  return new Response(JSON.stringify({ results }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
