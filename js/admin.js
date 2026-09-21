// Admin page logic: login, product list, add/edit/delete, image upload.

const CATEGORY_LABELS = { draft: "Draft", collector: "Collector", set: "Set" };
let editingId = null; // null = creating a new product

function $(sel) { return document.querySelector(sel); }

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : s;
  return div.innerHTML;
}

// ---------- Auth ----------

async function checkSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    showAdmin(session.user.email);
  } else {
    showLogin();
  }
}

function showLogin() {
  $("#login-view").style.display = "block";
  $("#admin-view").style.display = "none";
  $("#topbar-admin-status").style.display = "none";
}

async function showAdmin(email) {
  $("#login-view").style.display = "none";
  $("#admin-view").style.display = "block";
  $("#topbar-admin-status").style.display = "block";
  $("#logged-in-as").textContent = email;
  await loadProductTable();
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  const errEl = $("#login-error");
  errEl.textContent = "";

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    errEl.textContent = "Přihlášení selhalo: " + error.message;
    return;
  }
  showAdmin(data.user.email);
});

$("#logout-btn").addEventListener("click", async (e) => {
  e.preventDefault();
  await supabaseClient.auth.signOut();
  showLogin();
});

// ---------- Product table ----------

async function loadProductTable() {
  const tbody = $("#admin-table-body");
  tbody.innerHTML = `<tr><td colspan="7">Načítání…</td></tr>`;

  const { data, error } = await supabaseClient
    .from("products")
    .select("*")
    .order("cat", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    tbody.innerHTML = `<tr><td colspan="7">Chyba při načítání: ${escapeHtml(error.message)}</td></tr>`;
    return;
  }

  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7">Zatím žádné produkty.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(p => `
    <tr>
      <td><img src="${escapeHtml(p.img || '')}" alt="" class="admin-thumb"></td>
      <td>${escapeHtml(p.name)}</td>
      <td>${CATEGORY_LABELS[p.cat] || escapeHtml(p.cat)}</td>
      <td>${p.price.toLocaleString("cs-CZ")} Kč</td>
      <td>${p.stock}</td>
      <td>
        <button class="btn detail" onclick="openEditForm('${p.id}')">Upravit</button>
      </td>
      <td>
        <button class="remove" onclick="deleteProduct('${p.id}', ${JSON.stringify(p.name)})">Smazat</button>
      </td>
    </tr>`).join("");
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

function collectLinks() {
  return Array.from(document.querySelectorAll("#links-editor .link-edit-row")).map(row => ({
    text: row.querySelector(".link-text").value.trim(),
    href: row.querySelector(".link-href").value.trim()
  })).filter(l => l.text && l.href);
}

function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

function openAddForm() {
  editingId = null;
  $("#form-title").textContent = "Nový produkt";
  $("#product-form").reset();
  $("#field-id").disabled = false;
  $("#links-editor").innerHTML = "";
  $("#image-preview").style.display = "none";
  $("#form-panel").style.display = "block";
  $("#form-panel").scrollIntoView({ behavior: "smooth" });
}

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
  $("#field-price").value = p.price;
  $("#field-eur").value = p.eur;
  $("#field-stock").value = p.stock;
  $("#field-desc").value = p.description || "";
  $("#field-image").value = "";
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
      const { error: uploadError } = await supabaseClient.storage
        .from("product-images")
        .upload(path, file, { upsert: true });
      if (uploadError) throw uploadError;
      const { data: pub } = supabaseClient.storage.from("product-images").getPublicUrl(path);
      imgPath = pub.publicUrl;
    }

    const row = {
      id,
      cat: $("#field-cat").value,
      name: $("#field-name").value.trim(),
      price: parseInt($("#field-price").value, 10),
      eur: parseInt($("#field-eur").value, 10),
      stock: parseInt($("#field-stock").value, 10),
      img: imgPath,
      description: $("#field-desc").value,
      links: collectLinks()
    };

    if (!row.name || isNaN(row.price) || isNaN(row.eur) || isNaN(row.stock)) {
      throw new Error("Vyplňte prosím název, cenu (Kč), cenu (EUR) a sklad.");
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

document.addEventListener("DOMContentLoaded", checkSession);
