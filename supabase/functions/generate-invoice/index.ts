// Supabase Edge Function: generate-invoice
//
// Given { orderId }, builds a PDF invoice (following the structure of the
// seller's existing invoice template: seller/buyer info, dates, order
// details, line items with per-item VAT, VAT recap by rate, footer),
// uploads it to the private "invoices" storage bucket, records it in the
// `invoices` table with a sequential invoice number, and returns a
// short-lived signed URL so the admin can view/download it immediately.
//
// KNOWN LIMITATION: uses each order item's already-assigned VAT rate
// (normally your 21% default). It does NOT implement destination-country
// VAT switching for cross-border EU sales (the OSS scheme) — the sample
// invoice this was modeled on used Croatia's 25% rate for a Croatian
// customer, which this function will not replicate. Correct for
// Czech-customer orders; not yet correct for cross-border ones.

import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, rgb } from "npm:pdf-lib@1.17.1";
// @ts-ignore - no types published for this build
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const FONT_URL = "https://raw.githubusercontent.com/prawnpdf/prawn/master/data/fonts/DejaVuSans.ttf";
const LOGO_BASE64 = "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";

const SELLER = {
  name: "Petr Tománek",
  street: "Novodvorská 177",
  cityZip: "143 00 Praha",
  country: "ČESKÁ REPUBLIKA",
  ico: "09422480",
  dic: "CZ8909125819",
  email: "tomanpe8@seznam.cz",
  phone: "602 336 075",
  accountNumber: "6706648359",
  bankCode: "800",
  iban: "CZ8408000000006706648359",
  swift: "GIBACZPX",
};

const SHIPPING_LABELS: Record<string, string> = { gls: "GLS", zasilkovna: "Zásilkovna", ceska_posta: "Česká pošta" };
const PAYMENT_LABELS: Record<string, string> = { card: "Platební karta", bank_transfer: "Bankovní převod", cod: "Dobírka" };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

function czDate(d: Date) {
  return d.toLocaleDateString("cs-CZ");
}

function kc(n: number) {
  return n.toLocaleString("cs-CZ") + " Kč";
}

async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = String(year);
  const { data } = await supabase
    .from("invoices")
    .select("invoice_number")
    .like("invoice_number", `${prefix}%`)
    .order("invoice_number", { ascending: false })
    .limit(1)
    .maybeSingle();

  // The shop this project replaces had already issued 2026 invoices into the
  // 40s, so our 2026 series starts above those rather than duplicating them.
  // 2027 onwards is ours alone and starts at 1, which is why this is a
  // one-year special case. Mirrors assign_order_number() in
  // order-number-migration.sql.
  let seq = prefix === "2026" ? 100 : 1;
  if (data?.invoice_number) {
    seq = parseInt(data.invoice_number.slice(prefix.length), 10) + 1;
  }
  return prefix + String(seq).padStart(6, "0");
}

async function getExchangeRate(): Promise<number> {
  const { data } = await supabase
    .from("exchange_rates")
    .select("czk_per_eur")
    .order("rate_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.czk_per_eur ?? 24.5;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

  try {
    const { orderId, regenerate } = await req.json();

    const { data: order, error: orderErr } = await supabase.from("orders").select("*").eq("id", orderId).single();
    if (orderErr || !order) return jsonResponse({ error: "Objednávka nenalezena." }, 404);

    const { data: existing } = await supabase.from("invoices").select("*").eq("order_id", orderId).maybeSingle();
    if (existing && !regenerate) return jsonResponse({ error: "Faktura pro tuto objednávku již existuje.", invoice: existing }, 409);

    const { data: items, error: itemsErr } = await supabase.from("order_items").select("*").eq("order_id", orderId);
    if (itemsErr) return jsonResponse({ error: itemsErr.message }, 500);

    const rate = await getExchangeRate();
    // Regenerating (the order was edited after the invoice was issued) keeps
    // the original invoice number and issue date — it's a correction of the
    // same invoice, not a new one — and only the PDF content and totals
    // reflect the edited order.
    const invoiceNumber = existing ? existing.invoice_number : await nextInvoiceNumber();
    const issuedAt = existing ? new Date(existing.issued_at) : new Date();
    const dueAt = new Date(issuedAt.getTime() + 14 * 24 * 60 * 60 * 1000);

    // ---------- Build the PDF ----------
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const fontBytes = await fetch(FONT_URL).then((r) => r.arrayBuffer());
    const font = await pdfDoc.embedFont(fontBytes);

    const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 40;
    let page = pdfDoc.addPage([PAGE_W, PAGE_H]);
    let y = PAGE_H - MARGIN;
    const black = rgb(0.1, 0.1, 0.1);
    const gray = rgb(0.45, 0.45, 0.45);

    function line(text: string, opts: { size?: number; x?: number; color?: typeof black; gap?: number } = {}) {
      const size = opts.size ?? 10;
      page.drawText(text, { x: opts.x ?? MARGIN, y, size, font, color: opts.color ?? black });
      y -= opts.gap ?? size + 4;
    }
    function rightAligned(text: string, size: number, atY: number) {
      const w = font.widthOfTextAtSize(text, size);
      page.drawText(text, { x: PAGE_W - MARGIN - w, y: atY, size, font, color: black });
    }
    // Draws a bordered box with an optional title and a list of text lines;
    // returns the y-coordinate of the box's bottom edge, so the caller can
    // stack the next box below it with a small gap.
    function drawBox(x: number, width: number, yTop: number, title: string | null, lines: string[]): number {
      const padding = 10;
      const lineHeight = 13;
      const titleGap = title ? 17 : 0;
      const boxHeight = titleGap + lines.length * lineHeight + padding * 2;
      const boxBottom = yTop - boxHeight;

      page.drawRectangle({ x, y: boxBottom, width, height: boxHeight, borderColor: gray, borderWidth: 0.75 });

      let cy = yTop - padding - 9;
      if (title) {
        page.drawText(title, { x: x + padding, y: cy, size: 10.5, font, color: black });
        cy -= titleGap;
      }
      for (const l of lines) {
        page.drawText(l, { x: x + padding, y: cy, size: 9, font, color: black });
        cy -= lineHeight;
      }
      return boxBottom;
    }

    // ---------- Logo (top-left) + invoice number (top-right), side by side ----------
    const logoBytes = Uint8Array.from(atob(LOGO_BASE64), (c) => c.charCodeAt(0));
    const logoImage = await pdfDoc.embedJpg(logoBytes);
    const logoWidth = 140;
    const logoHeight = logoWidth * (logoImage.height / logoImage.width);
    page.drawImage(logoImage, { x: MARGIN, y: y - logoHeight, width: logoWidth, height: logoHeight });

    // Vertically center the "Faktura č." text against the logo's height.
    rightAligned(`Faktura č. ${invoiceNumber}`, 14, y - logoHeight / 2 - 5);

    y -= logoHeight + 20;

    const LEFT_X = MARGIN, LEFT_W = 240;
    const RIGHT_X = MARGIN + 270, RIGHT_W = PAGE_W - MARGIN - (MARGIN + 270);
    const topY = y;
    const boxGap = 14;

    // ---------- Left column ----------
    let leftY = drawBox(LEFT_X, LEFT_W, topY, "Dodavatel", [
      SELLER.name, SELLER.street, SELLER.cityZip, SELLER.country,
      `IČ: ${SELLER.ico}, DIČ: ${SELLER.dic}`,
      `E-mail: ${SELLER.email}`, `Tel.: ${SELLER.phone}`,
    ]) - boxGap;

    leftY = drawBox(LEFT_X, LEFT_W, leftY, "Platební údaje", [
      `Číslo účtu: ${SELLER.accountNumber}`, `Kód banky: ${SELLER.bankCode}`,
      `IBAN: ${SELLER.iban}`, `SWIFT: ${SELLER.swift}`,
      `Variabilní symbol: ${invoiceNumber}`,
    ]) - boxGap;

    const hasDifferentShipping =
      order.shipping_street !== order.billing_street ||
      order.shipping_city !== order.billing_city ||
      order.shipping_zip !== order.billing_zip;

    if (hasDifferentShipping) {
      leftY = drawBox(LEFT_X, LEFT_W, leftY, "Dodací adresa", [
        order.customer_name, order.shipping_street,
        `${order.shipping_city} ${order.shipping_zip}`, order.shipping_country,
      ]) - boxGap;
    }

    // ---------- Right column ----------
    let rightY = drawBox(RIGHT_X, RIGHT_W, topY, null, [
      `Datum vystavení: ${czDate(issuedAt)}`,
      `Datum splatnosti: ${czDate(dueAt)}`,
      `Datum usk. zdan. plnění: ${czDate(issuedAt)}`,
      `Číslo objednávky: ${order.order_number}`,
    ]) - boxGap;

    const buyerLines = [
      order.customer_name, order.billing_street,
      `${order.billing_city} ${order.billing_zip}`, order.billing_country,
      `E-mail: ${order.customer_email}`,
    ];
    if (order.customer_phone) buyerLines.push(`Tel.: ${order.customer_phone}`);
    rightY = drawBox(RIGHT_X, RIGHT_W, rightY, "Odběratel", buyerLines) - boxGap;

    rightY = drawBox(RIGHT_X, RIGHT_W, rightY, "Obchodní údaje", [
      `Datum objednávky: ${czDate(new Date(order.created_at))}`,
      `Způsob dopravy: ${SHIPPING_LABELS[order.shipping_method] || order.shipping_method}`,
      `Způsob úhrady: ${PAYMENT_LABELS[order.payment_method] || order.payment_method}`,
    ]) - boxGap;

    y = Math.min(leftY, rightY) - 10;

    // Numeric columns are right-aligned so amounts of any width end at a
    // fixed edge instead of overflowing past it (the earlier bug).
    const RIGHT_EDGE = PAGE_W - MARGIN;
    function numAt(text: string, rightX: number, atY: number, size = 9, color = black) {
      const w = font.widthOfTextAtSize(text, size);
      page.drawText(text, { x: rightX - w, y: atY, size, font, color });
    }

    // ---------- Line items table ----------
    const col = { name: MARGIN, qtyR: 300, vatR: 345, unitR: 420, netR: 490, totalR: RIGHT_EDGE };
    page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT_EDGE, y }, thickness: 1, color: gray });
    y -= 14;
    page.drawText("Název", { x: col.name, y, size: 9, font, color: gray });
    numAt("Množ.", col.qtyR, y, 9, gray);
    numAt("DPH", col.vatR, y, 9, gray);
    numAt("Cena/ks", col.unitR, y, 9, gray);
    numAt("Bez DPH", col.netR, y, 9, gray);
    numAt("S DPH", col.totalR, y, 9, gray);
    y -= 6;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT_EDGE, y }, thickness: 1, color: gray });
    y -= 16;

    const vatGroups: Record<string, { base: number; vat: number; total: number }> = {};

    for (const it of items || []) {
      if (y < 120) { page = pdfDoc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; }

      const vatRate = it.vat_rate ?? 0;
      const totalInclVat = it.line_total_czk;
      const totalExclVat = Math.round((totalInclVat / (1 + vatRate / 100)) * 100) / 100;
      const vatAmount = Math.round((totalInclVat - totalExclVat) * 100) / 100;

      const key = String(vatRate);
      if (!vatGroups[key]) vatGroups[key] = { base: 0, vat: 0, total: 0 };
      vatGroups[key].base += totalExclVat;
      vatGroups[key].vat += vatAmount;
      vatGroups[key].total += totalInclVat;

      const name = it.name_snapshot.length > 34 ? it.name_snapshot.slice(0, 34) + "…" : it.name_snapshot;
      page.drawText(name, { x: col.name, y, size: 9, font, color: black });
      numAt(`${it.qty} ks`, col.qtyR, y);
      numAt(`${vatRate}%`, col.vatR, y);
      numAt(kc(it.unit_price_czk), col.unitR, y);
      numAt(kc(totalExclVat), col.netR, y);
      numAt(kc(totalInclVat), col.totalR, y);
      y -= 18;
    }

    y -= 6;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT_EDGE, y }, thickness: 1.5, color: black });
    y -= 24;

    rightAligned(`K úhradě s DPH: ${kc(order.total_czk)}`, 14, y);
    y -= 20;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: RIGHT_EDGE, y }, thickness: 1.5, color: black });
    y -= 30;

    // ---------- VAT recap, boxed ----------
    // Wider, dedicated spacing from the line-items columns — "Celkem s DPH"
    // is a much wider label than "S DPH", so reusing those tighter columns
    // caused it to overlap the "DPH" column before it (an earlier bug).
    //
    // Box height is computed up front from the known number of lines (same
    // approach as drawBox() above), so there's guaranteed padding around
    // the title and the last row instead of the box edge landing exactly
    // on the title text (the overlap that was just reported).
    const recapRows = Object.entries(vatGroups);
    const padIn = 10;
    const recapLineH = 15;
    const recapBoxHeight = 17 /* title row */ + (1 + recapRows.length) * recapLineH + padIn * 2;
    const recapCol = { baseR: 380, vatR: 465, totalR: RIGHT_EDGE - padIn };
    const recapTop = y;
    const recapBottom = recapTop - recapBoxHeight;

    let ry = recapTop - padIn - 9;
    page.drawText("Daňová rekapitulace", { x: MARGIN + padIn, y: ry, size: 11, font, color: black });
    ry -= 17;
    page.drawText("Sazba DPH", { x: MARGIN + padIn, y: ry, size: 9, font, color: gray });
    numAt("Základ", recapCol.baseR, ry, 9, gray);
    numAt("DPH", recapCol.vatR, ry, 9, gray);
    numAt("Celkem s DPH", recapCol.totalR, ry, 9, gray);
    ry -= recapLineH;
    for (const [rateKey, sums] of recapRows) {
      page.drawText(`${rateKey}%`, { x: MARGIN + padIn, y: ry, size: 9, font, color: black });
      numAt(kc(Math.round(sums.base)), recapCol.baseR, ry);
      numAt(kc(Math.round(sums.vat)), recapCol.vatR, ry);
      numAt(kc(Math.round(sums.total)), recapCol.totalR, ry);
      ry -= recapLineH;
    }

    page.drawRectangle({
      x: MARGIN, y: recapBottom, width: PAGE_W - 2 * MARGIN, height: recapTop - recapBottom,
      borderColor: gray, borderWidth: 0.75,
    });
    y = recapBottom - 20;

    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.75, color: gray });
    y -= 20;
    line(`Vystavil: ${SELLER.name}`, { size: 9, color: gray });
    line(`Přepočet kurzem ČNB: 1 EUR = ${rate} Kč`, { size: 8, color: gray });

    const pdfBytes = await pdfDoc.save();
    // Wrapped in a Blob rather than uploaded as a raw Uint8Array — storage-js's
    // handling of raw byte arrays is inconsistent across runtimes and was
    // producing a corrupted file (matches "the link generates but the PDF
    // won't open," which ruled out the earlier popup-blocker theory).
    const pdfBlob = new Blob([pdfBytes], { type: "application/pdf" });

    // ---------- Store + record ----------
    const path = existing ? existing.pdf_url : `${invoiceNumber}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from("invoices")
      .upload(path, pdfBlob, { contentType: "application/pdf", upsert: !!existing });
    if (uploadError) return jsonResponse({ error: "Nahrání PDF selhalo: " + uploadError.message }, 500);

    let invoiceRow, invoiceError;
    if (existing) {
      // The content just changed, so a previously-sent copy is now stale —
      // clear sent_to_customer_at so the admin UI shows it needs resending.
      ({ data: invoiceRow, error: invoiceError } = await supabase
        .from("invoices")
        .update({ pdf_url: path, sent_to_customer_at: null })
        .eq("id", existing.id)
        .select()
        .single());
    } else {
      ({ data: invoiceRow, error: invoiceError } = await supabase
        .from("invoices")
        .insert({ order_id: orderId, invoice_number: invoiceNumber, pdf_url: path })
        .select()
        .single());
    }
    if (invoiceError) return jsonResponse({ error: "Uložení faktury selhalo: " + invoiceError.message }, 500);

    const { data: signed } = await supabase.storage.from("invoices").createSignedUrl(path, 3600);

    return jsonResponse({ invoice: invoiceRow, downloadUrl: signed?.signedUrl });
  } catch (err) {
    return jsonResponse({ error: "Neočekávaná chyba: " + (err as Error).message }, 500);
  }
});
