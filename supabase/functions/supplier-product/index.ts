// Supabase Edge Function: supplier-product
//
// Called by the supplier bot (cernyrytir-news-watcher) right after it has
// ordered booster boxes from the distributor, to put the same product on sale
// here. It can do exactly one thing: CREATE a product that doesn't exist yet.
// It never changes, restocks or deletes an existing product - if the product
// is already in the shop it answers "exists" and the bot emails the admin.
//
// Why a function rather than giving the bot database access: the bot runs on
// a server that browses third-party sites. The service role key would give it
// every customer and order; an admin login would let it do anything admin
// can. This function holds the service role itself and exposes only the one
// operation, behind its own token, which can be rotated without touching
// anything else.
//
// Request (POST, JSON), with header `x-supplier-token: <SUPPLIER_PRODUCT_TOKEN>`:
//   { "dry_run": false,
//     "product": { id, cat, name, price, stock, availability, release_date,
//                  ean, weight_g, mtgstocks_id, links, description, image_url } }
// Response:
//   { result: "created" | "would_create" | "exists", product: {...} }
//   { error: "..." } with status 400/401/500 - messages are passed on verbatim.
//
// Secrets: SUPPLIER_PRODUCT_TOKEN (shared with the bot), plus the built-in
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Optional SHOP_BASE_URL for links.
// JWT verification stays ON: the bot sends the public anon key as bearer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Images are only ever fetched from the distributor's own image server.
const IMAGE_HOST = "images.cernyrytir.eu";
const CATEGORIES = ["draft", "collector", "set", "jumpstart"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

class BadRequest extends Error {}

function tokenMatches(given: string | null, expected: string | undefined): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0; // constant time, so the token can't be guessed byte by byte
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function validate(p: Record<string, unknown>, statuses: string[]) {
  const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const id = s(p.id);
  if (!/^[a-z0-9-]+$/.test(id)) throw new BadRequest(`invalid id "${id}"`);
  const cat = s(p.cat);
  if (!CATEGORIES.includes(cat)) throw new BadRequest(`invalid cat "${cat}"`);
  const name = s(p.name);
  if (!name) throw new BadRequest("name is empty");
  const price = Number(p.price);
  if (!Number.isFinite(price) || price <= 0) throw new BadRequest(`invalid price "${p.price}"`);
  const stock = Number(p.stock);
  if (!Number.isInteger(stock) || stock < 0 || stock > 1000) throw new BadRequest(`invalid stock "${p.stock}"`);
  const availability = s(p.availability) || "available";
  if (!statuses.includes(availability)) throw new BadRequest(`unknown availability "${availability}"`);
  const release = s(p.release_date) || null;
  if (release && !/^\d{4}-\d{2}-\d{2}$/.test(release)) throw new BadRequest(`invalid release_date "${release}"`);
  const ean = s(p.ean) || null;
  if (ean && !/^\d{8,14}$/.test(ean)) throw new BadRequest(`invalid ean "${ean}"`);
  const weight = Number(p.weight_g ?? 1000);
  if (!Number.isInteger(weight) || weight <= 0) throw new BadRequest(`invalid weight_g "${p.weight_g}"`);
  const mtgstocks = p.mtgstocks_id == null ? null : Number(p.mtgstocks_id);
  if (mtgstocks !== null && (!Number.isInteger(mtgstocks) || mtgstocks <= 0)) {
    throw new BadRequest(`invalid mtgstocks_id "${p.mtgstocks_id}"`);
  }
  const links = Array.isArray(p.links) ? p.links : [];
  for (const l of links as Record<string, unknown>[]) {
    if (!s(l?.text) || !/^https:\/\//.test(s(l?.href))) throw new BadRequest("invalid link");
  }
  const imageUrl = s(p.image_url);
  let imageHost = "";
  try { imageHost = new URL(imageUrl).host; } catch { /* reported below */ }
  if (imageHost !== IMAGE_HOST) throw new BadRequest(`image_url must be on ${IMAGE_HOST}`);

  return {
    id, cat, name, price, stock, availability, release_date: release, ean, weight_g: weight,
    mtgstocks_id: mtgstocks, links, description: typeof p.description === "string" ? p.description : "",
    image_url: imageUrl,
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  if (!tokenMatches(req.headers.get("x-supplier-token"), Deno.env.get("SUPPLIER_PRODUCT_TOKEN"))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json();
    const dryRun = body?.dry_run === true;

    const { data: statusRows, error: statusErr } = await db.from("availability_statuses").select("code");
    if (statusErr) throw new Error("availability_statuses: " + statusErr.message);
    const p = validate(body?.product ?? {}, (statusRows ?? []).map((r) => r.code));

    // Already in the shop - by id, or the same MTGStocks product under another id?
    let existingQuery = db.from("products").select("id, name, stock, availability").eq("id", p.id);
    if (p.mtgstocks_id) {
      existingQuery = db.from("products").select("id, name, stock, availability")
        .or(`id.eq.${p.id},mtgstocks_id.eq.${p.mtgstocks_id}`);
    }
    const { data: existing, error: existErr } = await existingQuery;
    if (existErr) throw new Error("products: " + existErr.message);
    if (existing && existing.length) return jsonResponse({ result: "exists", product: existing[0] });

    const { data: vat } = await db.from("vat_rates").select("id").eq("name", "21").maybeSingle();
    const row = {
      id: p.id, cat: p.cat, name: p.name, price: p.price, price_currency: "CZK", stock: p.stock,
      availability: p.availability, release_date: p.release_date, ean: p.ean, weight_g: p.weight_g,
      mtgstocks_id: p.mtgstocks_id, links: p.links, description: p.description,
      vat_rate_id: vat?.id ?? null, position: 1, img: "",
    };
    if (dryRun) return jsonResponse({ result: "would_create", product: { ...row, img: p.image_url } });

    // Image: from the distributor's server into our public bucket. No upsert -
    // the timestamped name is unique (see DECISIONS.md on storage upserts).
    const imgRes = await fetch(p.image_url);
    const type = imgRes.headers.get("content-type") ?? "";
    if (!imgRes.ok || !type.startsWith("image/")) throw new Error(`image download failed (${imgRes.status}, ${type})`);
    const bytes = new Uint8Array(await imgRes.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image too large (${bytes.length} bytes)`);
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    const path = `${p.id}-${Date.now()}.${ext}`;
    const { error: upErr } = await db.storage.from("product-images").upload(path, bytes, { contentType: type });
    if (upErr) throw new Error("image upload: " + upErr.message);
    row.img = db.storage.from("product-images").getPublicUrl(path).data.publicUrl;

    // New products go on top of their category: shift the others down by one.
    const { data: sameCat, error: catErr } = await db.from("products").select("id, position").eq("cat", p.cat);
    if (catErr) throw new Error("products: " + catErr.message);
    for (const other of sameCat ?? []) {
      const { error } = await db.from("products").update({ position: (other.position ?? 0) + 1 }).eq("id", other.id);
      if (error) throw new Error("reordering: " + error.message);
    }

    const { error: insErr } = await db.from("products").insert(row);
    if (insErr) throw new Error("insert: " + insErr.message);

    const base = Deno.env.get("SHOP_BASE_URL");
    return jsonResponse({
      result: "created",
      product: { id: row.id, name: row.name, img: row.img, url: base ? `${base}/product.html?id=${row.id}` : null },
    });
  } catch (err) {
    const status = err instanceof BadRequest ? 400 : 500;
    return jsonResponse({ error: (err as Error).message }, status);
  }
});
