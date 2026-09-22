// Supabase Edge Function: send-invoice-email
//
// Given { invoiceId }, downloads that invoice's PDF from the private
// "invoices" storage bucket, and emails it to the order's customer as an
// attachment via Resend. Marks invoices.sent_to_customer_at on success.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_ADDRESS = "Tomano Collection <objednavky@objednavky.tomano.cz>";

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const { invoiceId } = await req.json();

    const { data: invoice, error: invErr } = await supabase.from("invoices").select("*").eq("id", invoiceId).single();
    if (invErr || !invoice) return jsonResponse({ error: "Faktura nenalezena." }, 404);

    const { data: order, error: orderErr } = await supabase.from("orders").select("*").eq("id", invoice.order_id).single();
    if (orderErr || !order) return jsonResponse({ error: "Objednávka k faktuře nenalezena." }, 404);

    const { data: pdfBlob, error: downloadErr } = await supabase.storage.from("invoices").download(invoice.pdf_url);
    if (downloadErr || !pdfBlob) return jsonResponse({ error: "Nepodařilo se stáhnout PDF: " + downloadErr?.message }, 500);

    const pdfBase64 = arrayBufferToBase64(await pdfBlob.arrayBuffer());

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [order.customer_email],
        subject: `Faktura ${invoice.invoice_number} - Tomano Collection`,
        html: `
          <p>Dobrý den ${order.customer_name},</p>
          <p>v příloze zasíláme fakturu č. ${invoice.invoice_number} k vaší objednávce #${order.order_number}.</p>
          <p>Tomano Collection<br>Tománek Petr</p>
        `,
        attachments: [{ filename: `faktura-${invoice.invoice_number}.pdf`, content: pdfBase64 }],
      }),
    });

    if (!res.ok) {
      return jsonResponse({ error: `Resend error ${res.status}: ${await res.text()}` }, 500);
    }

    await supabase.from("invoices").update({ sent_to_customer_at: new Date().toISOString() }).eq("id", invoiceId);

    return jsonResponse({ status: "sent" });
  } catch (err) {
    return jsonResponse({ error: "Neočekávaná chyba: " + (err as Error).message }, 500);
  }
});
