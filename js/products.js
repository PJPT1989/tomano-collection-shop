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
    eur: row.eur,
    stock: row.stock,
    img: row.img,
    desc: row.description,
    links: row.links || []
  }));
}
