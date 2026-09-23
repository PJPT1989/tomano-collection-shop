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

// ---------- Pickup point selection ----------
//
// Two carriers with very different pickers — GLS is a map embedded in the
// page that posts messages to us, Packeta opens a modal from their own
// library — but everything after the choice is identical: one point, shown
// the same way, validated the same way, and standing in for the delivery
// address the same way. So only the pickers differ.

const GLS_MAP_ORIGIN = "https://ps-maps.gls-czech.cz";
const GLS_MAP_URL = `${GLS_MAP_ORIGIN}/?tdetail=3&header=0&ctrcode=CZ&lng=cs`;

// Public by design: the widget cannot work without this reaching the
// browser. The API password it resembles is a different value and lives
// only in a Supabase secret.
const PACKETA_API_KEY = "37394c4898449fea";

const PICKUP_METHODS = ["gls_parcelshop", "zasilkovna"];

// { id, name, street, city, zip, acceptsCod } — carrier-neutral, because
// nothing downstream needs to know which picker produced it.
let selectedPickupPoint = null;

function selectedShippingMethod() {
  return document.querySelector('input[name="shipping-method"]:checked').value;
}

function selectedPaymentMethod() {
  return document.querySelector('input[name="payment-method"]:checked').value;
}

function needsPickupPoint(method) {
  return PICKUP_METHODS.includes(method);
}

// Built as DOM nodes rather than innerHTML: this is data from another
// origin, and text nodes can't smuggle markup into the page.
function renderPickupSelection() {
  const el = $("#pickup-selected");
  el.textContent = "";

  if (!selectedPickupPoint) {
    el.className = "pickup-selected";
    el.textContent = "Vyberte prosím výdejní místo.";
    return;
  }

  el.className = "pickup-selected chosen";
  const name = document.createElement("div");
  name.className = "ps-name";
  name.textContent = selectedPickupPoint.name;
  const address = document.createElement("div");
  address.textContent =
    `${selectedPickupPoint.street}, ${selectedPickupPoint.zip} ${selectedPickupPoint.city}`;
  el.append(name, address);

  // Only worth saying when it actually stands in the customer's way —
  // otherwise it reads as a problem with a pickup point that is fine.
  if (selectedPaymentMethod() === "cod" && !selectedPickupPoint.acceptsCod) {
    const warning = document.createElement("div");
    warning.className = "ps-warning";
    warning.textContent =
      "Toto výdejní místo nepřijímá dobírku — zvolte prosím jiné místo nebo jiný způsob platby.";
    el.append(warning);
  }
}

// --- GLS: inline map, selection arrives by postMessage ---

// GLS's own example listens to every message that arrives, whatever its
// source. Checking the origin keeps any other frame or opener from
// injecting a pickup point of its choosing into the order.
window.addEventListener("message", (event) => {
  if (event.origin !== GLS_MAP_ORIGIN) return;
  if (selectedShippingMethod() !== "gls_parcelshop") return;

  const detail = event.data?.parcelshop?.detail;
  if (!detail?.pclshopid) return;

  // Documented as "t"/"f" (as isparcellocker genuinely is), but the live
  // map sends "1"/"0". Both are accepted because neither source has proven
  // reliable alone, and reading a yes as a no blocks a valid pickup point.
  const cod = detail.iscodhandler;

  selectedPickupPoint = {
    id: detail.pclshopid,
    name: detail.name,
    street: detail.address,
    city: detail.city,
    zip: detail.zipcode,
    acceptsCod: cod === "1" || cod === 1 || cod === "t" || cod === true,
  };
  renderPickupSelection();
});

// --- Packeta: modal opened by their library ---

$("#packeta-pick-btn").addEventListener("click", () => {
  // Restricted to Packeta's own Czech pickup points and Z-BOXes. External
  // carriers' points identify themselves with a carrierId/carrierPickupPointId
  // pair instead of a plain id, which packet creation would have to carry
  // separately — worth enabling deliberately rather than by accident.
  Packeta.Widget.pick(PACKETA_API_KEY, (point) => {
    if (!point) return; // customer closed the widget

    // Packeta flag these as temporarily unusable (vacation, over capacity,
    // closing) and say outright that customers must not select them.
    if (point.error) {
      selectedPickupPoint = null;
      renderPickupSelection();
      $("#checkout-error").textContent =
        "Toto výdejní místo je dočasně nedostupné. Vyberte prosím jiné.";
      return;
    }

    $("#checkout-error").textContent = "";
    selectedPickupPoint = {
      id: point.id,
      // `name` carries the full "Z-BOX Praha 12, Kamýk, Těšíkova 987"
      // description. `place` sounds like the better choice and is for a
      // shop, where it holds the shop's own name — but for a Z-BOX it is
      // literally just "Z-BOX", which tells the customer nothing.
      name: point.name || point.place,
      street: point.street,
      city: point.city,
      zip: point.zip,
      // Packeta govern cash on delivery per account rather than per point,
      // so there is no per-point refusal to warn about here.
      acceptsCod: true,
    };
    renderPickupSelection();
  }, {
    language: "cs",
    country: "cz",
    appIdentity: "tomano-collection",
    vendors: [{ country: "cz" }, { country: "cz", group: "zbox" }],
  });
});

// Delivery goes to the pickup point itself, so the customer's own delivery
// address is meaningless for those methods — and leaving those inputs
// required while hidden would block submission with no visible field to fix.
function updateShippingAddressVisibility() {
  const isPickup = needsPickupPoint(selectedShippingMethod());
  const sameAddress = $("#co-same-address").checked;

  $("#co-same-address-label").style.display = isPickup ? "none" : "block";
  $("#co-shipping-address").style.display = !isPickup && !sameAddress ? "block" : "none";
  ["co-sstreet", "co-scity", "co-szip"].forEach(id => {
    $("#" + id).required = !isPickup && !sameAddress;
  });
}

document.querySelectorAll('input[name="shipping-method"]').forEach(radio => {
  radio.addEventListener("change", () => {
    const method = selectedShippingMethod();
    const isGls = method === "gls_parcelshop";
    const isPacketa = method === "zasilkovna";

    // A GLS shop is not a valid Zásilkovna point and vice versa, so
    // changing carrier discards the choice rather than carrying it over.
    selectedPickupPoint = null;

    $("#pickup-picker").style.display = needsPickupPoint(method) ? "block" : "none";
    $("#gls-map").style.display = isGls ? "block" : "none";
    $("#packeta-pick-btn").style.display = isPacketa ? "inline-block" : "none";

    const map = $("#gls-map");
    if (isGls && !map.getAttribute("src")) map.src = GLS_MAP_URL;

    renderPickupSelection();
    updateShippingAddressVisibility();
  });
});

$("#co-same-address").addEventListener("change", updateShippingAddressVisibility);

// Switching to dobírka has to be able to raise the warning on a pickup
// point that was chosen before the payment method was.
document.querySelectorAll('input[name="payment-method"]').forEach(radio => {
  radio.addEventListener("change", renderPickupSelection);
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

  if (needsPickupPoint(shippingMethod)) {
    if (!selectedPickupPoint) {
      errEl.textContent = "Vyberte prosím výdejní místo.";
      return;
    }
    if (paymentMethod === "cod" && !selectedPickupPoint.acceptsCod) {
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
    // For a pickup-point order the delivery address is the point's, not the
    // customer's — GLS require the label and the data to name the shop, and
    // it keeps invoices and e-mails showing where the parcel is actually
    // going without any of them knowing pickup points exist.
    shipping: needsPickupPoint(shippingMethod)
      ? {
          street: selectedPickupPoint.street,
          city: selectedPickupPoint.city,
          zip: selectedPickupPoint.zip,
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
    pickupPoint: needsPickupPoint(shippingMethod)
      ? { id: selectedPickupPoint.id, name: selectedPickupPoint.name }
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
