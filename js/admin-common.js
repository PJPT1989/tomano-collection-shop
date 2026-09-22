// Shared across every admin page: login/logout flow and small helpers.
// Each page defines its own `initAdminPage()` (e.g. in admin.js or
// admin-orders.js), called once the admin is confirmed logged in.

function $(sel) { return document.querySelector(sel); }

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : s;
  return div.innerHTML;
}

// For safely embedding a JSON.stringify(...) result (which itself contains
// double quotes) inside a double-quoted HTML attribute like onclick="...".
// Without this, the JSON string's own quotes prematurely close the
// attribute and corrupt the markup — the exact bug that made several
// buttons silently do nothing.
function escapeAttr(s) {
  return String(s).replace(/"/g, "&quot;");
}

async function checkSession() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session) {
    await showAdmin(session.user.email);
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
  const nav = $("#admin-nav");
  if (nav) nav.style.display = "block";
  $("#logged-in-as").textContent = email;
  await fetchExchangeRate();
  if (typeof initAdminPage === "function") await initAdminPage();
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

document.addEventListener("DOMContentLoaded", checkSession);
