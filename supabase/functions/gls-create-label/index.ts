// Supabase Edge Function: gls-create-label
//
// Creates a GLS parcel for an order and stores the printable label, so a
// packed order can go straight out. Called when an order is moved to
// "Zpracovává se", the same trigger Zásilkovna uses.
//
// Handles both GLS shipping methods: delivery to the customer's address,
// and delivery to a ParcelShop, which is the same parcel plus the PSD
// service carrying the shop's id.
//
// MyGLS is JSON over POST. The one surprise is authentication: the
// password is sent as a SHA-512 digest expressed as an array of 64 byte
// values, not as hex, and not as a string.
//
// An existing shipments row stops a second parcel being created for the
// same order — GLS would happily issue another parcel number, and voiding
// one is a separate call.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Set as Edge Function secrets. MYGLS_API_BASE is what makes going live a
// credential swap rather than a code change:
//   test        https://api.test.mygls.cz/ParcelService.svc/json
//   production  https://api.mygls.cz/ParcelService.svc/json
const MYGLS_API_BASE = Deno.env.get("MYGLS_API_BASE")!;
const MYGLS_USERNAME = Deno.env.get("MYGLS_USERNAME")!;
const MYGLS_PASSWORD = Deno.env.get("MYGLS_PASSWORD")!;
const MYGLS_CLIENT_NUMBER = Deno.env.get("MYGLS_CLIENT_NUMBER")!;

// Identifies the integration that produced the parcel. Added to
// PrintLabels in GLS's 2023-11-13 revision and rejected outright when
// missing ("Webshop engine is required!"), so it postdates most of the
// SDKs and examples in circulation. If GLS turn out to want one of their
// known platform names rather than a shop identifier, this is the string
// to change.
const WEBSHOP_ENGINE = "tomano.cz";

// Sender. Same details as the invoice, kept here rather than imported so
// the function stays a single file that can be pasted into the dashboard.
const SENDER = {
  name: "Tomano Collection",
  contactName: "Petr Tománek",
  street: "Novodvorská",
  houseNumber: "177",
  city: "Praha",
  zipCode: "143 00",
  countryIsoCode: "CZ",
  contactPhone: "602336075",
  contactEmail: "tomanpe8@seznam.cz",
};

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

// MyGLS wants the raw SHA-512 bytes, one integer per byte.
async function passwordBytes(password: string): Promise<number[]> {
  const digest = await crypto.subtle.digest("SHA-512", new TextEncoder().encode(password));
  return Array.from(new Uint8Array(digest));
}

// GLS want street and house number separately, but an order holds one
// line. Take the last whitespace-separated token that starts with a digit
// — that is the number in Czech addresses, including forms like
// "Mazancova 3058/2" and "Náměstí 14. října 1", where a naive
// non-greedy match would take the wrong one.
function splitStreet(line: string): { street: string; houseNumber: string } {
  const match = String(line ?? "").trim().match(/^(.*)\s+(\d[\w/]*)$/);
  return match
    ? { street: match[1].trim(), houseNumber: match[2] }
    : { street: String(line ?? "").trim(), houseNumber: "" };
}

// MyGLS speaks .NET's JSON date format rather than ISO 8601.
function dotNetDate(date: Date): string {
  return `/Date(${date.getTime()})/`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const { orderId } = await req.json();

    const { data: order, error: orderErr } = await supabase
      .from("orders").select("*").eq("id", orderId).single();
    if (orderErr || !order) return jsonResponse({ error: "Objednávka nenalezena." }, 404);

    if (!["gls", "gls_parcelshop"].includes(order.shipping_method)) {
      return jsonResponse({ error: "Objednávka není určena k odeslání GLS." }, 400);
    }
    if (order.shipping_method === "gls_parcelshop" && !order.pickup_point_id) {
      return jsonResponse({ error: "Objednávka nemá vybrané výdejní místo." }, 400);
    }

    const { data: existing } = await supabase
      .from("shipments").select("*").eq("order_id", orderId).maybeSingle();
    if (existing) return jsonResponse({ shipment: existing, alreadyExisted: true });

    const delivery = splitStreet(order.shipping_street);
    // Only collected when the order is genuinely unpaid cash on delivery —
    // charging again for something already paid by card is the kind of
    // mistake a customer only forgives once.
    const codAmount = order.payment_method === "cod" && !order.paid ? order.total_czk : 0;

    const parcel: Record<string, unknown> = {
      ClientNumber: Number(MYGLS_CLIENT_NUMBER),
      ClientReference: order.order_number,
      CODAmount: codAmount,
      CODReference: codAmount > 0 ? order.order_number : null,
      Content: `Objednávka ${order.order_number}`,
      Count: 1,
      PickupDate: dotNetDate(new Date()),
      PickupAddress: {
        Name: SENDER.name,
        Street: SENDER.street,
        HouseNumber: SENDER.houseNumber,
        HouseNumberInfo: "",
        City: SENDER.city,
        ZipCode: SENDER.zipCode,
        CountryIsoCode: SENDER.countryIsoCode,
        ContactName: SENDER.contactName,
        ContactPhone: SENDER.contactPhone,
        ContactEmail: SENDER.contactEmail,
      },
      DeliveryAddress: {
        // For a ParcelShop parcel the shop is the address and the customer
        // is only the contact — which is already how the order stores it.
        Name: order.customer_name,
        Street: delivery.street,
        HouseNumber: delivery.houseNumber,
        HouseNumberInfo: "",
        City: order.shipping_city,
        ZipCode: order.shipping_zip,
        CountryIsoCode: "CZ",
        ContactName: order.customer_name,
        ContactPhone: order.customer_phone || "",
        ContactEmail: order.customer_email,
      },
      ServiceList: order.shipping_method === "gls_parcelshop"
        ? [{ Code: "PSD", PSDParameter: { StringValue: order.pickup_point_id } }]
        : [],
    };

    const res = await fetch(`${MYGLS_API_BASE.replace(/\/$/, "")}/PrintLabels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        Username: MYGLS_USERNAME,
        Password: await passwordBytes(MYGLS_PASSWORD),
        ParcelList: [parcel],
        PrintPosition: 1,
        ShowPrintDialog: false,
        WebshopEngine: WEBSHOP_ENGINE,
      }),
    });
    const result = await res.json();

    // GLS answer 200 with the failure inside the body, so the status code
    // alone says nothing about whether a parcel exists.
    const errors = result?.PrintLabelsErrorList;
    if (!res.ok || (Array.isArray(errors) && errors.length > 0)) {
      const detail = Array.isArray(errors) && errors.length
        ? errors.map((e: Record<string, unknown>) => e.ErrorDescription || e.ErrorCode).join("; ")
        : `HTTP ${res.status}`;
      return jsonResponse({ error: "GLS odmítlo zásilku: " + detail }, 502);
    }

    const info = result?.PrintLabelsInfoList?.[0];
    if (!info) return jsonResponse({ error: "GLS nevrátilo číslo zásilky." }, 502);

    // Labels come back as an array of byte values rather than base64.
    let labelPath: string | null = null;
    if (Array.isArray(result.Labels) && result.Labels.length > 0) {
      const pdf = new Blob([new Uint8Array(result.Labels)], { type: "application/pdf" });
      labelPath = `${order.order_number}-${info.ParcelNumber}.pdf`;
      const { error: uploadError } = await supabase.storage
        .from("labels").upload(labelPath, pdf, { contentType: "application/pdf", upsert: true });
      // The parcel exists at GLS either way, so a failed upload must not
      // look like a failed shipment — record it and let the admin reprint
      // from the GLS portal.
      if (uploadError) labelPath = null;
    }

    const { data: shipment, error: shipmentError } = await supabase
      .from("shipments")
      .insert({
        order_id: orderId,
        carrier: "gls",
        pickup_point_id: order.pickup_point_id,
        carrier_shipment_id: String(info.ParcelId),
        tracking_number: String(info.ParcelNumber),
        label_url: labelPath,
        status: "created",
      })
      .select()
      .single();
    if (shipmentError) {
      return jsonResponse({
        error: `Zásilka ${info.ParcelNumber} byla u GLS vytvořena, ale nepodařilo se ji uložit: ${shipmentError.message}`,
      }, 500);
    }

    return jsonResponse({ shipment, labelStored: labelPath !== null });
  } catch (err) {
    return jsonResponse({ error: "Neočekávaná chyba: " + (err as Error).message }, 500);
  }
});
