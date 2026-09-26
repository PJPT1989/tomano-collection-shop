// Supabase Edge Function: supplier-sync
//
// The supplier bot (cernyrytir-news-watcher) mirrors the distributor's
// in-stock booster boxes in this shop and orders them from the distributor
// when a customer buys one (DECISIONS.md, "Products mirrored from the
// distributor"). Products are created by `supplier-product`; this function
// does everything after that, and can touch ONLY products marked
// `supplier_managed` - the owner's own products are never changed.
//
// Request (POST, JSON), header `x-supplier-token: <SUPPLIER_PRODUCT_TOKEN>`,
// one of these actions:
//
//   { action: "sync", dry_run?: bool, confirm_empty?: bool,
//     listed: [{ supplier_name, stock, price }] }
//     `listed` is the distributor's FULL in-stock list (price = our selling
//     price per box, markup already applied). Every supplier-managed product:
//       listed     -> stock = distributor stock minus queued customer lines
//                     not yet ordered there, at most 6; price updated;
//                     hidden if that leaves 0
//       not listed -> hidden, stock 0
//     An empty list is refused unless confirm_empty is set, so a broken read
//     can't hide everything.
//     -> { changed: [{ id, stock, price, hidden }], unmanaged: [names] }
//        `unmanaged` = listed names with no supplier-managed product; the bot
//        decides whether to create them.
//
//   { action: "pending" }
//     -> { items: [{ id, order_number, product_id, supplier_name, qty,
//                    unit_price_czk, status }] }   (status pending only)
//
//   { action: "update_items",
//     items: [{ id, from, status, ordered_qty?, supplier_order_id?, note? }] }
//     Moves queue rows on, but only if they are still in status `from`, so two
//     runs can never both take the same row. Allowed: pending -> ordering |
//     failed; ordering -> ordered | failed | unclear.
//     -> { updated: [ids], skipped: [ids] }
//
//   { action: "adopt", product_id, stock, availability, release_date? }
//     The owner bought this box through the want list: the product becomes
//     theirs (no longer supplier-managed, visible, stock = what was bought).
//     -> { result: "adopted" | "not_managed" }
//
// Errors: { error } with status 400/401/500, passed on verbatim.
// Secrets: SUPPLIER_PRODUCT_TOKEN (shared with the bot and supplier-product),
// plus the built-in SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
// JWT verification stays ON: the bot sends the public anon key as bearer.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_STOCK = 6; // the shop never shows more than this of a distributor box
const OPEN_QUEUE = ["pending", "ordering"]; // customer lines not yet ordered at the distributor
const TRANSITIONS: Record<string, string[]> = {
  pending: ["ordering", "failed"],
  ordering: ["ordered", "failed", "unclear"],
};

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

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function wholeNumber(v: unknown, what: string, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new BadRequest(`invalid ${what} "${v}"`);
  return n;
}

// deno-lint-ignore no-explicit-any
type Db = any;

async function sync(db: Db, body: Record<string, unknown>) {
  if (!Array.isArray(body.listed)) throw new BadRequest("listed must be a list");
  if (body.listed.length === 0 && body.confirm_empty !== true) {
    throw new BadRequest("empty list refused (set confirm_empty if the distributor really has nothing)");
  }
  const listed = new Map<string, { stock: number; price: number }>();
  for (const row of body.listed as Record<string, unknown>[]) {
    const name = str(row?.supplier_name);
    if (!name) throw new BadRequest("listed item without supplier_name");
    const price = Number(row.price);
    if (!Number.isFinite(price) || price <= 0 || price > 1_000_000) throw new BadRequest(`invalid price "${row.price}"`);
    listed.set(name, { stock: wholeNumber(row.stock, "stock", 100_000), price });
  }

  const { data: products, error } = await db.from("products")
    .select("id, supplier_name, stock, price, hidden").eq("supplier_managed", true);
  if (error) throw new Error("products: " + error.message);
  const { data: open, error: queueErr } = await db.from("supplier_order_items")
    .select("product_id, qty").in("status", OPEN_QUEUE);
  if (queueErr) throw new Error("supplier_order_items: " + queueErr.message);
  const queued = new Map<string, number>();
  for (const q of open ?? []) queued.set(q.product_id, (queued.get(q.product_id) ?? 0) + q.qty);

  const changed = [];
  const managedNames = new Set<string>();
  for (const p of products ?? []) {
    managedNames.add(p.supplier_name);
    const offer = listed.get(p.supplier_name);
    const stock = offer ? Math.min(MAX_STOCK, Math.max(0, offer.stock - (queued.get(p.id) ?? 0))) : 0;
    const next = { stock, price: offer ? offer.price : Number(p.price), hidden: stock === 0 };
    if (next.stock === p.stock && next.price === Number(p.price) && next.hidden === p.hidden) continue;
    if (body.dry_run !== true) {
      const { error: upErr } = await db.from("products").update(next)
        .eq("id", p.id).eq("supplier_managed", true);
      if (upErr) throw new Error(`update ${p.id}: ${upErr.message}`);
    }
    changed.push({ id: p.id, ...next });
  }
  const unmanaged = [...listed.keys()].filter((name) => !managedNames.has(name));
  return { changed, unmanaged };
}

async function pending(db: Db) {
  const { data, error } = await db.from("supplier_order_items")
    .select("id, product_id, supplier_name, qty, unit_price_czk, status, orders(order_number)")
    .eq("status", "pending").order("id");
  if (error) throw new Error("supplier_order_items: " + error.message);
  return {
    items: (data ?? []).map((r: Record<string, unknown>) => ({
      id: r.id, order_number: (r.orders as { order_number?: string } | null)?.order_number ?? null,
      product_id: r.product_id, supplier_name: r.supplier_name, qty: r.qty,
      unit_price_czk: Number(r.unit_price_czk), status: r.status,
    })),
  };
}

async function updateItems(db: Db, body: Record<string, unknown>) {
  if (!Array.isArray(body.items) || body.items.length === 0) throw new BadRequest("items must be a non-empty list");
  const updated = [], skipped = [];
  for (const it of body.items as Record<string, unknown>[]) {
    const id = wholeNumber(it?.id, "id", Number.MAX_SAFE_INTEGER);
    const from = str(it.from), status = str(it.status);
    if (!(TRANSITIONS[from] ?? []).includes(status)) throw new BadRequest(`not allowed: ${from} -> ${status}`);
    const change: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
    if (it.ordered_qty != null) change.ordered_qty = wholeNumber(it.ordered_qty, "ordered_qty", 1000);
    if (it.supplier_order_id != null) change.supplier_order_id = str(it.supplier_order_id).slice(0, 100);
    if (it.note != null) change.note = str(it.note).slice(0, 500);
    const { data, error } = await db.from("supplier_order_items").update(change)
      .eq("id", id).eq("status", from).select("id");
    if (error) throw new Error(`update item ${id}: ${error.message}`);
    (data && data.length ? updated : skipped).push(id);
  }
  return { updated, skipped };
}

async function adopt(db: Db, body: Record<string, unknown>, statuses: string[]) {
  const id = str(body.product_id);
  if (!id) throw new BadRequest("product_id is empty");
  const availability = str(body.availability) || "available";
  if (!statuses.includes(availability) || availability === "supplier") {
    throw new BadRequest(`invalid availability "${availability}"`);
  }
  const release = str(body.release_date) || null;
  if (release && !/^\d{4}-\d{2}-\d{2}$/.test(release)) throw new BadRequest(`invalid release_date "${release}"`);
  const change: Record<string, unknown> = {
    supplier_managed: false, hidden: false, stock: wholeNumber(body.stock, "stock", 1000), availability,
  };
  if (release) change.release_date = release;
  const { data, error } = await db.from("products").update(change)
    .eq("id", id).eq("supplier_managed", true).select("id");
  if (error) throw new Error(`adopt ${id}: ${error.message}`);
  return { result: data && data.length ? "adopted" : "not_managed" };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);
  if (!tokenMatches(req.headers.get("x-supplier-token"), Deno.env.get("SUPPLIER_PRODUCT_TOKEN"))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json();
    switch (body?.action) {
      case "sync":
        return jsonResponse(await sync(db, body));
      case "pending":
        return jsonResponse(await pending(db));
      case "update_items":
        return jsonResponse(await updateItems(db, body));
      case "adopt": {
        const { data, error } = await db.from("availability_statuses").select("code");
        if (error) throw new Error("availability_statuses: " + error.message);
        return jsonResponse(await adopt(db, body, (data ?? []).map((r: { code: string }) => r.code)));
      }
      default:
        throw new BadRequest(`unknown action "${body?.action}"`);
    }
  } catch (err) {
    const status = err instanceof BadRequest ? 400 : 500;
    return jsonResponse({ error: (err as Error).message }, status);
  }
});
