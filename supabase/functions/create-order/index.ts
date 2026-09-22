// Supabase Edge Function: create-order
//
// Called directly from the checkout page (browser -> this function, using
// the public anon key just to authorize the call, same as any other
// Edge Function invocation). Never trusts client-submitted prices: it
// looks up each product's real current price/stock/VAT itself, using the
// service-role key, and writes the order via that same privileged
// connection (orders/order_items have no public write policy at all).
//
// Payment is NOT processed here yet (that's step 2, GoPay). Every order
// is created with paid = false; card/bank_transfer orders will later get
// a GoPay redirect appended to this same flow, cash-on-delivery (cod)
// simply stays unpaid until you mark it manually in admin.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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

async function getExchangeRate(): Promise<number> {
  const { data } = await supabase
    .from("exchange_rates")
    .select("czk_per_eur")
    .order("rate_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.czk_per_eur ?? 24.5; // same emergency fallback as the frontend
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const body = await req.json();
    const { customer, billing, shipping, shippingMethod, paymentMethod, items, notes } = body;

    if (!customer?.name || !customer?.email || !billing?.street || !shipping?.street) {
      return jsonResponse({ error: "Chybí povinné údaje objednávky." }, 400);
    }
    if (!Array.isArray(items) || items.length === 0) {
      return jsonResponse({ error: "Košík je prázdný." }, 400);
    }
    if (!["gls", "zasilkovna", "ceska_posta"].includes(shippingMethod)) {
      return jsonResponse({ error: "Neplatný způsob dopravy." }, 400);
    }
    if (!["card", "bank_transfer", "cod"].includes(paymentMethod)) {
      return jsonResponse({ error: "Neplatný způsob platby." }, 400);
    }

    const rate = await getExchangeRate();
    const orderItems: Record<string, unknown>[] = [];
    let itemsTotalCzk = 0;

    for (const requested of items) {
      const { data: product, error } = await supabase
        .from("products")
        .select("id, name, price, price_currency, stock, vat_rate_id, vat_rates(rate)")
        .eq("id", requested.productId)
        .single();

      if (error || !product) {
        return jsonResponse({ error: `Produkt ${requested.productId} nebyl nalezen.` }, 400);
      }
      const qty = parseInt(requested.qty, 10);
      if (!qty || qty < 1) {
        return jsonResponse({ error: `Neplatné množství pro ${product.name}.` }, 400);
      }
      if (product.stock < qty) {
        return jsonResponse({ error: `Produkt "${product.name}" již není skladem v požadovaném množství.` }, 400);
      }

      const unitPriceCzk = product.price_currency === "EUR"
        ? Math.round(product.price * rate)
        : product.price;
      const lineTotalCzk = unitPriceCzk * qty;
      itemsTotalCzk += lineTotalCzk;

      orderItems.push({
        product_id: product.id,
        name_snapshot: product.name,
        unit_price: product.price,
        price_currency: product.price_currency,
        unit_price_czk: unitPriceCzk,
        vat_rate: product.vat_rates?.rate ?? null,
        qty,
        line_total_czk: lineTotalCzk,
      });
    }

    // Shipping cost is a placeholder until carrier integration (step 6) is live.
    const shippingCostCzk = 0;
    const totalCzk = itemsTotalCzk + shippingCostCzk;

    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        status: "new",
        created_by: "customer",
        customer_name: customer.name,
        customer_email: customer.email,
        customer_phone: customer.phone || null,
        billing_street: billing.street,
        billing_city: billing.city,
        billing_zip: billing.zip,
        billing_country: billing.country || "Česká republika",
        shipping_street: shipping.street,
        shipping_city: shipping.city,
        shipping_zip: shipping.zip,
        shipping_country: shipping.country || "Česká republika",
        shipping_method: shippingMethod,
        shipping_cost_czk: shippingCostCzk,
        payment_method: paymentMethod,
        paid: false,
        total_czk: totalCzk,
        notes: notes || null,
      })
      .select()
      .single();

    if (orderError) {
      return jsonResponse({ error: "Nepodařilo se vytvořit objednávku: " + orderError.message }, 500);
    }

    const itemsWithOrderId = orderItems.map((it) => ({ ...it, order_id: order.id }));
    const { error: itemsError } = await supabase.from("order_items").insert(itemsWithOrderId);
    if (itemsError) {
      return jsonResponse({ error: "Nepodařilo se uložit položky objednávky: " + itemsError.message }, 500);
    }

    // Decrement stock. Sequential, not a single transaction — acceptable at
    // this shop's scale, but a known small race-condition risk under heavy
    // concurrent checkout traffic.
    for (const it of orderItems as { product_id: string; qty: number }[]) {
      const { data: current } = await supabase.from("products").select("stock").eq("id", it.product_id).single();
      if (current) {
        await supabase.from("products").update({ stock: Math.max(0, current.stock - it.qty) }).eq("id", it.product_id);
      }
    }

    // Best-effort: the order already succeeded, so an email hiccup here
    // shouldn't turn into a failed checkout for the customer.
    try {
      await fetch(`${SUPABASE_URL}/functions/v1/send-order-emails`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
        },
        body: JSON.stringify({ orderId: order.id }),
      });
    } catch (_e) { /* logged server-side via the function's own error handling */ }

    return jsonResponse({ orderId: order.id, totalCzk, items: orderItems });
  } catch (err) {
    return jsonResponse({ error: "Neočekávaná chyba: " + (err as Error).message }, 500);
  }
});
