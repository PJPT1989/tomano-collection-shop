// Admin order dashboard: order list, detail view, status/paid changes,
// and manual order creation.

const STATUS_LABELS = { new: "Nová", in_progress: "Zpracovává se", done: "Hotovo", cancelled: "Zrušeno" };
const SHIPPING_LABELS = { gls: "GLS", gls_parcelshop: "GLS výdejní místo", zasilkovna: "Zásilkovna", ceska_posta: "Česká pošta" };
const PAYMENT_LABELS = { card: "Platební karta", bank_transfer: "Bankovní převod", cod: "Dobírka" };

let lastOrders = [];
let currentStatusFilter = "all";
let allProductsForOrder = [];
let manualOrderItems = [];
let editingOrderId = null; // null while creating a new order; set to the order id while editing one
let editingShippingCostCzk = 0; // preserved from the order being edited; manual orders don't expose a field for it
let editingOriginalPaid = false; // so paid_at only changes when the "paid" checkbox actually flips during an edit

async function initAdminPage() {
  await loadProductsForOrder();
  await loadOrders();
}

async function triggerOrderEmails(orderId) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-order-emails`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ orderId }),
    });
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

// ---------- Order list ----------

let invoicesByOrder = {};

async function loadOrders() {
  const tbody = $("#order-table-body");
  tbody.innerHTML = `<tr><td colspan="10">Načítání…</td></tr>`;

  const { data, error } = await supabaseClient
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="10">Chyba při načítání: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  const { data: invoices } = await supabaseClient.from("invoices").select("order_id, invoice_number");
  invoicesByOrder = {};
  (invoices || []).forEach(inv => { invoicesByOrder[inv.order_id] = inv.invoice_number; });

  lastOrders = data;
  renderOrderTable();
}

function renderOrderTable() {
  const tbody = $("#order-table-body");
  const rows = currentStatusFilter === "all"
    ? lastOrders
    : lastOrders.filter(o => o.status === currentStatusFilter);

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10">Žádné objednávky.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(o => `
    <tr>
      <td>#${o.order_number}</td>
      <td>${new Date(o.created_at).toLocaleDateString("cs-CZ")}</td>
      <td>${escapeHtml(o.customer_name)}</td>
      <td>${formatKc(o.total_czk)}</td>
      <td>${SHIPPING_LABELS[o.shipping_method] || o.shipping_method}</td>
      <td>${PAYMENT_LABELS[o.payment_method] || o.payment_method}</td>
      <td><span class="paid-badge ${o.paid ? "paid" : "unpaid"}">${o.paid ? "Zaplaceno" : "Nezaplaceno"}</span></td>
      <td>${invoicesByOrder[o.id] ? escapeHtml(invoicesByOrder[o.id]) : "—"}</td>
      <td>
        <select onchange="updateOrderStatus(${o.id}, this.value)">
          ${Object.entries(STATUS_LABELS).map(([val, label]) =>
            `<option value="${val}" ${o.status === val ? "selected" : ""}>${label}</option>`).join("")}
        </select>
      </td>
      <td>
        <button class="btn detail" onclick="openOrderDetail(${o.id})">Detail</button>
        <button class="btn danger" onclick="deleteOrder(${o.id}, '${o.order_number}')">Smazat</button>
      </td>
    </tr>`).join("");
}

document.querySelectorAll("#order-status-filter button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#order-status-filter button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentStatusFilter = btn.dataset.status;
    renderOrderTable();
  });
});

async function updateOrderStatus(id, status) {
  const { error } = await supabaseClient.from("orders").update({ status }).eq("id", id);
  if (error) {
    alert("Změna stavu selhala: " + error.message);
    return;
  }
  const o = lastOrders.find(x => x.id === id);
  if (o) o.status = status;

  // Moving an order into processing is the point at which it's actually
  // being packed, so that's when the carrier is told about it.
  if (status === "in_progress" && o?.shipping_method === "zasilkovna" && o?.pickup_point_id) {
    await createPacketaShipment(id);
  }
}

// Shown in the page rather than through alert(): a carrier refusing a
// shipment is something you need to read and act on, and native dialogs
// can be suppressed by the browser — silently, which is the worst way for
// this particular message to fail.
function showOrderActionStatus(message, kind) {
  const el = $("#order-action-status");
  el.textContent = message;
  el.style.display = "block";
  el.style.background = kind === "error" ? "#fdecea" : "#eafaf1";
  el.style.color = kind === "error" ? "#c0392b" : "#1e7e45";
}

// The function refuses to create a second packet for an order that already
// has one, so flipping an order back and forth through "Zpracovává se"
// can't produce duplicate consignments.
async function createPacketaShipment(orderId) {
  showOrderActionStatus("Předávám zásilku Zásilkovně…", "info");

  const res = await fetch(`${SUPABASE_URL}/functions/v1/packeta-create-packet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ orderId }),
  });
  const result = await res.json();

  if (!res.ok) {
    showOrderActionStatus("Předání Zásilkovně selhalo: " + (result.error || res.statusText), "error");
    return;
  }
  if (result.alreadyExisted) {
    showOrderActionStatus(`Zásilka již existuje: ${result.shipment.tracking_number}`, "info");
    return;
  }

  showOrderActionStatus(`Zásilka předána Zásilkovně. Číslo zásilky: ${result.shipment.tracking_number}`, "info");
  loadOrders();
}

async function deleteOrder(id, orderNumber) {
  if (!confirm(`Opravdu smazat objednávku #${orderNumber}? Tuto akci nelze vrátit zpět.`)) return;

  // Order items/shipments/invoices cascade-delete at the DB level, but the
  // invoice's PDF file in storage does not — remove it first or it becomes
  // an orphaned file with no row pointing at it.
  const { data: invoice } = await supabaseClient.from("invoices").select("pdf_url").eq("order_id", id).maybeSingle();
  if (invoice?.pdf_url) {
    await supabaseClient.storage.from("invoices").remove([invoice.pdf_url]);
  }

  const { error } = await supabaseClient.from("orders").delete().eq("id", id);
  if (error) {
    alert("Smazání objednávky selhalo: " + error.message);
    return;
  }
  showOrderList();
}

function showOrderList() {
  $("#order-list-view").style.display = "block";
  $("#order-detail-view").style.display = "none";
  loadOrders();
}

$("#back-to-list-btn").addEventListener("click", showOrderList);

// ---------- Order detail (view existing) ----------

async function openOrderDetail(id) {
  const { data: order, error: orderErr } = await supabaseClient.from("orders").select("*").eq("id", id).single();
  const { data: items, error: itemsErr } = await supabaseClient.from("order_items").select("*").eq("order_id", id);
  const { data: invoice } = await supabaseClient.from("invoices").select("*").eq("order_id", id).maybeSingle();
  const { data: shipment } = await supabaseClient.from("shipments").select("*").eq("order_id", id).maybeSingle();

  if (orderErr || itemsErr) {
    alert("Nepodařilo se načíst objednávku: " + (orderErr?.message || itemsErr?.message));
    return;
  }

  $("#order-list-view").style.display = "none";
  $("#order-detail-view").style.display = "block";
  $("#order-detail-title").textContent = `Objednávka #${order.order_number}`;

  const itemsHtml = items.map(it => `
    <tr>
      <td>${escapeHtml(it.name_snapshot)}</td>
      <td>${it.qty}</td>
      <td>${formatKc(it.unit_price_czk)}</td>
      <td>${it.vat_rate != null ? it.vat_rate + "%" : "—"}</td>
      <td>${formatKc(it.line_total_czk)}</td>
    </tr>`).join("");

  $("#order-detail-panel").innerHTML = `
    <div style="display:flex; gap:10px; margin-bottom:20px;">
      <button class="btn detail" onclick="openEditOrderForm(${order.id})">Upravit objednávku</button>
      <button class="btn danger" onclick="deleteOrder(${order.id}, '${order.order_number}')">Smazat objednávku</button>
    </div>

    <div class="admin-form-grid">
      <div><strong>Zákazník</strong><br>${escapeHtml(order.customer_name)}<br>${escapeHtml(order.customer_email)}<br>${escapeHtml(order.customer_phone || "")}</div>
      <div><strong>Fakturační adresa</strong><br>${escapeHtml(order.billing_street)}<br>${escapeHtml(order.billing_city)} ${escapeHtml(order.billing_zip)}<br>${escapeHtml(order.billing_country)}</div>
      <div><strong>Doručovací adresa</strong><br>${escapeHtml(order.shipping_street)}<br>${escapeHtml(order.shipping_city)} ${escapeHtml(order.shipping_zip)}<br>${escapeHtml(order.shipping_country)}
        ${order.pickup_point_id ? `<br><br><strong>Výdejní místo</strong><br>${escapeHtml(order.pickup_point_name)}<br><span style="color:#888; font-size:12px;">${escapeHtml(order.pickup_point_id)}</span>` : ""}
      </div>
      <div>
        <strong>Doprava a platba</strong><br>
        ${SHIPPING_LABELS[order.shipping_method] || order.shipping_method}<br>
        ${PAYMENT_LABELS[order.payment_method] || order.payment_method}<br>
        <span class="paid-badge ${order.paid ? "paid" : "unpaid"}" style="margin-top:6px; display:inline-block;">${order.paid ? "Zaplaceno" : "Nezaplaceno"}</span>
        <button class="btn detail" style="margin-left:8px;" onclick="toggleOrderPaid(${order.id}, ${!order.paid})">${order.paid ? "Označit jako nezaplacené" : "Označit jako zaplacené"}</button>
      </div>
    </div>

    ${order.notes ? `<p><strong>Poznámka:</strong> ${escapeHtml(order.notes)}</p>` : ""}

    <h3 style="margin-top:24px;">Položky objednávky</h3>
    <table class="cart-table">
      <thead><tr><th>Produkt</th><th>Množství</th><th>Cena/ks</th><th>DPH</th><th>Celkem</th></tr></thead>
      <tbody>${itemsHtml}</tbody>
    </table>
    <div class="checkout-summary-total">Celkem: ${formatKc(order.total_czk)}</div>

    <div style="margin-top:20px;">
      <button class="btn detail" id="resend-email-btn" onclick="resendOrderEmails(${order.id})">Znovu odeslat potvrzovací e-mail</button>
      <span id="resend-email-status" style="margin-left:10px; font-size:13px; color:#888;"></span>
    </div>

    ${shipment ? `
      <div class="admin-section-divider"></div>
      <h3>Zásilka</h3>
      <p><strong>${escapeHtml(SHIPPING_LABELS[order.shipping_method] || order.shipping_method)}</strong>
      &middot; číslo zásilky ${escapeHtml(shipment.tracking_number || "—")}
      &middot; předáno ${new Date(shipment.created_at).toLocaleDateString("cs-CZ")}</p>
    ` : ""}

    <div class="admin-section-divider"></div>
    <h3>Faktura</h3>
    <div id="invoice-section">${invoiceSectionHtml(order.id, invoice)}</div>
  `;
}

function invoiceSectionHtml(orderId, invoice) {
  if (!invoice) {
    return `<button class="btn buy" onclick="createInvoiceForOrder(${orderId})" id="create-invoice-btn">Vytvořit fakturu</button>
      <span id="invoice-status" style="margin-left:10px; font-size:13px; color:#888;"></span>`;
  }
  return `
    <p><strong>Faktura ${escapeHtml(invoice.invoice_number)}</strong> &middot; vystavena ${new Date(invoice.issued_at).toLocaleDateString("cs-CZ")}
    ${invoice.sent_to_customer_at ? `&middot; odeslána zákazníkovi ${new Date(invoice.sent_to_customer_at).toLocaleDateString("cs-CZ")}` : ""}</p>
    <button class="btn detail" onclick="downloadInvoice(${invoice.id}, ${escapeAttr(JSON.stringify(invoice.pdf_url))})">Stáhnout PDF</button>
    <button class="btn detail" onclick="sendInvoiceEmail(${invoice.id})">Odeslat e-mailem zákazníkovi</button>
    <span id="invoice-status" style="margin-left:10px; font-size:13px; color:#888;"></span>
  `;
}

async function createInvoiceForOrder(orderId) {
  const statusEl = $("#invoice-status");
  const btn = $("#create-invoice-btn");
  btn.disabled = true;
  statusEl.textContent = "Vytvářím fakturu…";

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-invoice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ orderId }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Vytvoření faktury selhalo.");

    $("#invoice-section").innerHTML = invoiceSectionHtml(orderId, result.invoice);
  } catch (err) {
    statusEl.textContent = "Chyba: " + err.message;
    btn.disabled = false;
  }
}

async function downloadInvoice(invoiceId, path) {
  const statusEl = $("#invoice-status");
  statusEl.textContent = "";
  // Open the window synchronously, still inside the click's user-gesture,
  // then navigate it once the signed URL is ready — opening it only after
  // the await risks being blocked as a popup in some browsers.
  const win = window.open("", "_blank");
  const { data, error } = await supabaseClient.storage.from("invoices").createSignedUrl(path, 300);
  if (error) {
    if (win) win.close();
    statusEl.textContent = "Chyba: " + error.message;
    return;
  }
  if (win) {
    win.location.href = data.signedUrl;
  } else {
    statusEl.textContent = "Prohlížeč zablokoval otevření okna — povolte vyskakovací okna pro tuto stránku.";
  }
}

async function sendInvoiceEmail(invoiceId) {
  const statusEl = $("#invoice-status");
  statusEl.textContent = "Odesílám…";
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-invoice-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_ANON_KEY}` },
      body: JSON.stringify({ invoiceId }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error || "Odeslání selhalo.");
    statusEl.textContent = "Faktura odeslána.";
  } catch (err) {
    statusEl.textContent = "Chyba: " + err.message;
  }
}

async function resendOrderEmails(id) {
  const statusEl = $("#resend-email-status");
  statusEl.textContent = "Odesílám…";
  const result = await triggerOrderEmails(id);
  if (result.error) {
    statusEl.textContent = "Chyba: " + result.error;
  } else {
    statusEl.textContent = `Zákazník: ${result.customer}, admin: ${result.admin}`;
  }
}

async function toggleOrderPaid(id, newPaid) {
  const { error } = await supabaseClient
    .from("orders")
    .update({ paid: newPaid, paid_at: newPaid ? new Date().toISOString() : null })
    .eq("id", id);
  if (error) {
    alert("Změna se nepodařila: " + error.message);
    return;
  }
  openOrderDetail(id);
}

// ---------- Manual order creation ----------

async function loadProductsForOrder() {
  const { data, error } = await supabaseClient
    .from("products")
    .select("id, name, price, price_currency, stock, vat_rates(rate)")
    .order("name", { ascending: true });
  if (!error) allProductsForOrder = data;
}

$("#new-order-btn").addEventListener("click", openNewOrderForm);

function openNewOrderForm() {
  editingOrderId = null;
  editingShippingCostCzk = 0;
  manualOrderItems = [];
  renderOrderForm("Nová objednávka", null);
}

async function openEditOrderForm(id) {
  const { data: order, error: orderErr } = await supabaseClient.from("orders").select("*").eq("id", id).single();
  const { data: items, error: itemsErr } = await supabaseClient.from("order_items").select("*").eq("order_id", id);
  if (orderErr || itemsErr) {
    alert("Nepodařilo se načíst objednávku: " + (orderErr?.message || itemsErr?.message));
    return;
  }

  editingOrderId = id;
  editingShippingCostCzk = order.shipping_cost_czk;
  editingOriginalPaid = order.paid;
  manualOrderItems = items.map(it => ({
    productId: it.product_id,
    name: it.name_snapshot,
    qty: it.qty,
    unitPriceCzk: it.unit_price_czk,
    vatRate: it.vat_rate,
  }));
  renderOrderForm(`Upravit objednávku #${order.order_number}`, order);
}

// Shared by both the "new order" and "edit order" flows. `order` is null
// when creating; when editing it pre-fills every field from the existing
// row (manualOrderItems is already populated by openEditOrderForm before
// this runs).
function renderOrderForm(title, order) {
  $("#order-list-view").style.display = "none";
  $("#order-detail-view").style.display = "block";
  $("#order-detail-title").textContent = title;

  const productOptions = allProductsForOrder.map(p =>
    `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");

  const sameAddress = !order || (
    order.shipping_street === order.billing_street &&
    order.shipping_city === order.billing_city &&
    order.shipping_zip === order.billing_zip &&
    order.shipping_country === order.billing_country
  );

  $("#order-detail-panel").innerHTML = `
    <form id="manual-order-form">
      <h2>Zákazník</h2>
      <div class="admin-form-grid">
        <label class="span-2">Jméno a příjmení<br><input type="text" id="mo-name" required value="${escapeAttr(order?.customer_name || "")}"></label>
        <label>E-mail<br><input type="email" id="mo-email" required value="${escapeAttr(order?.customer_email || "")}"></label>
        <label>Telefon<br><input type="tel" id="mo-phone" value="${escapeAttr(order?.customer_phone || "")}"></label>
      </div>

      <h2 style="margin-top:20px;">Fakturační adresa</h2>
      <div class="admin-form-grid">
        <label class="span-2">Ulice a č.p.<br><input type="text" id="mo-bstreet" required value="${escapeAttr(order?.billing_street || "")}"></label>
        <label>Město<br><input type="text" id="mo-bcity" required value="${escapeAttr(order?.billing_city || "")}"></label>
        <label>PSČ<br><input type="text" id="mo-bzip" required value="${escapeAttr(order?.billing_zip || "")}"></label>
        <label class="span-2">Země<br><input type="text" id="mo-bcountry" value="${escapeAttr(order?.billing_country || "Česká republika")}" required></label>
      </div>

      <label style="display:block; margin-top:14px; font-weight:600;">
        <input type="checkbox" id="mo-same-address" ${sameAddress ? "checked" : ""}> Doručovací adresa je stejná jako fakturační
      </label>
      <div id="mo-shipping-address" style="display:${sameAddress ? "none" : "block"};">
        <h2 style="margin-top:20px;">Doručovací adresa</h2>
        <div class="admin-form-grid">
          <label class="span-2">Ulice a č.p.<br><input type="text" id="mo-sstreet" value="${escapeAttr(order?.shipping_street || "")}"></label>
          <label>Město<br><input type="text" id="mo-scity" value="${escapeAttr(order?.shipping_city || "")}"></label>
          <label>PSČ<br><input type="text" id="mo-szip" value="${escapeAttr(order?.shipping_zip || "")}"></label>
          <label class="span-2">Země<br><input type="text" id="mo-scountry" value="${escapeAttr(order?.shipping_country || "Česká republika")}"></label>
        </div>
      </div>

      <h2 style="margin-top:20px;">Doprava a platba</h2>
      <div class="admin-form-grid">
        <label>Způsob dopravy<br>
          <select id="mo-shipping-method">
            <option value="gls" ${order?.shipping_method === "gls" ? "selected" : ""}>GLS</option>
            <!-- Only selectable for an order that already has a pickup
                 point: admin has no map to choose one with, and the DB
                 rejects this method without one. Present so that editing a
                 ParcelShop order doesn't silently fall back to "GLS". -->
            <option value="gls_parcelshop" ${order?.shipping_method === "gls_parcelshop" ? "selected" : ""} ${order?.pickup_point_id ? "" : "disabled"}>GLS výdejní místo</option>
            <option value="zasilkovna" ${order?.shipping_method === "zasilkovna" ? "selected" : ""}>Zásilkovna</option>
            <option value="ceska_posta" ${order?.shipping_method === "ceska_posta" ? "selected" : ""}>Česká pošta</option>
          </select>
        </label>
        <label>Způsob platby<br>
          <select id="mo-payment-method">
            <option value="card" ${order?.payment_method === "card" ? "selected" : ""}>Platební karta</option>
            <option value="bank_transfer" ${order?.payment_method === "bank_transfer" ? "selected" : ""}>Bankovní převod</option>
            <option value="cod" ${order?.payment_method === "cod" ? "selected" : ""}>Dobírka</option>
          </select>
        </label>
      </div>
      <label style="display:block; margin-top:10px;"><input type="checkbox" id="mo-paid" ${order?.paid ? "checked" : ""}> Objednávka je již zaplacena</label>

      <h2 style="margin-top:20px;">Položky objednávky</h2>
      <div class="admin-form-grid">
        <label class="span-2">Produkt<br>
          <select id="mo-item-product">${productOptions}</select>
        </label>
        <label>Množství<br><input type="number" id="mo-item-qty" value="1" min="1"></label>
        <label>Cena/ks (Kč)<br><input type="number" id="mo-item-price" min="0" step="0.01"></label>
      </div>
      <button type="button" id="mo-add-item-btn" class="btn detail" style="margin-top:8px;">+ Přidat položku</button>

      <table class="cart-table" style="margin-top:16px;">
        <thead><tr><th>Produkt</th><th>Množství</th><th>Cena/ks</th><th>Celkem</th><th></th></tr></thead>
        <tbody id="mo-items-body"></tbody>
      </table>
      <div class="checkout-summary-total" id="mo-total">Celkem: 0 Kč</div>

      <h2 style="margin-top:20px;">Poznámka</h2>
      <textarea id="mo-notes" rows="3" style="width:100%; padding:9px; border:1px solid var(--border); border-radius:3px;">${escapeHtml(order?.notes || "")}</textarea>

      <div id="mo-error" style="color:#c0392b; margin-top:14px;"></div>

      <div style="margin-top:20px; display:flex; gap:10px;">
        <button type="submit" id="mo-submit-btn" class="btn buy">${order ? "Uložit změny" : "Vytvořit objednávku"}</button>
      </div>
    </form>
  `;

  $("#mo-same-address").addEventListener("change", (e) => {
    $("#mo-shipping-address").style.display = e.target.checked ? "none" : "block";
  });

  $("#mo-item-product").addEventListener("change", updateManualItemPricePreview);
  updateManualItemPricePreview();

  $("#mo-add-item-btn").addEventListener("click", addManualOrderItem);
  $("#manual-order-form").addEventListener("submit", submitManualOrder);

  renderManualOrderItems();
}

function updateManualItemPricePreview() {
  const productId = $("#mo-item-product").value;
  const product = allProductsForOrder.find(p => p.id === productId);
  if (!product) return;
  const czk = getCzkPrice({ price: product.price, priceCurrency: product.price_currency });
  $("#mo-item-price").value = czk;
}

function addManualOrderItem() {
  const productId = $("#mo-item-product").value;
  const product = allProductsForOrder.find(p => p.id === productId);
  const qty = parseInt($("#mo-item-qty").value, 10);
  const unitPriceCzk = parseFloat($("#mo-item-price").value);

  if (!product || !qty || qty < 1 || isNaN(unitPriceCzk)) {
    alert("Vyplňte prosím produkt, množství a cenu.");
    return;
  }

  manualOrderItems.push({
    productId: product.id,
    name: product.name,
    qty,
    unitPriceCzk,
    vatRate: product.vat_rates?.rate ?? null,
  });
  renderManualOrderItems();
}

function removeManualOrderItem(index) {
  manualOrderItems.splice(index, 1);
  renderManualOrderItems();
}

function renderManualOrderItems() {
  const tbody = $("#mo-items-body");
  let total = 0;
  tbody.innerHTML = manualOrderItems.map((it, i) => {
    const lineTotal = it.unitPriceCzk * it.qty;
    total += lineTotal;
    return `
      <tr>
        <td>${escapeHtml(it.name)}</td>
        <td>${it.qty}</td>
        <td>${formatKc(it.unitPriceCzk)}</td>
        <td>${formatKc(lineTotal)}</td>
        <td><button type="button" class="remove" onclick="removeManualOrderItem(${i})">Odebrat</button></td>
      </tr>`;
  }).join("");
  $("#mo-total").textContent = "Celkem: " + formatKc(total);
}

async function submitManualOrder(e) {
  e.preventDefault();
  const errEl = $("#mo-error");
  const btn = $("#mo-submit-btn");
  errEl.textContent = "";

  if (manualOrderItems.length === 0) {
    errEl.textContent = "Přidejte prosím alespoň jednu položku.";
    return;
  }

  const isEdit = editingOrderId !== null;
  const sameAddress = $("#mo-same-address").checked;
  const itemsTotalCzk = manualOrderItems.reduce((sum, it) => sum + it.unitPriceCzk * it.qty, 0);
  const totalCzk = itemsTotalCzk + (isEdit ? editingShippingCostCzk : 0);
  const paid = $("#mo-paid").checked;

  const orderFields = {
    customer_name: $("#mo-name").value.trim(),
    customer_email: $("#mo-email").value.trim(),
    customer_phone: $("#mo-phone").value.trim() || null,
    billing_street: $("#mo-bstreet").value.trim(),
    billing_city: $("#mo-bcity").value.trim(),
    billing_zip: $("#mo-bzip").value.trim(),
    billing_country: $("#mo-bcountry").value.trim(),
    shipping_street: sameAddress ? $("#mo-bstreet").value.trim() : $("#mo-sstreet").value.trim(),
    shipping_city: sameAddress ? $("#mo-bcity").value.trim() : $("#mo-scity").value.trim(),
    shipping_zip: sameAddress ? $("#mo-bzip").value.trim() : $("#mo-szip").value.trim(),
    shipping_country: sameAddress ? $("#mo-bcountry").value.trim() : $("#mo-scountry").value.trim(),
    shipping_method: $("#mo-shipping-method").value,
    payment_method: $("#mo-payment-method").value,
    paid,
    total_czk: totalCzk,
    notes: $("#mo-notes").value.trim() || null,
    paid_at: isEdit
      ? (paid === editingOriginalPaid ? undefined : (paid ? new Date().toISOString() : null))
      : undefined,
  };

  btn.disabled = true;
  btn.textContent = isEdit ? "Ukládám…" : "Vytvářím…";

  try {
    const itemRowsBase = manualOrderItems.map(it => ({
      product_id: it.productId,
      name_snapshot: it.name,
      unit_price: it.unitPriceCzk,
      price_currency: "CZK",
      unit_price_czk: it.unitPriceCzk,
      vat_rate: it.vatRate,
      qty: it.qty,
      line_total_czk: it.unitPriceCzk * it.qty,
    }));

    if (isEdit) {
      const id = editingOrderId;
      const { data: oldItems, error: oldItemsError } = await supabaseClient
        .from("order_items").select("product_id, qty").eq("order_id", id);
      if (oldItemsError) throw oldItemsError;

      const { error: orderError } = await supabaseClient.from("orders")
        .update(orderFields).eq("id", id);
      if (orderError) throw orderError;

      const { error: deleteItemsError } = await supabaseClient
        .from("order_items").delete().eq("order_id", id);
      if (deleteItemsError) throw deleteItemsError;

      const { error: itemsError } = await supabaseClient.from("order_items")
        .insert(itemRowsBase.map(row => ({ ...row, order_id: id })));
      if (itemsError) throw itemsError;

      await adjustStockForItemChange(oldItems || [], manualOrderItems);
      await regenerateInvoiceIfExists(id);

      editingOrderId = null;
      openOrderDetail(id);
    } else {
      const { data: order, error: orderError } = await supabaseClient.from("orders").insert({
        ...orderFields,
        status: "new",
        created_by: "admin",
        shipping_cost_czk: 0,
        paid_at: paid ? new Date().toISOString() : null,
      }).select().single();
      if (orderError) throw orderError;

      const { error: itemsError } = await supabaseClient.from("order_items")
        .insert(itemRowsBase.map(row => ({ ...row, order_id: order.id })));
      if (itemsError) throw itemsError;

      for (const it of manualOrderItems) {
        const { data: current } = await supabaseClient.from("products").select("stock").eq("id", it.productId).single();
        if (current) {
          await supabaseClient.from("products").update({ stock: Math.max(0, current.stock - it.qty) }).eq("id", it.productId);
        }
      }

      triggerOrderEmails(order.id); // best-effort, don't block on it
      showOrderList();
    }
  } catch (err) {
    errEl.textContent = (isEdit ? "Uložení změn selhalo: " : "Vytvoření objednávky selhalo: ") + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = isEdit ? "Uložit změny" : "Vytvořit objednávku";
  }
}

// When an order's items are edited, stock needs to move by the difference
// between the old and new quantity per product — not just be decremented
// again — since the original quantity was already taken out of stock when
// the order was first created.
async function adjustStockForItemChange(oldItems, newItems) {
  const oldQtyByProduct = {};
  for (const it of oldItems) {
    if (!it.product_id) continue;
    oldQtyByProduct[it.product_id] = (oldQtyByProduct[it.product_id] || 0) + it.qty;
  }
  const newQtyByProduct = {};
  for (const it of newItems) {
    if (!it.productId) continue;
    newQtyByProduct[it.productId] = (newQtyByProduct[it.productId] || 0) + it.qty;
  }

  const productIds = new Set([...Object.keys(oldQtyByProduct), ...Object.keys(newQtyByProduct)]);
  for (const productId of productIds) {
    const delta = (newQtyByProduct[productId] || 0) - (oldQtyByProduct[productId] || 0);
    if (delta === 0) continue;
    const { data: current } = await supabaseClient.from("products").select("stock").eq("id", productId).single();
    if (current) {
      await supabaseClient.from("products").update({ stock: Math.max(0, current.stock - delta) }).eq("id", productId);
    }
  }
}

// If the order already had an invoice issued, its content is now stale —
// recreate the PDF (same invoice number, same issue date) so it reflects
// the edited order instead of leaving a mismatched document on file.
async function regenerateInvoiceIfExists(orderId) {
  const { data: invoice } = await supabaseClient.from("invoices").select("id").eq("order_id", orderId).maybeSingle();
  if (!invoice) return;

  const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-invoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify({ orderId, regenerate: true }),
  });
  if (!res.ok) {
    const result = await res.json().catch(() => ({}));
    alert("Objednávka byla uložena, ale fakturu se nepodařilo znovu vygenerovat: " + (result.error || res.statusText));
  }
}
