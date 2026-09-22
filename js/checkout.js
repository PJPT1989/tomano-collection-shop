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

// ---------- GLS ParcelShop picker ----------

const GLS_MAP_ORIGIN = "https://ps-maps.gls-czech.cz";
const GLS_MAP_URL = `${GLS_MAP_ORIGIN}/?tdetail=3&header=0&ctrcode=CZ&lng=cs`;

let selectedParcelShop = null;

function selectedShippingMethod() {
  return document.querySelector('input[name="shipping-method"]:checked').value;
}

function selectedPaymentMethod() {
  return document.querySelector('input[name="payment-method"]:checked').value;
}

// GLS's documentation describes these flags as "t"/"f" (as isparcellocker
// genuinely is), but the live map sends "1"/"0" for this one. Both are
// accepted because neither source has proven reliable on its own, and
// reading a yes as a no wrongly blocks a valid pickup point.
function parcelShopAcceptsCod(shop) {
  const flag = shop.iscodhandler;
  return flag === "1" || flag === 1 || flag === "t" || flag === true;
}

// Built as DOM nodes rather than innerHTML: this is data from another
// origin, and text nodes can't smuggle markup into the page.
function renderParcelShopSelection() {
  const el = $("#parcelshop-selected");
  el.textContent = "";

  if (!selectedParcelShop) {
    el.className = "parcelshop-selected";
    el.textContent = "Vyberte prosím výdejní místo na mapě níže.";
    return;
  }

  el.className = "parcelshop-selected chosen";
  const name = document.createElement("div");
  name.className = "ps-name";
  name.textContent = selectedParcelShop.name;
  const address = document.createElement("div");
  address.textContent =
    `${selectedParcelShop.address}, ${selectedParcelShop.zipcode} ${selectedParcelShop.city}`;
  el.append(name, address);

  // Only worth saying when it actually stands in the customer's way —
  // otherwise it reads as a problem with a pickup point that is fine.
  if (selectedPaymentMethod() === "cod" && !parcelShopAcceptsCod(selectedParcelShop)) {
    const warning = document.createElement("div");
    warning.className = "ps-warning";
    warning.textContent =
      "Toto výdejní místo nepřijímá dobírku — zvolte prosím jiné místo nebo jiný způsob platby.";
    el.append(warning);
  }
}

// GLS's own example listens to every message that arrives, whatever its
// source. Checking the origin keeps any other frame or opener from
// injecting a pickup point of its choosing into the order.
window.addEventListener("message", (event) => {
  if (event.origin !== GLS_MAP_ORIGIN) return;

  const detail = event.data?.parcelshop?.detail;
  if (!detail?.pclshopid) return;

  selectedParcelShop = {
    id: detail.pclshopid,
    name: detail.name,
    address: detail.address,
    city: detail.city,
    zipcode: detail.zipcode,
    iscodhandler: detail.iscodhandler,
  };
  renderParcelShopSelection();
});

// Delivery goes to the shop itself, so the customer's own delivery address
// is meaningless for that method — and leaving those inputs required while
// hidden would block submission with no visible field to correct.
function updateShippingAddressVisibility() {
  const isParcelShop = selectedShippingMethod() === "gls_parcelshop";
  const sameAddress = $("#co-same-address").checked;

  $("#co-same-address-label").style.display = isParcelShop ? "none" : "block";
  $("#co-shipping-address").style.display = !isParcelShop && !sameAddress ? "block" : "none";
  ["co-sstreet", "co-scity", "co-szip"].forEach(id => {
    $("#" + id).required = !isParcelShop && !sameAddress;
  });
}

document.querySelectorAll('input[name="shipping-method"]').forEach(radio => {
  radio.addEventListener("change", () => {
    const isParcelShop = selectedShippingMethod() === "gls_parcelshop";
    $("#parcelshop-picker").style.display = isParcelShop ? "block" : "none";

    const map = $("#gls-map");
    if (isParcelShop && !map.getAttribute("src")) map.src = GLS_MAP_URL;

    updateShippingAddressVisibility();
  });
});

$("#co-same-address").addEventListener("change", updateShippingAddressVisibility);

// Switching to dobírka has to be able to raise the warning on a pickup
// point that was chosen before the payment method was.
document.querySelectorAll('input[name="payment-method"]').forEach(radio => {
  radio.addEventListener("change", renderParcelShopSelection);
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
  const shippingMethod = selectedShippingMethod();
  const paymentMethod = document.querySelector('input[name="payment-method"]:checked').value;

  if (shippingMethod === "gls_parcelshop") {
    if (!selectedParcelShop) {
      errEl.textContent = "Vyberte prosím výdejní místo GLS na mapě.";
      return;
    }
    if (paymentMethod === "cod" && !parcelShopAcceptsCod(selectedParcelShop)) {
      errEl.textContent =
        "Zvolené výdejní místo nepřijímá dobírku. Vyberte prosím jiné místo nebo jiný způsob platby.";
      return;
    }
  }

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
    // For a ParcelShop order the delivery address is the shop's, not the
    // customer's — GLS require the label and the data to name the shop,
    // and it keeps invoices and e-mails showing where the parcel is
    // actually going without any of them knowing about ParcelShops.
    shipping: shippingMethod === "gls_parcelshop"
      ? {
          street: selectedParcelShop.address,
          city: selectedParcelShop.city,
          zip: selectedParcelShop.zipcode,
          country: "Česká republika",
        }
      : sameAddress
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
    shippingMethod,
    paymentMethod,
    pickupPoint: shippingMethod === "gls_parcelshop"
      ? { id: selectedParcelShop.id, name: selectedParcelShop.name }
      : null,
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

    if (payload.paymentMethod !== "cod") {
      btn.textContent = "Přesměrování na platbu…";
      const payRes = await fetch(`${SUPABASE_URL}/functions/v1/gopay-create-payment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ orderId: result.orderId }),
      });
      const payment = await payRes.json();

      if (payRes.ok && payment.gatewayUrl) {
        window.location.href = payment.gatewayUrl;
        return;
      }

      // The order itself already exists, so a gateway failure is not a failed
      // checkout — show it as placed and let the customer be contacted about
      // payment rather than sending them back to a cart we just emptied.
      $("#checkout-view").style.display = "none";
      $("#checkout-confirmation").style.display = "block";
      $("#confirmation-text").textContent =
        `Vaše objednávka č. ${result.orderNumber} v hodnotě ${formatKc(result.totalCzk)} byla přijata, ale platební bránu se nepodařilo otevřít. Ozveme se vám s pokyny k platbě.`;
      return;
    }

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
