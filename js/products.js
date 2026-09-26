// Product data now lives in Supabase (table `products`) instead of being
// hardcoded here. This just loads it at page-load time.
let PRODUCTS = [];

async function fetchProducts() {
  const { data, error } = await supabaseClient
    .from("products")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Failed to load products from Supabase:", error);
    return [];
  }

  return data.map(row => ({
    id: row.id,
    cat: row.cat,
    name: row.name,
    price: row.price,
    stock: row.stock,
    img: row.img,
    desc: row.description,
    links: row.links || [],
    position: row.position || 0,
    vatRateId: row.vat_rate_id,
    priceCurrency: row.price_currency || "CZK",
    availability: row.availability || "available",
    releaseDate: row.release_date || null,
    hidden: row.hidden === true
  }));
}

// Customer-facing names of availability statuses (table `availability_statuses`).
// Falls back to the built-in names so a failed load never breaks the shop.
let AVAILABILITY_LABELS = { available: "Skladem", presale: "Předprodej", supplier: "Skladem u dodavatele" };
// Delivery notes shown after the label, e.g. "odesíláme do 5–7 pracovních dnů".
let AVAILABILITY_NOTES = { supplier: "odesíláme do 5–7 pracovních dnů" };

async function fetchAvailabilityLabels() {
  const { data, error } = await supabaseClient.from("availability_statuses").select("code, label, note");
  if (error || !data) {
    console.error("Failed to load availability statuses:", error);
    return AVAILABILITY_LABELS;
  }
  for (const s of data) if (s.note) AVAILABILITY_NOTES[s.code] = s.note;
  return { ...AVAILABILITY_LABELS, ...Object.fromEntries(data.map(s => [s.code, s.label])) };
}
