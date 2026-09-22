// Where GoPay sends the customer back to after the gateway. The state shown
// here comes from asking GoPay, never from the URL — landing on this page is
// only evidence that a browser navigated, not that anything was paid.
//
// GoPay's own webhook is what actually records the payment, so this page is
// purely informational: if it can't determine a state, the order is still
// safely recorded and the webhook will settle it.

const PAYMENT_STATES = {
  PAID: {
    title: "Platba proběhla úspěšně",
    text: (order) => `Děkujeme! Objednávka č. ${order} je zaplacena. Potvrzení vám posíláme e-mailem.`,
    color: "var(--green)",
  },
  CANCELED: {
    title: "Platba byla zrušena",
    text: (order) => `Platba objednávky č. ${order} neproběhla. Objednávku máme uloženou — ozvěte se nám a domluvíme se na platbě.`,
    color: "#c0392b",
  },
  TIMEOUTED: {
    title: "Platba vypršela",
    text: (order) => `Čas na zaplacení objednávky č. ${order} vypršel. Objednávku máme uloženou — ozvěte se nám a domluvíme se na platbě.`,
    color: "#c0392b",
  },
};

const PENDING = {
  title: "Platba se zpracovává",
  text: (order) => `Objednávku č. ${order} máme přijatou. Jakmile platbu potvrdíme, dáme vám vědět e-mailem.`,
  color: null,
};

function render({ title, text, color }, orderNumber) {
  const titleEl = document.getElementById("payment-title");
  titleEl.textContent = title;
  if (color) titleEl.style.color = color;
  document.getElementById("payment-text").textContent = text(orderNumber);
}

async function showPaymentResult() {
  const params = new URLSearchParams(window.location.search);
  const orderNumber = params.get("order") || "—";
  const paymentId = params.get("id");

  if (!paymentId) {
    render(PENDING, orderNumber);
    return;
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/gopay-sync-payment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: paymentId }),
    });
    const result = await res.json();
    render(PAYMENT_STATES[result.state] || PENDING, orderNumber);
  } catch (e) {
    render(PENDING, orderNumber);
  }
}

document.addEventListener("DOMContentLoaded", showPaymentResult);
