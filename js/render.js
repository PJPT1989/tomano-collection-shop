// Renders product grids, sort controls, product detail and cart pages.

function productCard(p) {
  const stockClass = p.stock > 0 ? "ok" : "out";
  const stockLabel = p.stock > 0 ? `Skladem ${p.stock} Ks` : "Skladem 0";
  const action = p.stock > 0
    ? `<button class="btn buy" onclick="addToCart('${p.id}',1); this.textContent='Přidáno ✓'; setTimeout(()=>this.textContent='DO KOŠÍKU',1200);">DO KOŠÍKU</button>`
    : `<a class="btn detail" href="product.html?id=${p.id}">DETAIL</a>`;
  return `
    <div class="card">
      <a href="product.html?id=${p.id}"><img src="images/products/${p.img}" alt="${p.name}"></a>
      <a class="name" href="product.html?id=${p.id}">${p.name}</a>
      <div class="price">${formatKc(p.price)} <span class="eur">(${p.eur} Euro s DPH)</span></div>
      <div class="stock ${stockClass}">${stockLabel}</div>
      ${action}
    </div>`;
}

function renderGrid(category) {
  const grid = document.getElementById("grid");
  if (!grid) return;
  let items = PRODUCTS.filter(p => p.cat === category);
  const countEl = document.getElementById("item-count");
  if (countEl) countEl.textContent = items.length;

  function paint(list) {
    grid.innerHTML = list.map(productCard).join("");
  }
  paint(items);

  document.querySelectorAll(".sortbar button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sortbar button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const mode = btn.dataset.sort;
      let sorted = items.slice();
      if (mode === "cheap") sorted.sort((a, b) => a.price - b.price);
      else if (mode === "expensive") sorted.sort((a, b) => b.price - a.price);
      else if (mode === "az") sorted.sort((a, b) => a.name.localeCompare(b.name));
      paint(sorted);
    });
  });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function renderDescription(desc) {
  if (!desc || !desc.trim()) return "";
  const paragraphs = desc.trim().split(/\n\s*\n/);
  return paragraphs.map(block => {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.every(l => l.startsWith("•"))) {
      return "<ul>" + lines.map(l => `<li>${escapeHtml(l.replace(/^•\s*/, ""))}</li>`).join("") + "</ul>";
    }
    return `<p>${lines.map(escapeHtml).join("<br>")}</p>`;
  }).join("");
}

function renderLinks(links) {
  if (!links || links.length === 0) return "";
  return `
    <div class="external-links">
      <h3>Odkazy</h3>
      <div class="link-row">
        ${links.map(l => `<a class="ext-link" href="${l.href}" target="_blank" rel="noopener noreferrer">${escapeHtml(l.text)}</a>`).join("")}
      </div>
    </div>`;
}

function renderProduct() {
  const container = document.getElementById("product-detail");
  if (!container) return;
  const params = new URLSearchParams(location.search);
  const id = params.get("id");
  const p = PRODUCTS.find(x => x.id === id);
  if (!p) {
    container.innerHTML = "<p>Produkt nenalezen.</p>";
    return;
  }
  document.title = p.name + " - Tomano Collection";
  const stockClass = p.stock > 0 ? "ok" : "out";
  const stockLabel = p.stock > 0 ? `Skladem ${p.stock} Ks` : "Skladem 0";
  container.innerHTML = `
    <img src="images/products/${p.img}" alt="${p.name}">
    <div>
      <h1>${p.name}</h1>
      <div class="price-big">${formatKc(p.price)}</div>
      <div class="price-eur">${p.eur} Euro s DPH</div>
      <div class="stock ${stockClass}">${stockLabel}</div>
      <div class="qty-row">
        <input type="number" id="qty" value="1" min="1" ${p.stock > 0 ? "" : "disabled"}>
        <button class="btn buy" id="add-btn" ${p.stock > 0 ? "" : "disabled"} onclick="addToCart('${p.id}', parseInt(document.getElementById('qty').value,10)||1); this.textContent='Přidáno do košíku ✓'; setTimeout(()=>this.textContent='DO KOŠÍKU',1500);">DO KOŠÍKU</button>
      </div>
      ${renderLinks(p.links)}
    </div>
    <div class="description-block">
      <h2>Popis</h2>
      ${renderDescription(p.desc) || "<p>Popis produktu zatím není k dispozici.</p>"}
    </div>`;
}

function renderCart() {
  const body = document.getElementById("cart-body");
  if (!body) return;
  const cart = getCart();
  const ids = Object.keys(cart);
  const emptyEl = document.getElementById("empty-cart");
  const tableEl = document.getElementById("cart-table");
  const totalEl = document.getElementById("cart-total");

  if (ids.length === 0) {
    if (emptyEl) emptyEl.style.display = "block";
    if (tableEl) tableEl.style.display = "none";
    if (totalEl) totalEl.style.display = "none";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";
  if (tableEl) tableEl.style.display = "table";
  if (totalEl) totalEl.style.display = "block";

  let total = 0;
  body.innerHTML = ids.map(id => {
    const p = PRODUCTS.find(x => x.id === id);
    if (!p) return "";
    const qty = cart[id];
    const sub = p.price * qty;
    total += sub;
    return `
      <tr>
        <td><img src="images/products/${p.img}" alt="${p.name}"></td>
        <td><a href="product.html?id=${p.id}">${p.name}</a></td>
        <td>${formatKc(p.price)}</td>
        <td><input type="number" min="1" value="${qty}" onchange="setQty('${p.id}', this.value); renderCart();"></td>
        <td>${formatKc(sub)}</td>
        <td><button class="remove" onclick="removeFromCart('${p.id}'); renderCart();">Odebrat</button></td>
      </tr>`;
  }).join("");

  if (totalEl) totalEl.textContent = "Celkem: " + formatKc(total);
}

document.addEventListener("DOMContentLoaded", () => {
  renderProduct();
  renderCart();
});
