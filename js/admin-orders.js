// Admin order dashboard: order list, detail view, status/paid changes,
// and manual order creation.

const STATUS_LABELS = { new: "Nová", in_progress: "Zpracovává se", done: "Hotovo", cancelled: "Zrušeno" };
const SHIPPING_LABELS = { gls: "GLS", zasilkovna: "Zásilkovna", ceska_posta: "Česká pošta" };
const PAYMENT_LABELS = { card: "Platební karta", bank_transfer: "Bankovní převod", cod: "Dobírka" };

let lastOrders = [];
let currentStatusFilter = "all";
let allProductsForOrder = [];
let manualOrderItems = [];

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
      <td>#${o.id}</td>
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
      <td><button class="btn detail" onclick="openOrderDetail(${o.id})">Detail</button></td>
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

  if (orderErr || itemsErr) {
    alert("Nepodařilo se načíst objednávku: " + (orderErr?.message || itemsErr?.message));
    return;
  }

  $("#order-list-view").style.display = "none";
  $("#order-detail-view").style.display = "block";
  $("#order-detail-title").textContent = `Objednávka #${order.id}`;

  const itemsHtml = items.map(it => `
    <tr>
      <td>${escapeHtml(it.name_snapshot)}</td>
      <td>${it.qty}</td>
      <td>${formatKc(it.unit_price_czk)}</td>
      <td>${it.vat_rate != null ? it.vat_rate + "%" : "—"}</td>
      <td>${formatKc(it.line_total_czk)}</td>
    </tr>`).join("");

  $("#order-detail-panel").innerHTML = `
    <div class="admin-form-grid">
      <div><strong>Zákazník</strong><br>${escapeHtml(order.customer_name)}<br>${escapeHtml(order.customer_email)}<br>${escapeHtml(order.customer_phone || "")}</div>
      <div><strong>Fakturační adresa</strong><br>${escapeHtml(order.billing_street)}<br>${escapeHtml(order.billing_city)} ${escapeHtml(order.billing_zip)}<br>${escapeHtml(order.billing_country)}</div>
      <div><strong>Doručovací adresa</strong><br>${escapeHtml(order.shipping_street)}<br>${escapeHtml(order.shipping_city)} ${escapeHtml(order.shipping_zip)}<br>${escapeHtml(order.shipping_country)}</div>
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
  manualOrderItems = [];
  $("#order-list-view").style.display = "none";
  $("#order-detail-view").style.display = "block";
  $("#order-detail-title").textContent = "Nová objednávka";

  const productOptions = allProductsForOrder.map(p =>
    `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");

  $("#order-detail-panel").innerHTML = `
    <form id="manual-order-form">
      <h2>Zákazník</h2>
      <div class="admin-form-grid">
        <label class="span-2">Jméno a příjmení<br><input type="text" id="mo-name" required></label>
        <label>E-mail<br><input type="email" id="mo-email" required></label>
        <label>Telefon<br><input type="tel" id="mo-phone"></label>
      </div>

      <h2 style="margin-top:20px;">Fakturační adresa</h2>
      <div class="admin-form-grid">
        <label class="span-2">Ulice a č.p.<br><input type="text" id="mo-bstreet" required></label>
        <label>Město<br><input type="text" id="mo-bcity" required></label>
        <label>PSČ<br><input type="text" id="mo-bzip" required></label>
        <label class="span-2">Země<br><input type="text" id="mo-bcountry" value="Česká republika" required></label>
      </div>

      <label style="display:block; margin-top:14px; font-weight:600;">
        <input type="checkbox" id="mo-same-address" checked> Doručovací adresa je stejná jako fakturační
      </label>
      <div id="mo-shipping-address" style="display:none;">
        <h2 style="margin-top:20px;">Doručovací adresa</h2>
        <div class="admin-form-grid">
          <label class="span-2">Ulice a č.p.<br><input type="text" id="mo-sstreet"></label>
          <label>Město<br><input type="text" id="mo-scity"></label>
          <label>PSČ<br><input type="text" id="mo-szip"></label>
          <label class="span-2">Země<br><input type="text" id="mo-scountry" value="Česká republika"></label>
        </div>
      </div>

      <h2 style="margin-top:20px;">Doprava a platba</h2>
      <div class="admin-form-grid">
        <label>Způsob dopravy<br>
          <select id="mo-shipping-method">
            <option value="gls">GLS</option>
            <option value="zasilkovna">Zásilkovna</option>
            <option value="ceska_posta">Česká pošta</option>
          </select>
        </label>
        <label>Způsob platby<br>
          <select id="mo-payment-method">
            <option value="card">Platební karta</option>
            <option value="bank_transfer">Bankovní převod</option>
            <option value="cod">Dobírka</option>
          </select>
        </label>
      </div>
      <label style="display:block; margin-top:10px;"><input type="checkbox" id="mo-paid"> Objednávka je již zaplacena</label>

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
      <textarea id="mo-notes" rows="3" style="width:100%; padding:9px; border:1px solid var(--border); border-radius:3px;"></textarea>

      <div id="mo-error" style="color:#c0392b; margin-top:14px;"></div>

      <div style="margin-top:20px; display:flex; gap:10px;">
        <button type="submit" id="mo-submit-btn" class="btn buy">Vytvořit objednávku</button>
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

  const sameAddress = $("#mo-same-address").checked;
  const totalCzk = manualOrderItems.reduce((sum, it) => sum + it.unitPriceCzk * it.qty, 0);
  const paid = $("#mo-paid").checked;

  btn.disabled = true;
  btn.textContent = "Vytvářím…";

  try {
    const { data: order, error: orderError } = await supabaseClient.from("orders").insert({
      status: "new",
      created_by: "admin",
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
      shipping_cost_czk: 0,
      payment_method: $("#mo-payment-method").value,
      paid,
      paid_at: paid ? new Date().toISOString() : null,
      total_czk: totalCzk,
      notes: $("#mo-notes").value.trim() || null,
    }).select().single();

    if (orderError) throw orderError;

    const itemRows = manualOrderItems.map(it => ({
      order_id: order.id,
      product_id: it.productId,
      name_snapshot: it.name,
      unit_price: it.unitPriceCzk,
      price_currency: "CZK",
      unit_price_czk: it.unitPriceCzk,
      vat_rate: it.vatRate,
      qty: it.qty,
      line_total_czk: it.unitPriceCzk * it.qty,
    }));
    const { error: itemsError } = await supabaseClient.from("order_items").insert(itemRows);
    if (itemsError) throw itemsError;

    for (const it of manualOrderItems) {
      const { data: current } = await supabaseClient.from("products").select("stock").eq("id", it.productId).single();
      if (current) {
        await supabaseClient.from("products").update({ stock: Math.max(0, current.stock - it.qty) }).eq("id", it.productId);
      }
    }

    triggerOrderEmails(order.id); // best-effort, don't block on it
    showOrderList();
  } catch (err) {
    errEl.textContent = "Vytvoření objednávky selhalo: " + err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Vytvořit objednávku";
  }
}
