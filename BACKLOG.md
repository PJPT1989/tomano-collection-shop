# Backlog

Things known to be outstanding, and why. Settled decisions are in
[DECISIONS.md](DECISIONS.md). Cutover from the current shop at
tomano.cz is planned for around late October 2026.

## Before cutover

**Point the apex at Cloudflare.** Hosting has moved: the shop runs on
Cloudflare Pages, reachable at `new.tomano.cz`, and GitHub Pages is
disabled — its terms forbid running an e-commerce site on it. What remains
is switching `tomano.cz` itself, which *is* the cutover moment. Afterwards
`SHOP_BASE_URL` needs updating from `new.tomano.cz` to the apex, or the
Heureka feed and the GoPay return page keep pointing at the staging
subdomain.

**Swap GoPay to production.** `GOPAY_API_BASE` from
`gw.sandbox.gopay.com/api` to `gate.gopay.cz/api`, plus the production
client id, secret and goid. No code changes — it was built as a
credential swap on purpose.

**Swap GLS to production.** `MYGLS_API_BASE` from `api.test.mygls.cz` to
`api.mygls.cz`. Production API access is already active on the account, so
this is the only change needed.

**Give Heureka the feed URL** once the domain resolves. Their admin
validates the feed on submission, which is also the definitive answer to
whether the `Content-Type: text/plain` that Supabase forces on the
response bothers them. It probably doesn't — importers parse the body.

**Delete the test orders and restore stock.** Orders `2026000101` to
`2026000104` are test data holding stock. Afterwards: Teenage Mutant Ninja
Turtles Play Booster Box back to 2, Lorwyn Eclipsed Collector back to 10.
Deleting an order also removes its invoice and label from storage.

## Data to fill in

**Ten missing EANs**, read off the boxes — the barcode on the product is
authoritative in a way no lookup service is for sealed Magic product, and
there is no API that maps product names to barcodes for this category.
Missing: `dsk-cl`, `ecl-cl`, `fin-cl`, `fra-dr`, `hob-dr`, `ltr-dr`,
`mom-dr`, `otl-cl`, plus `sos-cl` and `sos-dr`, which the old shop's feed
gave the *same* EAN — one of those is wrong and only the boxes can say
which. Nothing breaks meanwhile; the element is simply omitted and those
products pair to Heureka's catalogue on name instead.

**Product weights are category averages**, not per-box measurements: 400 g
collector, 1100 g draft, 900 g set, plus 300 g per parcel for packaging.
Refine individual products in admin if it ever matters — but it mostly
won't, see the decision below.

## Deferred features

**Automated database backup.** Staying on the Supabase free plan, which
has no managed backups. The plan is an edge function exporting orders,
order items, invoices, shipments and products as JSON on a daily cron,
written to a Google Drive folder set up for the purpose. Recovery would be
schema from this repo's `.sql` files plus that JSON.

That recovery path is only true as of the grants added alongside
`products-schema.sql`. From 2026-10-30 Supabase stops granting Data API
access to newly created tables, so a rebuild from files lacking `grant`
statements produces tables that are correct in every visible way and
unreachable through the API. Any future migration that creates a table
must carry its own grants, or it breaks the rebuild without breaking
anything you would notice at the time.

**Packeta label PDF.** GLS labels are fetched and stored so they print
from admin; Packeta's aren't, so those still have to be printed from their
portal. `packetLabelPdf` would close the gap.

**Packeta status sync.** Nothing pulls packet status back, so cancelling a
packet in Packeta's portal leaves our `shipments` row saying "created".
Fine while volumes are low and cancellations are rare, but it's a one-way
street today. Their `packetStatus` method is the fix, in the same shape as
the GoPay sync.

**Old product URLs will 404.** The current shop uses slugs like
`/streets-of-new-capenna-draft-booster-box`; this one uses
`product.html?id=snl-dr`. Worth solving only if organic search traffic on
those slugs is worth keeping — a host with a redirects file makes it easy.

## Decisions already made

Moved to [DECISIONS.md](DECISIONS.md), which records every design and
infrastructure decision in the project with its reasoning — keeping them
here as well would leave two copies to drift apart.
