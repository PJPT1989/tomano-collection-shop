// Supabase Edge Function: mtgstocks-lookup
//
// Backs the "find links" button on the admin product form. Two modes:
//
//   { search: "bloomburrow" }  -> matching sets and their booster boxes
//   { id: 7196 }               -> that product's name, links and price
//
// This exists as a function rather than a fetch from the admin page for two
// reasons found by testing: MTGStocks send no CORS headers, so the browser
// cannot call them at all; and they reject requests whose User-Agent looks
// automated, returning an HTML error page rather than JSON.
//
// MTGStocks' API is undocumented and carries no terms granting use. It is
// called a handful of times a year from here — once per new product — which
// is the scale this was judged acceptable at.

const MTGSTOCKS_API = "https://api.mtgstocks.com";
// A plain "Mozilla/5.0" is refused; this string is what works.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

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

async function mtgstocks(path: string) {
  const res = await fetch(`${MTGSTOCKS_API}${path}`, {
    headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`MTGStocks vrátil ${res.status}`);
  return await res.json();
}

// Their TCGplayer link is an affiliate redirect crediting MTGStocks, with
// the real destination in the `u` parameter. We want the destination: this
// shop shouldn't be sending its referrals to someone else's account.
function cleanTcgplayerUrl(tcgUrl: string | null): string | null {
  if (!tcgUrl) return null;
  try {
    const wrapped = new URL(tcgUrl).searchParams.get("u");
    return wrapped ? decodeURIComponent(wrapped) : tcgUrl;
  } catch {
    return tcgUrl;
  }
}

// Likewise the Cardmarket link arrives tagged with referrer and utm_*
// parameters. idProduct alone is a perfectly good permanent link.
function cleanCardmarketUrl(cmUrl: string | null): string | null {
  if (!cmUrl) return null;
  try {
    const url = new URL(cmUrl);
    const idProduct = url.searchParams.get("idProduct");
    return idProduct
      ? `https://www.cardmarket.com/en/Magic/Products?idProduct=${idProduct}`
      : cmUrl;
  } catch {
    return cmUrl;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const { search, id } = await req.json();

    if (id) {
      const p = await mtgstocks(`/sealed/${encodeURIComponent(String(id))}`);
      return jsonResponse({
        id: p.id,
        name: p.name,
        setName: p.set?.name ?? null,
        links: {
          tcgplayer: cleanTcgplayerUrl(p.tcgUrl ?? null),
          cardmarket: cleanCardmarketUrl(p.cardmarket?.url ?? null),
          mtgstocks: p.slug ? `https://www.mtgstocks.com/sealed/${p.slug}` : null,
        },
        marketPrice: p.latestPrice?.market ?? null,
      });
    }

    if (!search || String(search).trim().length < 2) {
      return jsonResponse({ error: "Zadejte prosím alespoň dva znaky." }, 400);
    }

    // The index is the whole catalogue (~1 MB) and there is no server-side
    // search, so filtering happens here. Fine for a button pressed a few
    // times a year; it would not be fine on every keystroke.
    const needle = String(search).trim().toLowerCase();
    const sets = await mtgstocks("/sealed");

    const matches = (sets as Record<string, unknown>[])
      .filter((s) =>
        String(s.name ?? "").toLowerCase().includes(needle) ||
        String(s.abbreviation ?? "").toLowerCase() === needle
      )
      .slice(0, 10)
      .map((s) => ({
        setName: s.name,
        abbreviation: s.abbreviation,
        // Booster boxes only — the full list is mostly cases, bundles and
        // single packs, which is noise when adding a box.
        products: ((s.products ?? []) as Record<string, unknown>[])
          .filter((p) => p.type === "boosterbox")
          .map((p) => ({ id: p.id, name: p.name })),
      }))
      .filter((s) => s.products.length > 0);

    return jsonResponse({ sets: matches });
  } catch (err) {
    return jsonResponse({ error: "Vyhledávání selhalo: " + (err as Error).message }, 500);
  }
});
