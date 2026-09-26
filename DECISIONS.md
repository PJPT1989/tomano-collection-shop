# Design and infrastructure decisions

Why this shop is built the way it is. Each entry records a decision, the
reasoning behind it, and — where there is one — the trap it avoids. Several
of these look like mistakes or loose ends unless you know the reasoning;
those are the ones most worth reading before changing anything.

Outstanding work lives in [BACKLOG.md](BACKLOG.md). This file is for what
has been settled.

---

## Architecture at a glance

**A static site plus Supabase, with no server of our own.** The shop is
plain HTML, CSS and JavaScript served as files. Everything dynamic lives in
Supabase: a Postgres database, file storage, authentication for the admin
account, and Edge Functions for anything that needs a secret or has to run
server-side. There is nothing to patch, restart or keep alive.

**The browser only ever holds public keys.** The Supabase anon key and the
Packeta widget key ship to every visitor, by design — neither grants
anything on its own. Every real secret lives in Edge Function secrets and
is only ever used server-side. No secret has ever been committed to this
repo, and each push that touched integration code was checked for them.

**Deploys are manual.** SQL is pasted into the Supabase SQL Editor and Edge
Functions are pasted into the dashboard. There is no Supabase CLI setup in
the repo. Consequences of this, recorded as practices at the end of this
file, cost real time before they were understood.

**Edge Functions are single self-contained files.** Some helpers — GoPay's
token request, XML escaping — are duplicated rather than shared, because a
shared `_shared/` module can't be pasted into the dashboard editor. The
duplication is deliberate.

**Text shown to people is Czech; code and comments are English.**

---

## Hosting and domains

**Cloudflare Pages, deploying from `master` on every push.** Free,
commercial use permitted, unlimited bandwidth, real redirect support, and
native handling of apex domains. Build settings: no framework preset, no
build command, output directory `/` — the repository root *is* the site.

**Not GitHub Pages, despite it working.** The shop ran there for a while,
but GitHub's terms state Pages may not be used to run an online business or
e-commerce site, and that sites there shouldn't handle passwords. That
describes this shop exactly, and the failure mode is a takedown rather than
a warning. Pages has been disabled on the repository.

**Staging on `new.tomano.cz` before touching the apex.** A subdomain CNAME
points at the Pages project, so the whole shop — real domain, real
certificate, real payment round-trip — can be exercised without disturbing
the live shop at `tomano.cz`. Switching the apex itself *is* the cutover,
and it's better done as a rehearsed step than a first attempt.

**Cloudflare strips `.html`, and that is left alone.** A request for
`/payment-return.html` is redirected to `/payment-return`, query string
intact. The code still generates `.html` URLs because the extension-less
forms only work on Cloudflare — the local development server would 404 on
them. One harmless redirect hop was judged better than breaking local
testing.

**`SHOP_BASE_URL` is the one place the public address is configured.** It
is read by `gopay-create-payment` (the return URL after payment) and
`heureka-feed` (every product and image URL). It must not have a trailing
slash, because the payment function concatenates it directly.

---

## Supabase

**Staying on the free plan rather than Pro at $25/month.** None of the
capacity limits come close to binding: the whole catalogue is a few dozen
rows, invoices and labels are tens of kilobytes each, and product images
are served from the repo rather than Supabase storage. Worth revisiting at
roughly ten times the current order volume.

**Project pausing is prevented by the daily cron jobs.** Free projects are
suspended after seven days of inactivity. Two `pg_cron` jobs call Edge
Functions every day — `daily-price-fetch` at 06:00 UTC and
`daily-exchange-rate-fetch` at 15:00 UTC — which keeps the project active
as a side effect. **If both are ever removed, the pausing risk returns
silently.**

**The free plan has no backups, so backups are ours to build.** Planned: a
daily JSON export to a Google Drive folder (see the backlog). Recovery is
then schema from this repo plus data from that export. Invoice PDFs are
also kept as independent copies, since they are legally required records.

**The schema must be rebuildable from this repo.** For most of the
project's life it wasn't: `products` had been created in the dashboard and
existed only in the live database. `products-schema.sql` now records it —
reconstructed from the migration history and the live column list rather
than exported, with a query inside it to verify against the real table.

**Every table carries explicit grants.** From 2026-10-30 Supabase stops
granting Data API access to newly created tables. A rebuild from files
without `grant` statements would produce tables correct in every visible
way and unreachable through the API. Grants are scoped: `anon` can read
products, prices, exchange rates and VAT rates because the shop front needs
them; it cannot see orders, order items, shipments or invoices at all.
**Any future migration that creates a table needs its own grants.**

**Row level security on every table, and its policies live in the repo.**
Policies created only in the dashboard are invisible to anyone reading the
code, and gaps in them stay hidden until someone happens to exercise that
exact path. That is precisely how product creation came to fail: every
product had been loaded through `seed.sql`, which runs as the service role
and bypasses RLS, so a browser insert had genuinely never been attempted.

**Writes that customers trigger go through Edge Functions using the
service role**, never through browser-side table access. Checkout in
particular never trusts a price or a stock level supplied by the browser.

**Migrations are written to be safe to re-run.** The SQL Editor executes a
pasted script as a single transaction, so one statement tripping over
something already applied rolls back everything else — and reports only
the first error. `drop … if exists` before `create`, and `add column if
not exists`, avoid that.

**Two Edge Functions run with JWT verification off**: `gopay-sync-payment`
and `heureka-feed`. Both are called by third parties — GoPay's webhook and
Heureka's crawler — that send no Supabase auth header. Every other function
keeps verification on.

**Storage buckets:**

| Bucket | Access | Why |
|---|---|---|
| `product-images` | public | Product photos are meant to be seen |
| `invoices` | private | Customer names and addresses |
| `labels` | private | Customer name, address and phone |

Private buckets are served through short-lived signed URLs. Deleting an
order removes its invoice and label files first, because the database
cascade doesn't reach storage and they would otherwise be orphaned.

---

## Pricing, currency and VAT

**Prices are stored in the currency they were entered in.** Each product
has `price` and `price_currency` (CZK or EUR). The other currency is always
computed live, never stored. The old `eur` column is deprecated and kept
only as a historical reference.

**The EUR rate comes from the Czech National Bank daily.** Their public
fixing is fetched after publication at ~14:30 CET and stored per day. If it
is ever unavailable the shop falls back to a fixed emergency rate rather
than failing to show prices.

**VAT rates are a table rather than a constant**, so a product can carry a
different rate if it ever needs to. Everything currently uses 21%.

**Known limitation: no OSS destination-country VAT.** Invoices use each
product's assigned rate, which is correct for Czech customers. Cross-border
EU sales under the One-Stop-Shop scheme would need the buyer's country rate,
which is not implemented.

---

## Orders

**`order_number` is what people see; `id` is what the database uses.**
Customers, invoices, e-mails and the payment gateway all see `order_number`.
Every lookup and foreign key uses `id`. They were separated so the
customer-facing number could follow its own scheme without touching keys.

**Order and invoice numbers continue the old shop's series.** Both use
`YYYY######`. The shop being replaced had already issued 2026 orders into
the 60s and invoices into the 40s, and duplicating an invoice number within
an accounting year is a compliance problem, not just an untidy one. So the
2026 series starts at `2026000100`, and from 2027 both restart at 1.
**This is a one-year special case that expires on its own — it is not an
arbitrary offset to tidy away.**

**Numbers are assigned by the database, not the application.** A trigger
fills `order_number` on insert, so checkout and admin's manual orders both
get one without either knowing the rules. Allocation is read-then-write,
so two simultaneous orders could collide; the unique constraint turns that
into a failed insert rather than a duplicate. Acceptable at this volume.

**Stock is decremented when an order is created, and adjusted by the
difference when an order is edited.** Re-decrementing on edit would double
count. Checkout refuses to oversell.

**Editing an order regenerates its invoice with the same number and issue
date.** It's a correction of the same invoice, not a new one. The "sent to
customer" timestamp is cleared, so admin shows that the corrected invoice
needs sending again.

**Orders can be deleted from admin**, taking their items, shipments,
invoice and label with them.

**Admin can take orders by hand**, including for Zásilkovna without a
pickup point — processed manually in Zásilkovna's own system, as before.

---

## Payments — GoPay

**Built against the sandbox, with going live as a credential swap.** The
sandbox is a completely separate environment — its own merchant id,
credentials and API host — so development could never touch the live
shop's payment account. The API base URL is itself a secret, so moving to
production changes configuration and not code. The same merchant id is
reused after cutover since the old shop is being retired.

**Card, bank transfer, Apple Pay and Google Pay go through the gateway;
cash on delivery never does.**

**Creating a payment is separate from creating the order.** The order must
survive GoPay being unreachable, and an unpaid order has to remain payable
later without being recreated. The browser only ever supplies an order id;
every amount is read back from the stored order.

**Payment state is never taken from the redirect.** Arriving back at the
return page proves only that a browser navigated. One function,
`gopay-sync-payment`, re-reads the real state from GoPay and serves both
the webhook and the return page — so a customer closing the tab mid-payment
still gets their order marked paid.

**A later cancellation never un-pays an order.** Reversing money that
actually arrived is a refund, and that's a decision for a person rather
than a webhook.

---

## Shipping

**A shipment is created when an order moves to "Zpracovává se", not at
checkout.** A label for an order that is never paid, gets cancelled, or has
its address corrected is a parcel number that then needs voiding — and
voiding is a separate call to the carrier.

**Creating a second shipment for the same order is refused.** An existing
`shipments` row stops it, so flipping an order in and out of processing
can't create duplicate consignments.

**A pickup point's address is stored as the delivery address.** When a
customer chooses a ParcelShop or Zásilkovna point, its address goes into the
existing `shipping_*` fields. That's what the carriers require on the label
anyway, and it means invoices, e-mails and admin all show where the parcel
is really going without any of them needing to know pickup points exist.
Only the point's identity needs its own columns.

**Both carriers share one pickup-point model.** The pickers are genuinely
different — GLS is a map embedded in the page, Zásilkovna opens a modal
from their own library — but display, validation and the address
substitution are identical. Changing carrier discards the chosen point,
since a GLS shop isn't a valid Zásilkovna point.

**Carrier errors appear in the page, verbatim.** Not through `alert()`,
which browsers can suppress silently, and not paraphrased — the carriers'
own wording is almost always more useful. This is what diagnosed both a
missing GLS field and an unapproved Zásilkovna account in one attempt each.

**Parcel weight is summed from the products plus a packaging allowance,
and deliberately errs high.** Zásilkovna charge a single flat rate up to
5 kg, so on any normal order an over-estimate costs nothing while an
under-estimate brings a reweigh and a correction invoice. Weights are
per-category averages — 400 g collector, 1100 g draft, 900 g set, 800 g
jumpstart — plus
300 g of packaging per parcel, not per item.

### GLS

**Two shipping methods: to an address, and to a ParcelShop.** GLS offers
both, so they are separate choices at checkout.

**The ParcelShop map is embedded, and its messages are origin-checked.**
GLS's own example code accepts messages from any sender, which would let
any page inject a pickup point of its choosing.

**Trust live data over GLS's documentation.** The docs describe the COD
capability flag as `"t"`/`"f"`; the live map sends `"1"`. Reading it as
documented made every shop appear to refuse cash on delivery.

**Labels are created through MyGLS and stored for printing from admin.**
MyGLS has several quirks that every SDK and example in circulation gets
wrong or predates: the password is a SHA-512 digest sent as an array of 64
byte values, labels come back as a byte array rather than base64, dates use
.NET's `/Date(ms)/` format, and `WebshopEngine` has been required since
their 2023-11-13 revision.

**Street and house number are split from one address line.** GLS need them
separately; the order stores one line. The last token beginning with a
digit is taken as the number, which handles forms like `3058/2` and
`Náměstí 14. října 1`. If GLS ever rejects an address, look here first.

**Tested against GLS's test environment**, which forbids real personal
data — test orders use invented names and addresses.

### Zásilkovna (Packeta)

**One shipping method, now backed by the pickup-point widget.** Czech
customers read "Zásilkovna" as pickup-point delivery; home delivery isn't
offered.

**Restricted to Packeta's own Czech pickup points and Z-BOXes.** External
carriers' points identify themselves differently and would need handling
at packet creation; worth enabling deliberately rather than by accident.

**Show the point's `name`, not its `place`.** `place` sounds right but is
literally "Z-BOX" for a box; `name` carries the full description.

**Points Packeta marks with `error` are refused** — they are closed, full or
closing, and Packeta say customers must not select them.

**No database constraint requires a pickup point for Zásilkovna**, unlike
GLS ParcelShop. It's enforced at checkout, but leaving the database
permissive keeps manual phone orders possible.

**The sender indication is `tomano.cz`** — Packeta ask for the shop's
domain without the protocol.

---

## Heureka

**The product feed is generated on request by an Edge Function**, so it
can never drift from stock or prices and there's no build step to forget.

**Only in-stock products are listed.** Sending a Heureka customer to
something they then can't buy counts against the shop.

**Category, manufacturer and delivery time are constants**, since every
product is the same kind of thing. The category string is the one Heureka
already accepted from the previous shop.

**`ITEM_ID`s are this project's own, not the old shop's.** Heureka treats
`ITEM_ID` as permanently identifying an offer, so keeping pairing would
have meant carrying the old shop's inconsistent ids forever — `ECL` with no
suffix, `SMP_CL` with its letters transposed. There was no pairing history
worth protecting and EANs are present, so re-pairing is largely automatic.

**EANs were imported, not typed.** They came from the previous shop's feed,
normalised to 13 digits (that feed mixed 12-digit UPCs with 13-digit EANs).
`sos-cl` and `sos-dr` were deliberately left blank: the old feed gave both
the same EAN, which can't be right for two products, and guessing which one
owns it would guarantee a mispair. Missing EANs come off the physical boxes
— there's no service that maps names to barcodes for sealed Magic product.

**The feed is served as `text/plain`.** Supabase overrides the declared
type. Importers generally parse the body regardless; Heureka's validator is
the definitive check.

---

## Product data, prices and links

**Prices and marketplace links come from MTGStocks.** It replaced a paid
per-request API that returned an identical value for every product on every
day — 26 products, several days, not a cent of movement, which real market
prices never do. MTGStocks is free and genuinely live.

**It is an undocumented API with no terms granting use.** It could change
or start refusing requests. The daily price fetch is modest, and link lookup
happens only when a product is added. **If the price chart ever goes flat,
compare two days of `price_history` — that's the only way the failure
shows.**

**It can only be called server-side, with a realistic User-Agent.**
MTGStocks send no CORS headers, so the browser cannot reach them; and they
answer an automated-looking User-Agent with an HTML error page instead of
JSON, which would look like an outage.

**One stored id per product does both jobs.** `products.mtgstocks_id` keys
the daily price snapshot and drives link lookup. Every backfilled id was
verified — MTGStocks publishes the TCGplayer product id for each sealed
product, and all of them agreed with the link already on the product.

**Their affiliate and referrer parameters are stripped** from the TCGplayer
and Cardmarket URLs. This shop shouldn't send its referrals to someone
else's account.

**The link finder is a picker, not an automatic match.** This shop says
"Play Booster Box", MTGStocks says "Play Booster Display", older sets say
"Draft Booster Box", and every set also has a "Display Case". Any rule
treating those as equivalent will eventually attach the wrong product — and
a wrong link is worse than a missing one, because nobody checks their own.

**Product images are uploaded without `upsert`.** Filenames carry a
timestamp, so there is never an existing object to replace. Asking for
upsert made the upload an `INSERT … ON CONFLICT DO UPDATE`, which storage
security rejected — and because images upload before the product row is
written, the error surfaced as though the products table had refused it.

**`weight_g` is required with a default**, so a product added later always
has a usable weight rather than failing a shipment at the moment of
dispatch. `ean` and `mtgstocks_id` are optional and stored as null — not
empty strings or zeros — when absent.

---

## Availability and presale

**Products carry an availability status and a release date**
(`availability-migration.sql`). `available` ("Skladem") is the default and
what every older product is; `presale` ("Předprodej") is for goods ordered
from the distributor but not released yet. A presale is orderable up to its
stock and shows as "Předprodej · vychází 13. 11. 2026 · 6 Ks".

**Statuses are a table, not a check constraint**, because more are expected.
A new status is a row in `availability_statuses` plus display code if it
needs special wording.

**Presale is switched to available by hand**, when the goods actually arrive —
releases slip, so the release date alone doesn't prove anything is on the
shelf.

**`release_date` is for every product, not only presales.** The shop is meant
to be sorted by it later, so existing stock needs dates too (see backlog).

## Products created by the supplier bot

**When the supplier bot (`PJPT1989/cernyrytir-news-watcher`) orders booster
boxes from Černý Rytíř, it creates the matching product here** through the
`supplier-product` Edge Function. Only products that don't exist yet: if the
id or the MTGStocks product is already in the shop, nothing changes and the
admin is e-mailed.

**The function can only create, behind its own token.** The bot runs on a
server that browses third-party sites; the service role key would give it
every customer and order, and an admin login everything admin can do. The
function holds the service role itself, validates every field, fetches images
only from the distributor's image server, and is protected by
`SUPPLIER_PRODUCT_TOKEN`, which can be rotated on its own.

**What the bot sends:** id `<set code>-<cl|dr>` from MTGStocks' set
abbreviation; category `collector` for collector boxes and `draft` for
everything else; the distributor's price including VAT plus 10 %; the
distributor's 700 px product photo; the MTGStocks id and links; TCGplayer's
English description, translated to Czech by hand in admin afterwards. A case
ordered from the distributor becomes the box product: stock = 6 × cases,
price per box = case price / 6 (+10 %), status presale with the distributor's
release date. Single boxes go straight to `available`.

**Jumpstart boxes are their own category** ("Jumpstart boxes",
`jumpstart.html`, default weight 800 g), not part of draft. Admin fills in
the category's default weight when a new product is added.

**New products go on top of their category** (the others shift down by one).
Temporary - the plan is to sort by release date.

## E-mail and invoices

**E-mail goes through Resend**, from `objednavky@objednavky.tomano.cz`.
Order confirmations go to the customer and a copy to `admin@tomano.cz`.
Sending is best-effort: a failed e-mail never fails an order that already
succeeded.

**Invoices are PDFs generated in an Edge Function** and stored in the
private `invoices` bucket. Their font is fetched at generation time, which
is an external dependency worth knowing about if invoices ever fail to
render.

---

## Integration inventory

**Edge Function secrets** (names only — values are never in this repo):

| Secret | Used by |
|---|---|
| `SHOP_BASE_URL` | gopay-create-payment, heureka-feed |
| `GOPAY_API_BASE`, `GOPAY_CLIENT_ID`, `GOPAY_CLIENT_SECRET`, `GOPAY_GOID` | gopay-create-payment, gopay-sync-payment |
| `PACKETA_API_PASSWORD`, `PACKETA_SENDER_INDICATION` | packeta-create-packet |
| `MYGLS_API_BASE`, `MYGLS_USERNAME`, `MYGLS_PASSWORD`, `MYGLS_CLIENT_NUMBER` | gls-create-label |
| `RESEND_API_KEY` | send-order-emails, send-invoice-email |
| `SUPPLIER_PRODUCT_TOKEN` | supplier-product (shared with the supplier bot) |

`TCGAPI_KEY` was retired with the move to MTGStocks and nothing reads it —
if it still appears among the secrets, it can simply be deleted.

**Scheduled jobs:** `daily-price-fetch` at 06:00 UTC and
`daily-exchange-rate-fetch` at 15:00 UTC — which also keep the project from
pausing.

**Going live** changes configuration, not code: GoPay and MyGLS credentials
and API bases move from sandbox and test to production, and `SHOP_BASE_URL`
moves from `new.tomano.cz` to the apex.

---

## Working practices

Learned the hard way during this project.

**Verify a deploy by probing it, not by being told it's done.** A function
reported as redeployed once turned out not to be, and a fix was tested for
an hour while the deployed copy was still the old one. Where a change has
an observable effect — a new error message, a new field — call the live
endpoint and check for it.

**Trust live data over documentation.** GLS's documented flag format was
wrong, Packeta's field that sounds right isn't, and the most widely used
MyGLS SDK is missing a required field. First contact with the real service
is where these surface.

**Surface third-party errors verbatim.** Paraphrasing or discarding them —
Packeta's per-field `<detail>` was being thrown away at first — turns a
self-explanatory refusal into guesswork.

**Test in a normal browser.** The embedded browser used during development
suppresses `confirm()` and `alert()`, which makes anything behind them look
broken when it isn't.

**Test data is marked and cleaned up.** Test orders carry "TESTOVACÍ" in
their notes, use invented customers, and are deleted with their stock
restored afterwards.
