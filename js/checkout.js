// Checkout page: order summary + form -> calls the create-order Edge
// Function. Orders are always priced in CZK, regardless of the shop's
// CZ/EN display mode, so this intentionally doesn't use displayAmount().

function $(sel) { return document.querySelector(sel); }

function renderCheckoutSummary() {
  const cart = getCart();
  const ids = Object.keys(cart);
  const itemsEl = $("#checkout-items");
  const totalEl = $("#checkout-summary-total");

  if (ids.length === 0) {
    $("#checkout-empty").style.display = "block";
    $("#checkout-view").style.display = "none";
    return null;
  }

  let total = 0;
  const lineItems = [];
  itemsEl.innerHTML = ids.map(id => {
    const p = PRODUCTS.find(x => x.id === id);
    if (!p) return "";
    const qty = cart[id];
    const unitCzk = getCzkPrice(p);
    const subCzk = unitCzk * qty;
    total += subCzk;
    lineItems.push({ productId: id, qty });
    return `
      <div class="checkout-line">
        <span>${p.name} × ${qty}</span>
        <span>${formatKc(subCzk)}</span>
      </div>`;
  }).join("");

  totalEl.textContent = "Celkem: " + formatKc(total);
  return lineItems;
}

let cartLineItems = [];

async function initCheckout() {
  [PRODUCTS] = await Promise.all([fetchProducts(), fetchExchangeRate()]);
  cartLineItems = renderCheckoutSummary();
}

$("#co-same-address").addEventListener("change", (e) => {
  $("#co-shipping-address").style.display = e.target.checked ? "none" : "block";
  ["co-sstreet", "co-scity", "co-szip"].forEach(id => {
    $("#" + id).required = !e.target.checked;
  });
});

$("#checkout-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#checkout-error");
  const btn = $("#checkout-submit-btn");
  errEl.textContent = "";

  if (!cartLineItems || cartLineItems.length === 0) {
    errEl.textContent = "Váš košík je prázdný.";
    return;
  }

  const sameAddress = $("#co-same-address").checked;

  const payload = {
    customer: {
      name: $("#co-name").value.trim(),
      email: $("#co-email").value.trim(),
      phone: $("#co-phone").value.trim(),
    },
    billing: {
      street: $("#co-bstreet").value.trim(),
      city: $("#co-bcity").value.trim(),
      zip: $("#co-bzip").value.trim(),
      country: $("#co-bcountry").value.trim(),
    },
    shipping: sameAddress
      ? {
          street: $("#co-bstreet").value.trim(),
          city: $("#co-bcity").value.trim(),
          zip: $("#co-bzip").value.trim(),
          country: $("#co-bcountry").value.trim(),
        }
      : {
          street: $("#co-sstreet").value.trim(),
          city: $("#co-scity").value.trim(),
          zip: $("#co-szip").value.trim(),
          country: $("#co-scountry").value.trim(),
        },
    shippingMethod: document.querySelector('input[name="shipping-method"]:checked').value,
    paymentMethod: document.querySelector('input[name="payment-method"]:checked').value,
    items: cartLineItems,
    notes: $("#co-notes").value.trim(),
  };

  btn.disabled = true;
  btn.textContent = "Odesílám…";

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/create-order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    const result = await res.json();

    if (!res.ok) {
      throw new Error(result.error || "Objednávku se nepodařilo odeslat.");
    }

    try { localStorage.removeItem(CART_KEY); } catch (e) {}

    $("#checkout-view").style.display = "none";
    $("#checkout-confirmation").style.display = "block";
    $("#confirmation-text").textContent =
      `Vaše objednávka č. ${result.orderNumber} v hodnotě ${formatKc(result.totalCzk)} byla úspěšně přijata. Budeme vás kontaktovat s dalšími informacemi.`;
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Odeslat objednávku";
  }
});

document.addEventListener("DOMContentLoaded", initCheckout);
