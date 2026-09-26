// Supabase Edge Function: heureka-feed
//
// Serves the Heureka XML product feed. Generated on request rather than
// written to a file, so it can never be stale relative to stock or prices
// and there is no build step to forget.
//
// DEPLOYMENT: JWT verification must be OFF — Heureka's crawler sends no
// Authorization header, and with it on they would simply see a 401 and
// report the feed as broken.
//
// Only in-stock products are listed. Advertising something Heureka sends a
// customer to buy and then can't be bought is a poor experience and counts
// against the shop, so absence is better than a zero-stock listing.

import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

// Absolute URLs are required: Heureka fetches images and follows product
// links from their own servers, so a relative path is useless to them.
const SHOP_BASE_URL = Deno.env.get("SHOP_BASE_URL")!;

// Every product in this shop is the same kind of thing, so these are
// constants rather than columns. CATEGORYTEXT has to be Heureka's own
// taxonomy — anything else and the product lands in a generic category
// where nobody finds it. This is the string the previous shop used.
const CATEGORY_TEXT = "Hobby | Sběratelství | Sběratelské karty";
const MANUFACTURER = "Wizards of the Coast";
// Working days until dispatch. 0 would mean "ships today"; 2 matches what
// the shop actually promises, and overstating it is how you earn
// complaints rather than sales.
const DELIVERY_DAYS = "2";
// Boxes offered from the distributor's stock ("Skladem u dodavatele") ship in
// 5-7 working days, so they must not be advertised as ready to send.
const SUPPLIER_DELIVERY_DAYS = "7";

// Seeded products carry a relative path ("images/products/FRA_DR.jpg"),
// while anything uploaded through admin carries a full Supabase storage
// URL. Only the former needs the shop's address prefixed.
function absoluteImageUrl(base: string, img: string): string {
  return /^https?:\/\//i.test(img) ? img : `${base}/${img.replace(/^\//, "")}`;
}

function xmlEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Descriptions are free text and may contain anything, so they go in CDATA
// rather than being escaped — but a literal "]]>" inside would close the
// section early, so it is split across two sections.
function cdata(value: string): string {
  return `<![CDATA[${String(value ?? "").replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

async function exchangeRate(): Promise<number> {
  const { data } = await supabase
    .from("exchange_rates")
    .select("czk_per_eur")
    .order("rate_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.czk_per_eur ?? 24.5; // same fallback the shop front uses
}

Deno.serve(async () => {
  try {
    const { data: products, error } = await supabase
      .from("products")
      .select("id, name, description, price, price_currency, stock, img, ean, availability, vat_rates(rate)")
      .gt("stock", 0)
      .eq("hidden", false)
      .order("id");

    if (error) {
      return new Response(`Feed unavailable: ${error.message}`, { status: 500 });
    }

    const rate = await exchangeRate();
    const base = SHOP_BASE_URL.replace(/\/$/, "");

    const items = (products || []).map((p) => {
      const priceCzk = p.price_currency === "EUR" ? Math.round(p.price * rate) : p.price;
      const vat = p.vat_rates?.rate;

      return [
        "<SHOPITEM>",
        `<ITEM_ID>${xmlEscape(p.id)}</ITEM_ID>`,
        `<PRODUCTNAME>${xmlEscape(p.name)}</PRODUCTNAME>`,
        p.description ? `<DESCRIPTION>${cdata(p.description)}</DESCRIPTION>` : "",
        `<URL>${xmlEscape(`${base}/product.html?id=${p.id}`)}</URL>`,
        p.img ? `<IMGURL>${xmlEscape(absoluteImageUrl(base, String(p.img)))}</IMGURL>` : "",
        `<PRICE_VAT>${priceCzk}</PRICE_VAT>`,
        vat != null ? `<VAT>${vat}%</VAT>` : "",
        `<MANUFACTURER>${xmlEscape(MANUFACTURER)}</MANUFACTURER>`,
        `<CATEGORYTEXT>${xmlEscape(CATEGORY_TEXT)}</CATEGORYTEXT>`,
        // Omitted rather than sent empty when unknown: a blank EAN is not
        // the same as no EAN, and the element is optional for this category.
        p.ean ? `<EAN>${xmlEscape(p.ean)}</EAN>` : "",
        `<DELIVERY_DATE>${p.availability === "supplier" ? SUPPLIER_DELIVERY_DAYS : DELIVERY_DAYS}</DELIVERY_DATE>`,
        "</SHOPITEM>",
      ].filter(Boolean).join("");
    }).join("");

    const xml = `<?xml version="1.0" encoding="utf-8"?><SHOP>${items}</SHOP>`;

    return new Response(xml, {
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        // Heureka re-fetch on their own schedule; a short cache keeps a
        // burst of requests from hitting the database repeatedly without
        // letting stock drift far from reality.
        "Cache-Control": "public, max-age=600",
      },
    });
  } catch (err) {
    return new Response(`Feed unavailable: ${(err as Error).message}`, { status: 500 });
  }
});
