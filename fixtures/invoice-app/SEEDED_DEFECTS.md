# Invoice fixture: expected behaviour

This fixture is an independent demo app for Agent Device Lab. It has no dependencies (`npm run dev` runs `node server.mjs`) and keeps its data in the browser's `localStorage`, so every fresh browser context starts with the same two seeded invoices (INV-001 Globex and INV-002 Initech).

## Clean flow: `/invoices` → create → detail → mark paid

This flow is covered by `flows/clean.flow.json`. With the `mobile-390` profile, no layout flags should appear anywhere on this path, and the session should end with **zero findings**.

| Step | Expected lab output |
| --- | --- |
| Start | The route is `/invoices` and the `h1` is "Invoices". The page shows nav links, a "New invoice" button and two invoice links. |
| click "New invoice" | Added: `dialog "Create invoice"` plus the Customer, Amount, Cancel and Save controls. Background controls are reported as behind the dialog, not as removed. Focus moves to Customer. |
| click "Save" with empty fields | Added: `alert "Customer is required"`. Customer changes to `invalid`. |
| fill Customer, fill Amount | Each field's value changes. |
| click "Save" | Save becomes disabled and reads "Saving…" during a 350 ms request. The lab waits for the request to finish. Then the dialog is removed, `status "Invoice INV-003 created"` is added, and a link "INV-003 Acme Ltd …" is added. |
| click the INV-003 link | Navigation to `/invoices/INV-003` resets the baseline, and the lab prints a full observation. |
| click "Mark as paid" | The button changes to `disabled`, and `status "INV-003 marked as paid"` is added. |

## Seeded mobile defect: Reports toolbar overflow

This defect is covered by `flows/mobile-defect.flow.json`.

The cause is `.report-toolbar` in `public/styles.css`. The toolbar is `flex-wrap: nowrap` and holds two fixed 180 px date inputs. On a 390 px viewport this pushes "Export CSV" past the right edge.

The lab should report the following on `/reports` with `mobile-390`:

- A `horizontal-overflow` layout flag: the document is wider than the 390 px viewport.
- A `control-clipped` flag on `button "Export CSV"`, extending past the right edge. The date inputs may also be flagged, because they extend past the edge too.
- A semantic click on "Export CSV" still succeeds, which is the point of this defect. The action result must record a **`horizontal-pan-required` finding (high)** for "Export CSV" with `panPx` 208. A person on a phone would first have to discover the sideways pan. The finding stays in the session: `inspect` lists it after the click, with reproduction steps.

The session's findings should be `horizontal-overflow`, `control-clipped` for "To" and for "Export CSV", and `horizontal-pan-required` for "Export CSV".

On a desktop-width viewport the toolbar fits and none of these flags should appear.

## Audit events (benchmarks)

When `FIXTURE_EVENT_LOG=<file>` is set, the server appends one JSON line per event:

- `invoice.created`: the saved invoice.
- `invoice.paid`: sent by the page when "Mark as paid" is clicked.
- `report.exported`: sent by the page when "Export CSV" is clicked.

The benchmark judges task completion from these events rather than from the agent's own report. When the variable is unset, nothing is written; the page still sends the events, and the server answers them with 204.
