// Supabase Edge Function: gopay-create-payment
//
// Given { orderId }, creates a GoPay payment for that order and returns the
// gateway URL to redirect the customer to.
//
// Deliberately separate from create-order rather than chained onto the end
// of it: the order has to survive GoPay being unreachable, and an unpaid
// order needs to be payable again later without being recreated.
//
// The browser only ever supplies an order id — every amount is read back
// out of the stored order, so a tampered client can't change what it pays.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Set as Edge Function secrets, never in the repo. GOPAY_API_BASE is what
// makes going live a credential swap rather than a code change:
//   sandbox    https://gw.sandbox.gopay.com/api
//   production https://gate.gopay.cz/api
const GOPAY_API_BASE = Deno.env.get("GOPAY_API_BASE")!;
const GOPAY_CLIENT_ID = Deno.env.get("GOPAY_CLIENT_ID")!;
const GOPAY_CLIENT_SECRET = Deno.env.get("GOPAY_CLIENT_SECRET")!;
const GOPAY_GOID = Deno.env.get("GOPAY_GOID")!;
const SHOP_BASE_URL = Deno.env.get("SHOP_BASE_URL")!;

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

// GoPay prices everything in haléře.
function toMinorUnits(czk: number) {
  return Math.round(czk * 100);
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const { orderId } = await req.json();

    const { data: order, error: orderErr } = await supabase
      .from("orders").select("*").eq("id", orderId).single();
    if (orderErr || !order) return jsonResponse({ error: "Objednávka nenalezena." }, 404);

    if (order.payment_method === "cod") {
      return jsonResponse({ error: "Dobírka se přes platební bránu neplatí." }, 400);
    }
    if (order.paid) {
      return jsonResponse({ error: "Objednávka je již zaplacena." }, 409);
    }

    const { data: items, error: itemsErr } = await supabase
      .from("order_items").select("*").eq("order_id", orderId);
    if (itemsErr) return jsonResponse({ error: itemsErr.message }, 500);

    // GoPay rejects the payment if the item amounts don't add up to `amount`,
    // so shipping has to appear as its own line once it stops being free.
    const gopayItems = (items || []).map((it) => ({
      type: "ITEM",
      name: it.name_snapshot,
      amount: toMinorUnits(it.line_total_czk),
      count: it.qty,
      vat_rate: Math.round(it.vat_rate ?? 0),
    }));
    if (order.shipping_cost_czk > 0) {
      gopayItems.push({
        type: "DELIVERY",
        name: "Doprava",
        amount: toMinorUnits(order.shipping_cost_czk),
        count: 1,
        vat_rate: 21,
      });
    }

    const [firstName, ...restOfName] = String(order.customer_name).trim().split(/\s+/);

    const token = await getAccessToken("payment-create");
    const paymentRequest = {
      payer: {
        allowed_payment_instruments: ["PAYMENT_CARD", "BANK_ACCOUNT", "GPAY", "APPLE_PAY"],
        contact: {
          first_name: firstName || order.customer_name,
          last_name: restOfName.join(" "),
          email: order.customer_email,
          phone_number: order.customer_phone || undefined,
          city: order.billing_city,
          street: order.billing_street,
          postal_code: order.billing_zip,
          country_code: "CZE",
        },
      },
      target: { type: "ACCOUNT", goid: Number(GOPAY_GOID) },
      amount: toMinorUnits(order.total_czk),
      currency: "CZK",
      order_number: order.order_number,
      order_description: `Objednávka ${order.order_number} - Tomano Collection`,
      items: gopayItems,
      callback: {
        return_url: `${SHOP_BASE_URL}/payment-return.html?order=${encodeURIComponent(order.order_number)}`,
        notification_url: `${SUPABASE_URL}/functions/v1/gopay-sync-payment`,
      },
      lang: "CS",
    };

    const res = await fetch(`${GOPAY_API_BASE}/payments/payment`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(paymentRequest),
    });
    const payment = await res.json();
    if (!res.ok) {
      return jsonResponse({ error: "Platbu se nepodařilo vytvořit.", detail: payment }, 502);
    }

    await supabase
      .from("orders")
      .update({ gopay_payment_id: String(payment.id), gopay_status: payment.state })
      .eq("id", orderId);

    return jsonResponse({ gatewayUrl: payment.gw_url, paymentId: String(payment.id) });
  } catch (err) {
    return jsonResponse({ error: "Neočekávaná chyba: " + (err as Error).message }, 500);
  }
});
