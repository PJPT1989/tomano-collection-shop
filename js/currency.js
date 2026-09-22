// Shared CZK <-> EUR conversion, using the latest rate fetched daily from
// the Czech National Bank (see supabase/functions/fetch-exchange-rate).
// Used by both the shop pages and admin.html.

let EXCHANGE_RATE = 24.5; // emergency fallback only, overwritten below if available

function formatKc(n) {
  return n.toLocaleString("cs-CZ") + " Kč";
}
const FALLBACK_RATE_WARNING = "Nepodařilo se načíst aktuální kurz ČNB, používá se záložní hodnota.";

async function fetchExchangeRate() {
  const { data, error } = await supabaseClient
    .from("exchange_rates")
    .select("czk_per_eur, rate_date")
    .order("rate_date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    console.warn(FALLBACK_RATE_WARNING, error?.message || "no rows yet");
    return EXCHANGE_RATE;
  }
  EXCHANGE_RATE = data.czk_per_eur;
  return EXCHANGE_RATE;
}

// p.price is the amount in p.priceCurrency ("CZK" or "EUR"); the other
// currency is always computed live from today's rate, never stored.
function getCzkPrice(p) {
  return p.priceCurrency === "EUR" ? Math.round(p.price * EXCHANGE_RATE) : p.price;
}

function getEurPrice(p) {
  return p.priceCurrency === "CZK" ? Math.round(p.price / EXCHANGE_RATE) : p.price;
}

// ---------- Price display language (CZK+EUR vs EUR-only) ----------
// This only affects how prices are formatted; all other text stays Czech.

function getPriceLang() {
  try {
    return localStorage.getItem("price_lang") || "cs";
  } catch (e) {
    return "cs";
  }
}

function setPriceLang(lang) {
  try {
    localStorage.setItem("price_lang", lang);
  } catch (e) {}
  document.querySelectorAll(".lang-toggle button").forEach(b => {
    b.classList.toggle("active", b.dataset.lang === lang);
  });
  if (typeof onPriceLangChange === "function") onPriceLangChange();
}

function initLangToggle() {
  const lang = getPriceLang();
  document.querySelectorAll(".lang-toggle button").forEach(b => {
    b.classList.toggle("active", b.dataset.lang === lang);
    b.addEventListener("click", () => setPriceLang(b.dataset.lang));
  });
}

document.addEventListener("DOMContentLoaded", initLangToggle);
