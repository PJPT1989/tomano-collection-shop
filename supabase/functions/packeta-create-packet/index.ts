// Supabase Edge Function: packeta-create-packet
//
// Hands an order to Zásilkovna (Packeta) so it can be processed and shipped.
// Called when an order is moved to "Zpracovává se" — the point at which you
// have decided to pack it. Not at checkout, because a packet for an order
// that is never paid, gets cancelled, or has its pickup point corrected is
// one you then have to cancel on their side.
//
// Creating the same packet twice would leave two live consignments for one
// order, so an existing shipments row for the order stops a second attempt.
//
// Packeta's API is XML over POST. Responses are either
//   <response><status>ok</status><result>...</result></response>
// or
//   <response><status>fault</status><fault>...</fault><string>...</string></response>

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const PACKETA_API_URL = "https://www.zasilkovna.cz/api/rest";
const PACKETA_API_PASSWORD = Deno.env.get("PACKETA_API_PASSWORD")!;
// The <eshop> field. Comes from Client section -> Sender -> Indication;
// packet creation is rejected without a value Packeta recognises.
const PACKETA_SENDER_INDICATION = Deno.env.get("PACKETA_SENDER_INDICATION")!;
// Weight comes from the products themselves rather than a configured
// constant: a collector box is around 400 g and a draft box around 1100 g,
// and Packeta price in bands, so one figure for everything would be wrong
// in a way that costs money on every order.
//
// Used only when an order line's product has since been deleted, which
// nulls product_id and leaves nothing to read a weight from. Matches the
// column default.
const FALLBACK_ITEM_WEIGHT_G = 1000;

// Outer box and padding, added once per parcel rather than per item —
// three boxes still ship in one carton. Deliberately generous: Zásilkovna
// charge one flat rate up to 5 kg, so an over-estimate costs nothing on a
// normal order, while an under-estimate risks a reweigh. Adjust here if a
// packed parcel on the scale says otherwise.
const PACKAGING_WEIGHT_G = 300;

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

// Customer-supplied text goes into an XML document, so anything that would
// close a tag early has to be neutralised first.
function xmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function tagValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].trim() : null;
}

// A rejected packet puts "Failed to validate attributes. See detail." in
// <string> and the reason that actually matters — an unapproved account, a
// pickup point that won't take the parcel, a malformed phone number — in
// <detail>, one <name>/<fault> pair per offending attribute.
function attributeFaults(xml: string): string[] {
  const detail = tagValue(xml, "detail");
  if (!detail) return [];

  const faults: string[] = [];
  const pattern = /<name>([\s\S]*?)<\/name>\s*<fault>([\s\S]*?)<\/fault>/g;
  let match;
  while ((match = pattern.exec(detail)) !== null) {
    faults.push(`${match[1].trim()}: ${match[2].trim()}`);
  }
  return faults;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const { orderId } = await req.json();

    const { data: order, error: orderErr } = await supabase
      .from("orders").select("*").eq("id", orderId).single();
    if (orderErr || !order) return jsonResponse({ error: "Objednávka nenalezena." }, 404);

    if (order.shipping_method !== "zasilkovna") {
      return jsonResponse({ error: "Objednávka není určena k odeslání Zásilkovnou." }, 400);
    }
    if (!order.pickup_point_id) {
      return jsonResponse({ error: "Objednávka nemá vybrané výdejní místo." }, 400);
    }

    const { data: existing } = await supabase
      .from("shipments").select("*").eq("order_id", orderId).maybeSingle();
    if (existing) {
      return jsonResponse({ shipment: existing, alreadyExisted: true });
    }

    const { data: items } = await supabase
      .from("order_items").select("qty, products(weight_g)").eq("order_id", orderId);
    const contentsGrams = (items || []).reduce(
      (sum, it) => sum + (it.products?.weight_g ?? FALLBACK_ITEM_WEIGHT_G) * it.qty, 0);
    const weightKg = Math.round(((contentsGrams + PACKAGING_WEIGHT_G) / 1000) * 100) / 100;

    const [firstName, ...restOfName] = String(order.customer_name).trim().split(/\s+/);
    // Cash on delivery carries the amount to collect; anything already paid
    // online must go out as zero or the customer is charged twice.
    const cod = order.payment_method === "cod" && !order.paid ? order.total_czk : 0;

    const attributes = [
      `<number>${xmlEscape(order.order_number)}</number>`,
      `<name>${xmlEscape(firstName || order.customer_name)}</name>`,
      `<surname>${xmlEscape(restOfName.join(" "))}</surname>`,
      `<email>${xmlEscape(order.customer_email)}</email>`,
      order.customer_phone ? `<phone>${xmlEscape(order.customer_phone)}</phone>` : "",
      `<addressId>${xmlEscape(order.pickup_point_id)}</addressId>`,
      `<cod>${cod}</cod>`,
      `<value>${order.total_czk}</value>`,
      `<currency>CZK</currency>`,
      `<weight>${weightKg}</weight>`,
      `<eshop>${xmlEscape(PACKETA_SENDER_INDICATION)}</eshop>`,
    ].filter(Boolean).join("");

    const requestXml =
      `<createPacket><apiPassword>${xmlEscape(PACKETA_API_PASSWORD)}</apiPassword>` +
      `<packetAttributes>${attributes}</packetAttributes></createPacket>`;

    const res = await fetch(PACKETA_API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/xml; charset=utf-8" },
      body: requestXml,
    });
    const responseXml = await res.text();

    if (tagValue(responseXml, "status") !== "ok") {
      // Packeta's own wording is far more useful than anything we could
      // infer, and the per-attribute detail more useful still — without it
      // every rejection reads "Failed to validate attributes".
      const faults = attributeFaults(responseXml);
      const reason = faults.length
        ? faults.join("; ")
        : (tagValue(responseXml, "string") || tagValue(responseXml, "fault") || "neznámá chyba");
      return jsonResponse({ error: "Zásilkovna odmítla zásilku: " + reason }, 502);
    }

    const packetId = tagValue(responseXml, "id");
    const barcode = tagValue(responseXml, "barcode");

    const { data: shipment, error: shipmentError } = await supabase
      .from("shipments")
      .insert({
        order_id: orderId,
        carrier: "zasilkovna",
        pickup_point_id: order.pickup_point_id,
        carrier_shipment_id: packetId,
        tracking_number: barcode,
        status: "created",
      })
      .select()
      .single();
    if (shipmentError) {
      // The packet exists at Packeta regardless, so say so rather than
      // implying nothing happened — a retry would otherwise duplicate it.
      return jsonResponse({
        error: `Zásilka ${barcode} byla u Zásilkovny vytvořena, ale nepodařilo se ji uložit: ${shipmentError.message}`,
      }, 500);
    }

    return jsonResponse({ shipment });
  } catch (err) {
    return jsonResponse({ error: "Neočekávaná chyba: " + (err as Error).message }, 500);
  }
});
