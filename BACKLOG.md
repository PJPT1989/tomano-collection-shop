# Backlog

Things known to be outstanding, and why. Cutover from the current shop at
tomano.cz is planned for around late October 2026.

## Before cutover

**Move hosting off GitHub Pages.** The shop currently serves from
`pjpt1989.github.io/tomano-collection-shop`, but GitHub's terms forbid
using Pages to run an online business or e-commerce site, so it can't be
the permanent home. Cloudflare Pages is the intended replacement: free,
commercial use permitted, deploys from this same repo on push, and it
supports a redirects file. Point a subdomain at it first and run the whole
shop there before switching the apex — changing `tomano.cz` itself *is*
the cutover.

**Point `SHOP_BASE_URL` at the real domain.** It still says
`http://localhost:8533`. Until it changes, the Heureka feed advertises
product and image URLs that don't resolve, and the GoPay return page can't
work for a real customer.

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

**Delete the test orders and restore stock.** Orders `2026000101`,
`2026000102` and `2026000103` are test data holding stock. Afterwards:
Teenage Mutant Ninja Turtles Play Booster Box back to 2, Lorwyn Eclipsed
Collector back to 10. Deleting an order also removes its invoice and label
from storage.

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

Recorded so they don't get reopened by accident.

**Heureka `ITEM_ID`s are this project's own**, not the old shop's. Heureka
treats ITEM_ID as permanently identifying an offer, so preserving pairing
would have meant carrying the old shop's inconsistent ids (`ECL`, the
transposed `SMP_CL`) forever. There was no pairing history worth
protecting and EANs are present, so re-pairing is largely automatic.

**Staying on Supabase free rather than $25/month Pro.** The capacity
limits are nowhere near binding. Project pausing after seven days of
inactivity is already prevented by the two existing daily `pg_cron` jobs —
**if those are ever removed, the pausing risk comes back.** The real gap
is backups, hence the item above. Worth revisiting at roughly ten times
the current order volume.

**Parcel weights err high on purpose.** Zásilkovna charge one flat rate up
to 5 kg, so on any normal order an over-estimate costs nothing while an
under-estimate earns a reweigh and a correction invoice. Precision would
only start to pay near 5 kg, which is about five draft boxes.

**Invoice and order numbering starts at `2026000100`** to clear the
numbers the old shop had already issued this year, and falls back to 1
from 2027. The 2026 special case expires by itself — it is not an
arbitrary offset to be tidied away.
