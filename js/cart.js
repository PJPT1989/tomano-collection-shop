// Simple localStorage-backed cart, shared across pages.
const CART_KEY = "tomano_cart";

function getCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || {};
  } catch (e) {
    return {};
  }
}

function saveCart(cart) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch (e) {}
  updateCartCount();
}

function addToCart(id, qty) {
  qty = qty || 1;
  const cart = getCart();
  cart[id] = (cart[id] || 0) + qty;
  saveCart(cart);
}

function setQty(id, qty) {
  const cart = getCart();
  qty = parseInt(qty, 10);
  if (!qty || qty < 1) {
    delete cart[id];
  } else {
    cart[id] = qty;
  }
  saveCart(cart);
}

function removeFromCart(id) {
  const cart = getCart();
  delete cart[id];
  saveCart(cart);
}

function cartCount() {
  const cart = getCart();
  return Object.values(cart).reduce((a, b) => a + b, 0);
}

function updateCartCount() {
  const el = document.getElementById("cart-count");
  if (!el) return;
  const n = cartCount();
  el.textContent = n;
  el.style.display = n > 0 ? "inline-flex" : "none";
}

function formatKc(n) {
  return n.toLocaleString("cs-CZ") + " Kč";
}

document.addEventListener("DOMContentLoaded", updateCartCount);
