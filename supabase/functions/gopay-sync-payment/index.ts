// Supabase Edge Function: gopay-sync-payment
//
// Reads a payment's real state from GoPay and writes it onto the order.
// Serves two callers with one code path, because both need exactly this:
//
//   - GoPay's notification webhook, which GETs ?id=<paymentId> whenever a
//     payment changes state and ignores whatever we return.
//   - The customer's return page, which POSTs {id} to find out what to show.
//
// The state is always re-fetched from GoPay rather than taken from whoever
// called us, so this staying public is safe: the worst an unauthenticated
// caller can do is make us re-read a payment we already own and write back
// the same answer. That re-fetch is the whole point — the browser coming
// back from the gateway proves nothing, and a customer who closes the tab
// mid-payment must not cost us the payment record.
//
// DEPLOYMENT: this one must have JWT verification turned OFF, since GoPay
// sends no Authorization header. Every other function in this project keeps
// it on.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const GOPAY_API_BASE = Deno.env.get("GOPAY_API_BASE")!;
const GOPAY_CLIENT_ID = Deno.env.get("GOPAY_CLIENT_ID")!;
const GOPAY_CLIENT_SECRET = Deno.env.get("GOPAY_CLIENT_SECRET")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function getAccessToken(scope: string): Promise<string> {
  const credentials = btoa(`${GOPAY_CLIENT_ID}:${GOPAY_CLIENT_SECRET}`);
  const res = await fetch(`${GOPAY_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });
  if (!res.ok) {
    throw new Error(`GoPay token ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

// GoPay's webhook puts the id in the query string; our own return page finds
// a JSON body easier. Accept either rather than making the page imitate a
// webhook.
async function readPaymentId(req: Request): Promise<string | null> {
  const fromQuery = new URL(req.url).searchParams.get("id");
  if (fromQuery) return fromQuery;
  try {
    const body = await req.json();
    return body?.id ? String(body.id) : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const paymentId = await readPaymentId(req);
    if (!paymentId) return jsonResponse({ error: "Chybí id platby." }, 400);

    const token = await getAccessToken("payment-all");
    const res = await fetch(`${GOPAY_API_BASE}/payments/payment/${paymentId}`, {
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
    });
    const payment = await res.json();
    // 500 rather than swallowing it, so GoPay retries the notification.
    if (!res.ok) return jsonResponse({ error: "Stav platby se nepodařilo načíst." }, 500);

    const state = payment.state;

    const { data: order } = await supabase
      .from("orders").select("id, paid").eq("gopay_payment_id", String(paymentId)).maybeSingle();

    // 200 on purpose: if the order is gone there is nothing to retry, and a
    // non-2xx would have GoPay redelivering this forever.
    if (!order) return jsonResponse({ state, matched: false });

    // A later CANCELED/TIMEOUTED never un-pays an order — reversing money
    // that arrived is a refund, which is a decision for the admin rather
    // than something a webhook should do on its own.
    const updates: Record<string, unknown> = { gopay_status: state };
    if (state === "PAID" && !order.paid) {
      updates.paid = true;
      updates.paid_at = new Date().toISOString();
    }

    const { error: updateError } = await supabase.from("orders").update(updates).eq("id", order.id);
    if (updateError) return jsonResponse({ error: updateError.message }, 500);

    return jsonResponse({ state, matched: true });
  } catch (err) {
    return jsonResponse({ error: "Neočekávaná chyba: " + (err as Error).message }, 500);
  }
});
