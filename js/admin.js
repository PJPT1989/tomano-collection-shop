// Admin page logic: product list, add/edit/delete, image upload, VAT rates.
// Auth/login lives in admin-common.js, shared with admin-orders.js.

const CATEGORY_LABELS = { draft: "Draft", collector: "Collector", set: "Set", jumpstart: "Jumpstart" };
// Default parcel weight per category (g) - averages, see product-weight-migration.sql.
const CATEGORY_WEIGHTS = { draft: 1100, collector: 400, set: 900, jumpstart: 800 };
let editingId = null; // null = creating a new product
let editingVatId = null; // null = creating a new VAT rate
let vatRates = [];
let availabilityStatuses = []; // [{ code, label }] from availability_statuses
let lastProductRows = [];
let currentCategoryFilter = "all";
const CATEGORY_ORDER = ["draft", "collector", "set", "jumpstart"];

async function initAdminPage() {
  await loadVatRates();
  await loadAvailabilityStatuses();
  await loadProductTable();
}

// ---------- Product table ----------

async function loadProductTable() {
  const tbody = $("#admin-table-body");
  tbody.innerHTML = `<tr><td colspan="8">Načítání…</td></tr>`;

  const { data, error } = await supabaseClient
    .from("products")
    .select("*")
    .order("cat", { ascending: true })
    .order("position", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="8">Chyba při načítání: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  lastProductRows = data;
  renderProductTable();
}

function productRowHtml(p, isFirst, isLast) {
  const asHelper = { price: p.price, priceCurrency: p.price_currency };
  const czk = getCzkPrice(asHelper);
  const eur = getEurPrice(asHelper);
  const priceLabel = p.price_currency === "EUR"
    ? `${eur.toLocaleString("cs-CZ")} € <span style="color:#999;">(≈ ${czk.toLocaleString("cs-CZ")} Kč)</span>`
    : `${czk.toLocaleString("cs-CZ")} Kč <span style="color:#999;">(≈ ${eur.toLocaleString("cs-CZ")} €)</span>`;
  return `
    <tr>
      <td>
        <button class="reorder-btn" ${isFirst ? "disabled" : ""} onclick="moveProduct('${p.id}', -1)" title="Posunout výš">▲</button>
        <button class="reorder-btn" ${isLast ? "disabled" : ""} onclick="moveProduct('${p.id}', 1)" title="Posunout níž">▼</button>
      </td>
      <td><img src="${escapeHtml(p.img || '')}" alt="" class="admin-thumb"></td>
      <td>${escapeHtml(p.name)}${p.supplier_managed ? ` <span style="color:#1565c0;" title="Spravuje bot dodavatele: sklad, cenu a viditelnost přepisuje každé 2 minuty.">[dodavatel]</span>` : ""}${p.hidden ? ` <span style="color:#999;">[skryto]</span>` : ""}</td>
      <td>${CATEGORY_LABELS[p.cat] || escapeHtml(p.cat)}</td>
      <td>${priceLabel}</td>
      <td>${p.stock}${p.availability && p.availability !== "available" ? ` <span style="color:#d35400;">(${escapeHtml(availabilityLabel(p.availability))}${p.release_date ? ", " + escapeHtml(p.release_date) : ""})</span>` : ""}</td>
      <td>
        <button class="btn detail" onclick="openEditForm('${p.id}')">Upravit</button>
      </td>
      <td>
        <button class="remove" onclick="deleteProduct('${p.id}', ${escapeAttr(JSON.stringify(p.name))})">Smazat</button>
      </td>
    </tr>`;
}

function renderProductTable() {
  const tbody = $("#admin-table-body");
  const data = lastProductRows;

  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8">Zatím žádné produkty.</td></tr>`;
    return;
  }

  const cats = currentCategoryFilter === "all" ? CATEGORY_ORDER : [currentCategoryFilter];
  let html = "";

  cats.forEach(cat => {
    const rows = data
      .filter(p => p.cat === cat)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    if (rows.length === 0) return;
    html += `<tr class="admin-group-row"><td colspan="8">${CATEGORY_LABELS[cat] || cat} (${rows.length})</td></tr>`;
    html += rows.map((p, i) => productRowHtml(p, i === 0, i === rows.length - 1)).join("");
  });

  tbody.innerHTML = html || `<tr><td colspan="8">Žádné produkty v této kategorii.</td></tr>`;
}

document.querySelectorAll("#admin-cat-filter button").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#admin-cat-filter button").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentCategoryFilter = btn.dataset.cat;
    renderProductTable();
  });
});

async function moveProduct(id, direction) {
  const product = lastProductRows.find(p => p.id === id);
  if (!product) return;
  const sameCat = lastProductRows
    .filter(p => p.cat === product.cat)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const idx = sameCat.findIndex(p => p.id === id);
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= sameCat.length) return;

  const other = sameCat[swapIdx];
  const [r1, r2] = await Promise.all([
    supabaseClient.from("products").update({ position: other.position }).eq("id", product.id),
    supabaseClient.from("products").update({ position: product.position }).eq("id", other.id)
  ]);
  if (r1.error || r2.error) {
    alert("Změna pořadí selhala: " + (r1.error?.message || r2.error?.message));
    return;
  }
  loadProductTable();
}

async function deleteProduct(id, name) {
  if (!confirm(`Opravdu smazat produkt "${name}"? Tuto akci nelze vrátit zpět.`)) return;
  const { error } = await supabaseClient.from("products").delete().eq("id", id);
  if (error) {
    alert("Smazání selhalo: " + error.message);
    return;
  }
  loadProductTable();
}

// ---------- Add/edit form ----------

function emptyLinkRow(text = "", href = "") {
  const row = document.createElement("div");
  row.className = "link-edit-row";
  row.innerHTML = `
    <input type="text" placeholder="Text odkazu (např. TCG Player)" class="link-text" value="${escapeAttr(text)}">
    <input type="url" placeholder="https://..." class="link-href" value="${escapeAttr(href)}">
    <button type="button" class="remove-link-btn">✕</button>`;
  row.querySelector(".remove-link-btn").addEventListener("click", () => row.remove());
  return row;
}

$("#add-link-btn").addEventListener("click", () => {
  $("#links-editor").appendChild(emptyLinkRow());
});

// ---------- Link finder ----------
//
// Looks a product up on MTGStocks and fills in all three marketplace links
// at once. Goes through an Edge Function rather than calling MTGStocks
// directly: they send no CORS headers, so the browser cannot reach them.
//
// Deliberately a picker rather than an automatic match. This shop calls a
// product "Play Booster Box"; MTGStocks calls the same thing "Play Booster
// Display", and older sets say "Draft Booster Box". Any rule treating those
// as equivalent will eventually choose "Display Case" instead of "Display",
// and a wrong link is worse than no link because nobody notices it.

const LINK_LABELS = { tcgplayer: "TCG Player", cardmarket: "Cardmarket", mtgstocks: "Price History" };

function setLinkFinderStatus(message, isError) {
  const el = $("#link-search-status");
  el.textContent = message || "";
  el.style.color = isError ? "#c0392b" : "#888";
}

async function callMtgstocksLookup(payload) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/mtgstocks-lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SUPABASE_ANON_KEY}` },
    body: JSON.stringify(payload),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || res.statusText);
  return result;
}

$("#link-search-btn").addEventListener("click", async () => {
  const query = $("#link-search").value.trim();
  const results = $("#link-search-results");
  results.innerHTML = "";

  if (query.length < 2) {
    setLinkFinderStatus("Zadejte prosím alespoň dva znaky.", true);
    return;
  }

  setLinkFinderStatus("Hledám…");
  try {
    const { sets } = await callMtgstocksLookup({ search: query });
    if (!sets.length) {
      setLinkFinderStatus("Nic nenalezeno. Zkuste jiný název edice.", true);
      return;
    }

    setLinkFinderStatus("Vyberte správný produkt:");
    for (const set of sets) {
      const heading = document.createElement("div");
      heading.className = "link-finder-set";
      heading.textContent = `${set.setName} (${set.abbreviation})`;
      results.appendChild(heading);

      for (const product of set.products) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "btn detail link-finder-pick";
        btn.textContent = product.name;
        btn.addEventListener("click", () => applyMtgstocksProduct(product.id));
        results.appendChild(btn);
      }
    }
  } catch (err) {
    setLinkFinderStatus("Vyhledávání selhalo: " + err.message, true);
  }
});

async function applyMtgstocksProduct(mtgstocksId) {
  setLinkFinderStatus("Načítám odkazy…");
  try {
    const product = await callMtgstocksLookup({ id: mtgstocksId });

    // Replace only the links we manage, so anything else added by hand
    // survives being re-run.
    const managed = new Set(Object.values(LINK_LABELS));
    Array.from(document.querySelectorAll("#links-editor .link-edit-row")).forEach(row => {
      if (managed.has(row.querySelector(".link-text").value.trim())) row.remove();
    });

    for (const [key, label] of Object.entries(LINK_LABELS)) {
      const href = product.links[key];
      if (href) $("#links-editor").appendChild(emptyLinkRow(label, href));
    }

    $("#field-mtgstocks").value = product.id;
    $("#link-search-results").innerHTML = "";
    const price = product.marketPrice != null ? `, aktuální cena $${product.marketPrice}` : "";
    setLinkFinderStatus(`Doplněno: ${product.setName} — ${product.name}${price}`);
  } catch (err) {
    setLinkFinderStatus("Načtení odkazů selhalo: " + err.message, true);
  }
}

function collectLinks() {
  return Array.from(document.querySelectorAll("#links-editor .link-edit-row")).map(row => ({
    text: row.querySelector(".link-text").value.trim(),
    href: row.querySelector(".link-href").value.trim()
  })).filter(l => l.text && l.href);
}

function openAddForm() {
  editingId = null;
  $("#form-title").textContent = "Nový produkt";
  $("#product-form").reset();
  $("#field-id").disabled = false;
  $("#field-currency").value = "CZK";
  const defaultVat = vatRates.find(v => v.name === "21");
  $("#field-vat").value = defaultVat ? defaultVat.id : "";
  $("#field-position").value = 0;
  $("#field-weight").value = CATEGORY_WEIGHTS[$("#field-cat").value] || 1000;
  $("#field-availability").value = "available";
  $("#field-release").value = "";
  $("#links-editor").innerHTML = "";
  $("#link-search-results").innerHTML = "";
  setLinkFinderStatus("");
  $("#image-preview").style.display = "none";
  updatePricePreview();
  $("#form-panel").style.display = "block";
  $("#form-panel").scrollIntoView({ behavior: "smooth" });
}

function updatePricePreview() {
  const amount = parseFloat($("#field-price").value);
  const preview = $("#price-preview");
  if (isNaN(amount)) {
    preview.textContent = "";
    return;
  }
  const asHelper = { price: amount, priceCurrency: $("#field-currency").value };
  preview.textContent = $("#field-currency").value === "CZK"
    ? `≈ ${getEurPrice(asHelper).toLocaleString("cs-CZ")} € při dnešním kurzu ČNB`
    : `≈ ${getCzkPrice(asHelper).toLocaleString("cs-CZ")} Kč při dnešním kurzu ČNB`;
}

$("#field-price").addEventListener("input", updatePricePreview);

// A new product takes its category's default weight; an existing one keeps its own.
$("#field-cat").addEventListener("change", () => {
  if (!editingId) $("#field-weight").value = CATEGORY_WEIGHTS[$("#field-cat").value] || 1000;
});
$("#field-currency").addEventListener("change", updatePricePreview);

async function openEditForm(id) {
  const { data: p, error } = await supabaseClient.from("products").select("*").eq("id", id).single();
  if (error) {
    alert("Nepodařilo se načíst produkt: " + error.message);
    return;
  }
  editingId = id;
  $("#form-title").textContent = "Upravit produkt";
  $("#field-id").value = p.id;
  $("#field-id").disabled = true;
  $("#field-cat").value = p.cat;
  $("#field-name").value = p.name;
  $("#field-currency").value = p.price_currency || "CZK";
  $("#field-price").value = p.price;
  $("#field-stock").value = p.stock;
  $("#field-availability").value = p.availability || "available";
  $("#field-release").value = p.release_date || "";
  $("#field-vat").value = p.vat_rate_id || "";
  $("#field-position").value = p.position || 0;
  $("#field-ean").value = p.ean || "";
  $("#field-weight").value = p.weight_g ?? 1000;
  $("#field-mtgstocks").value = p.mtgstocks_id ?? "";
  $("#field-desc").value = p.description || "";
  $("#field-image").value = "";
  updatePricePreview();
  if (p.img) {
    $("#image-preview").src = p.img;
    $("#image-preview").style.display = "block";
  } else {
    $("#image-preview").style.display = "none";
  }
  $("#links-editor").innerHTML = "";
  (p.links || []).forEach(l => $("#links-editor").appendChild(emptyLinkRow(l.text, l.href)));

  $("#form-panel").style.display = "block";
  $("#form-panel").scrollIntoView({ behavior: "smooth" });
}

function closeForm() {
  $("#form-panel").style.display = "none";
  editingId = null;
}

$("#add-product-btn").addEventListener("click", openAddForm);
$("#cancel-form-btn").addEventListener("click", closeForm);

$("#product-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const saveBtn = $("#save-btn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Ukládám…";

  try {
    const id = $("#field-id").value.trim();
    if (!/^[a-z0-9-]+$/.test(id)) {
      throw new Error("ID smí obsahovat jen malá písmena, číslice a pomlčky (např. mh3-dr).");
    }

    let imgPath = editingId ? $("#image-preview").getAttribute("src") || "" : "";
    const file = $("#field-image").files[0];
    if (file) {
      const ext = file.name.split(".").pop();
      const path = `${id}-${Date.now()}.${ext}`;
      // No upsert: the path already carries a timestamp, so it is unique by
      // construction and there is never an existing object to replace.
      // Asking for upsert made this an INSERT ... ON CONFLICT DO UPDATE,
      // which storage's row level security rejected outright — and because
      // the image is uploaded before the product row is written, the
      // failure surfaced as "new row violates row-level security policy"
      // and read like a problem with the products table.
      const { error: uploadError } = await supabaseClient.storage
        .from("product-images")
        .upload(path, file);
      if (uploadError) throw uploadError;
      const { data: pub } = supabaseClient.storage.from("product-images").getPublicUrl(path);
      imgPath = pub.publicUrl;
    }

    const vatValue = $("#field-vat").value;
    const row = {
      id,
      cat: $("#field-cat").value,
      name: $("#field-name").value.trim(),
      price: parseFloat($("#field-price").value),
      price_currency: $("#field-currency").value,
      stock: parseInt($("#field-stock").value, 10),
      availability: $("#field-availability").value || "available",
      // Null rather than "" when absent - it's a date column.
      release_date: $("#field-release").value || null,
      vat_rate_id: vatValue ? parseInt(vatValue, 10) : null,
      position: parseInt($("#field-position").value, 10) || 0,
      // Stored null rather than "" when absent, so the feed can tell
      // "no EAN" from "an empty one" and omit the element entirely.
      ean: $("#field-ean").value.trim() || null,
      // Column is NOT NULL, so fall back rather than writing null when the
      // field is cleared.
      weight_g: parseInt($("#field-weight").value, 10) || 1000,
      // Null rather than 0 when absent — the price job selects on "not
      // null", and a zero would send it looking up a product that isn't there.
      mtgstocks_id: parseInt($("#field-mtgstocks").value, 10) || null,
      img: imgPath,
      description: $("#field-desc").value,
      links: collectLinks()
    };

    if (!row.name || isNaN(row.price) || isNaN(row.stock)) {
      throw new Error("Vyplňte prosím název, cenu a sklad.");
    }

    const { error: saveError } = await supabaseClient.from("products").upsert(row);
    if (saveError) throw saveError;

    closeForm();
    loadProductTable();
  } catch (err) {
    alert("Uložení selhalo: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Uložit";
  }
});

$("#field-image").addEventListener("change", () => {
  const file = $("#field-image").files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    $("#image-preview").src = reader.result;
    $("#image-preview").style.display = "block";
  };
  reader.readAsDataURL(file);
});

// ---------- Availability statuses ----------

async function loadAvailabilityStatuses() {
  const { data, error } = await supabaseClient
    .from("availability_statuses")
    .select("code, label")
    .order("position", { ascending: true });
  // Fall back to the two built-in statuses so the form still works if the
  // table can't be read.
  availabilityStatuses = !error && data && data.length
    ? data
    : [{ code: "available", label: "Skladem" }, { code: "presale", label: "Předprodej" }];
  $("#field-availability").innerHTML = availabilityStatuses
    .map(s => `<option value="${escapeAttr(s.code)}">${escapeHtml(s.label)}</option>`).join("");
}

function availabilityLabel(code) {
  return (availabilityStatuses.find(s => s.code === code) || { label: code }).label;
}

// ---------- VAT rates ----------

async function loadVatRates() {
  const tbody = $("#vat-table-body");
  tbody.innerHTML = `<tr><td colspan="4">Načítání…</td></tr>`;

  const { data, error } = await supabaseClient
    .from("vat_rates")
    .select("*")
    .order("rate", { ascending: true });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="4">Chyba při načítání: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  vatRates = data;

  const select = $("#field-vat");
  select.innerHTML = `<option value="">— nepřiřazeno —</option>` +
    data.map(v => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join("");

  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4">Zatím žádné sazby DPH.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(v => `
    <tr>
      <td>${escapeHtml(v.name)}</td>
      <td>${v.rate}%</td>
      <td><button class="btn detail" onclick="openEditVatForm(${v.id})">Upravit</button></td>
      <td><button class="remove" onclick="deleteVatRate(${v.id}, ${escapeAttr(JSON.stringify(v.name))})">Smazat</button></td>
    </tr>`).join("");
}

async function deleteVatRate(id, name) {
  if (!confirm(`Opravdu smazat sazbu "${name}"? Produkty s touto sazbou o ni přijdou.`)) return;
  const { error } = await supabaseClient.from("vat_rates").delete().eq("id", id);
  if (error) {
    alert("Smazání selhalo: " + error.message);
    return;
  }
  loadVatRates();
}

function openAddVatForm() {
  editingVatId = null;
  $("#vat-form-title").textContent = "Nová sazba DPH";
  $("#vat-form").reset();
  $("#vat-form-panel").style.display = "block";
  $("#vat-form-panel").scrollIntoView({ behavior: "smooth" });
}

function openEditVatForm(id) {
  const v = vatRates.find(x => x.id === id);
  if (!v) return;
  editingVatId = id;
  $("#vat-form-title").textContent = "Upravit sazbu DPH";
  $("#vat-field-name").value = v.name;
  $("#vat-field-rate").value = v.rate;
  $("#vat-form-panel").style.display = "block";
  $("#vat-form-panel").scrollIntoView({ behavior: "smooth" });
}

function closeVatForm() {
  $("#vat-form-panel").style.display = "none";
  editingVatId = null;
}

$("#add-vat-btn").addEventListener("click", openAddVatForm);
$("#vat-cancel-btn").addEventListener("click", closeVatForm);

$("#vat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const saveBtn = $("#vat-save-btn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Ukládám…";

  try {
    const row = {
      name: $("#vat-field-name").value.trim(),
      rate: parseFloat($("#vat-field-rate").value)
    };
    if (!row.name || isNaN(row.rate)) {
      throw new Error("Vyplňte prosím název a sazbu.");
    }
    if (editingVatId) row.id = editingVatId;

    const { error } = await supabaseClient.from("vat_rates").upsert(row);
    if (error) throw error;

    closeVatForm();
    await loadVatRates();
  } catch (err) {
    alert("Uložení selhalo: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Uložit";
  }
});
