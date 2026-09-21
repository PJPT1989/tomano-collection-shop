// Supabase Edge Function: fetch-prices
//
// Runs once a day (via a pg_cron schedule, see supabase/setup/price-history-cron.sql).
// For every product in the `products` table, looks up its TCGPlayer product id
// (parsed from the "TCG Player" link already stored on the product), fetches
// today's market price from the tcgapi.dev API, and appends one row to
// `price_history`. Never touches anything client-side — the TCGAPI_KEY secret
// and the service-role key only ever live inside this function's environment.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TCGAPI_KEY = Deno.env.get("TCGAPI_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function extractTcgplayerId(links: { text: string; href: string }[] | null): number | null {
  if (!links) return null;
  for (const link of links) {
    const match = link.href?.match(/tcgplayer\.com\/product\/(\d+)/);
    if (match) return parseInt(match[1], 10);
  }
  return null;
}

async function fetchMarketPrice(tcgplayerId: number): Promise<number | null> {
  const res = await fetch(`https://api.tcgapi.dev/v1/cards/tcgplayer/${tcgplayerId}`, {
    headers: { "X-API-Key": TCGAPI_KEY },
  });
  if (!res.ok) {
    throw new Error(`tcgapi.dev returned ${res.status} for tcgplayer id ${tcgplayerId}`);
  }
  const body = await res.json();
  const prices = body?.data?.prices ?? [];
  const sealed = prices.find((p: { printing: string }) => p.printing === "Sealed");
  const chosen = sealed ?? prices[0];
  return typeof chosen?.market_price === "number" ? chosen.market_price : null;
}

Deno.serve(async () => {
  const { data: products, error } = await supabase
    .from("products")
    .select("id, links");

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  const results: { id: string; status: string; price?: number }[] = [];

  for (const product of products) {
    const tcgplayerId = extractTcgplayerId(product.links);
    if (!tcgplayerId) {
      results.push({ id: product.id, status: "skipped: no TCGPlayer link" });
      continue;
    }

    try {
      const price = await fetchMarketPrice(tcgplayerId);
      if (price == null) {
        results.push({ id: product.id, status: "skipped: no market_price in response" });
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

    // Be polite to the upstream API between requests.
    await new Promise((r) => setTimeout(r, 300));
  }

  return new Response(JSON.stringify({ results }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
});
