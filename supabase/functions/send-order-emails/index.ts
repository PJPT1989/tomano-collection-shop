// Supabase Edge Function: send-order-emails
//
// Given { orderId }, looks up that order + its items and sends two emails
// via Resend: a confirmation to the customer, and a notification to
// admin@tomano.cz. Called from create-order (customer checkout) and from
// the admin order dashboard (manual orders) right after an order is
// created — never fails the order itself if email sending has a problem,
// callers treat this as best-effort.
//
// Sends from a verified subdomain (objednavky.tomano.cz) chosen specifically
// so DNS setup here can't interfere with the existing live eshop's email.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const ADMIN_EMAIL = "admin@tomano.cz";
const FROM_ADDRESS = "Tomano Collection <objednavky@objednavky.tomano.cz>";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SHIPPING_LABELS: Record<string, string> = { gls: "GLS", zasilkovna: "Zásilkovna", ceska_posta: "Česká pošta" };
const PAYMENT_LABELS: Record<string, string> = { card: "Platební karta", bank_transfer: "Bankovní převod", cod: "Dobírka" };

function formatKc(n: number) {
  return n.toLocaleString("cs-CZ") + " Kč";
}

function escapeHtml(s: string) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function itemsTableRows(items: { name_snapshot: string; qty: number; unit_price_czk: number; line_total_czk: number }[]) {
  return items.map((it) => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${escapeHtml(it.name_snapshot)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${it.qty}×</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${formatKc(it.unit_price_czk)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;">${formatKc(it.line_total_czk)}</td>
    </tr>`).join("");
}

// deno-lint-ignore no-explicit-any
function orderSummaryHtml(order: any, items: any[]) {
  return `
    <table style="border-collapse:collapse;width:100%;max-width:560px;">
      <thead>
        <tr style="text-align:left;border-bottom:2px solid #333;">
          <th style="padding:6px 10px;">Produkt</th><th style="padding:6px 10px;">Množství</th>
          <th style="padding:6px 10px;">Cena/ks</th><th style="padding:6px 10px;">Celkem</th>
        </tr>
      </thead>
      <tbody>${itemsTableRows(items)}</tbody>
    </table>
    <p style="font-size:16px;"><strong>Celkem: ${formatKc(order.total_czk)}</strong></p>
    <p>
      Doprava: ${SHIPPING_LABELS[order.shipping_method] || order.shipping_method}<br>
      Platba: ${PAYMENT_LABELS[order.payment_method] || order.payment_method}
    </p>
    <p>
      Doručovací adresa:<br>
      ${escapeHtml(order.shipping_street)}<br>
      ${escapeHtml(order.shipping_city)} ${escapeHtml(order.shipping_zip)}<br>
      ${escapeHtml(order.shipping_country)}
    </p>
    ${order.notes ? `<p>Poznámka: ${escapeHtml(order.notes)}</p>` : ""}
  `;
}

async function sendEmail(to: string, subject: string, html: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  if (!res.ok) {
    throw new Error(`Resend error ${res.status}: ${await res.text()}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const { orderId } = await req.json();
    const { data: order, error: orderErr } = await supabase.from("orders").select("*").eq("id", orderId).single();
    const { data: items, error: itemsErr } = await supabase.from("order_items").select("*").eq("order_id", orderId);

    if (orderErr || !order) {
      return new Response(JSON.stringify({ error: "Objednávka nenalezena." }), { status: 404, headers: CORS_HEADERS });
    }
    if (itemsErr) {
      return new Response(JSON.stringify({ error: itemsErr.message }), { status: 500, headers: CORS_HEADERS });
    }

    const summary = orderSummaryHtml(order, items || []);

    const customerHtml = `
      <p>Dobrý den ${escapeHtml(order.customer_name)},</p>
      <p>děkujeme za vaši objednávku v Tomano Collection. Zde je její shrnutí:</p>
      ${summary}
      <p>Budeme vás v případě potřeby kontaktovat s dalšími informacemi k platbě a doručení.</p>
      <p>Tomano Collection<br>Tománek Petr</p>
    `;

    const adminHtml = `
      <p>Nová objednávka #${order.order_number} od ${escapeHtml(order.customer_name)} (${escapeHtml(order.customer_email)}, ${escapeHtml(order.customer_phone || "bez telefonu")}).</p>
      ${summary}
    `;

    const results: Record<string, string> = { customer: "skipped", admin: "skipped" };

    try {
      await sendEmail(order.customer_email, `Potvrzení objednávky #${order.order_number} - Tomano Collection`, customerHtml);
      results.customer = "sent";
    } catch (e) {
      results.customer = "error: " + (e as Error).message;
    }

    try {
      await sendEmail(ADMIN_EMAIL, `Nová objednávka #${order.order_number}`, adminHtml);
      results.admin = "sent";
    } catch (e) {
      results.admin = "error: " + (e as Error).message;
    }

    return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: CORS_HEADERS });
  }
});
