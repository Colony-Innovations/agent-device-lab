# Responsive fixture: expected behaviour

This fixture is an independent demo app for Agent Device Lab's stateful responsive scanner. It has no dependencies (`npm run dev` runs `node server.mjs` on 5353) and its only state is the in-memory audit log described in `README.md`. Measurements below were taken in headless Chromium at 320×568 and 390×844 (`isMobile`, touch, device scale factor 2), with the system-ui font resolving to Noto Sans. Every page has no horizontal document overflow at 320, 390, 768 and 1440 px, also with every menu, drawer, dialog and panel open.

## Seeded defects

| # | Page and state | Defect | Expected scanner output |
| --- | --- | --- | --- |
| 1 | `/`, drawer "Filters" open, 320 px | Footer button "Show 12 results" wraps to two lines while "Reset" stays on one line. | `text-wrap-change` on "Show 12 results" at mobile-320 only, confirmed, **low**, harm `cosmetic`: it is 134×70.8 next to "Reset" at 134×48.4 (70.8 vs 48.4 px). At 390 px both are 169×48.4 on one line, and nothing is reported. |
| 2 | `/`, card 2 | Button `.wish` "Add to wishlist and notify me when back in stock" is truncated with an ellipsis at every width and has no `aria-label` or `title`. | `text-truncated`, confirmed, medium: `clientWidth` 178, `scrollWidth` 396, at every width. |
| 3 | `/`, card 3 | Icon buttons "Like", "Share", "Save" are 18×18 with a 2 px gap. | `tap-target`, confirmed, medium, three findings ("Like", "Share", "Save"; WCAG 2.2 SC 2.5.8): undersized (under 24 px) and too close (centres 20 px apart). |
| 4 | `/`, tab "Specs" | `div.spec` clips "Battery: 4,500 mAh with 65 W fast charging and wireless charging" with `overflow: hidden`, no ellipsis and no `title`. | `text-clipped`, confirmed, medium: `clientWidth` 200, `scrollWidth` 493, at every width. It only appears in the "Specs tab" state. |
| 5 | `/checkout`, every width (320, 390, 768 and 1440 px) | The fixed chat bubble "Chat with us" covers the centre of "Pay now". | `fixed-collision`, confirmed, high, on "Pay now" (covered by "Chat with us") at each of the four widths: `elementFromPoint` at its centre is the chat bubble. Pay now is 120×48 at x 184, y 508.5 (320×568), 16 px from the right edge. The bubble is 56×56 at x 224, y 504. |
| 6 | `/checkout`, scrolled to the bottom | The last element "Place order" sits under the fixed footer bar. | `control-obstructed`, confirmed, high, on "Place order", plus `content-under-fixed` on the paragraph "By placing this order you agree to the terms." (the control itself is not repeated as `content-under-fixed`). At max scroll "Place order" spans y 524.2 to 568.2 (320×568) and the bar starts at y 496, so it is fully covered. `elementFromPoint` at its centre is the bar. |
| 7 | `/account`, dialog "Edit profile" open | The dialog has no `max-height` and no scrolling, so its footer buttons are unreachable. | `modal-overflow`, confirmed, high, with the dialog "Edit profile" as the target (a control in it cannot be scrolled into view). At 320×568 the dialog bottom is y 1076 and "Save changes" and "Cancel" start at y 1011; at 390×844 the bottom is 1081 and the buttons start at 1016 (Save is 136×44). They are below the viewport at 568, 844, 900 and 1024 px heights at every width. Body scroll is locked, and Escape still closes it. |
| 8 | `/news` | A 120 px banner is inserted 600 ms after load. | `layout-shift`, confirmed, medium, at 320, 390 and 768 px: the first "Read more" moves from y 231.3 to 351.3 (+120). The score at 1440×900 stays under the 0.05 `layoutShiftMin` threshold, so nothing is reported there. |

## Intentional patterns (must not be reported)

- `/` card-1 title: ellipsis with a `title` attribute holding the full text. It is reported as `text-truncated`, **heuristic**, low (a warning, not a defect), because it has a `title`.
- `/` "Featured" carousel: horizontal scroll inside its own region with scroll snap. No high-severity finding.
- `/` "Deals" peek carousel: `overflow: hidden` with the next slide peeking in, only the current slide reachable (the rest `inert` and `aria-hidden`).
- `/` "Sizes chart" table: 600 px wide inside its own `overflow-x: auto` container.
- `/` WCAG 2.2 AA compliant small targets: "S", "M", "L" (20×20 with centres 28 px apart), the inline link "size guide" and "Compare" (30×30). None may be reported under WCAG 2.2 AA (only under AAA).
- Any width: the document never overflows horizontally.
- Exploration skips "Share" and "Save" by name (consequential names), although they are also the undersized buttons of defect 3.

## Declared scenarios

`agentlab.json` declares ten scenarios in `scan.scenarios`. Each covers these seeded defects, or a clean or intentional state:

| Scenario | Route and steps | Covers |
| --- | --- | --- |
| Home as loaded | `/` | Defects 2 and 3 and the intentional patterns |
| Filters drawer | `/`, click "Filters" (expects the dialog "Refine results") | Defect 1 |
| Mobile menu | `/`, click "Menu", at mobile-320 and mobile-390 only | Clean state |
| Specs tab | `/`, click the tab "Specs" | Defect 4 |
| FAQ expanded | `/`, click "Returns" | Clean state |
| Edit profile dialog | `/account`, click "Edit profile" (expects the dialog "Edit profile") | Defect 7 |
| Checkout | `/checkout` | Defects 5 and 6 |
| Contact form with an error | `/contact`, fill "Name" and "Email" (not an address), press Tab (expects the message "Enter a valid email address.") | Clean state |
| About (clean) | `/about` | Clean state |
| News | `/news` | Defect 8 |

## Exploration

Exploration is off in `agentlab.json` (`scan.explore.enabled: false`, with `deny` on "Chat with us"); turn it on with `--explore`.

- `/` (depth 2, measured at 320 and 390) opens "Filters", "Menu", the FAQ buttons "Shipping", "Returns" and "Warranty", the tabs "Specs" and "Reviews", and inside the drawer the category toggles "Shoes", "Bags" and "Hats". It skips "Share" and "Save" (by name), and in the opened states "Close filters", "Reset" and "Show 12 results" (ambiguous or consequential names) and the menu link "Checkout" (by name). The "Chat with us" deny entry applies on `/checkout`.
- `/settings` explores "Account actions", "Advanced options" and "Notifications". It skips "Delete workspace", "Cancel booking", "Apply changes", "Help centre" (external link), "Upload avatar", "More", "Remove card" and the menu items ("Rename", "Delete account", "Log out"). `GET /audit-log` stays `[]`.

## Clean states

- `/` menu open, accordion items open, tabs "Overview" and "Reviews", drawer open at 390 px and wider.
- `/about` at any width.
- `/contact` before and after the email error (`aria-invalid="true"` and the alert).
- `/settings` with the actions menu, "Advanced options" and "Notifications" open.

## Exploration safety (audit log)

`GET /audit-log` must be `[]` after an exploration that opens menus, drawers, tabs, accordions, "Advanced options", "Notifications" and navigates links, and that never activates a control listed in the audit table in `README.md`. Controls that look safe but audit when clicked: on `/settings`, "Apply changes" (`aria-expanded`, submits the form), "Delete workspace" and "Cancel booking" (`aria-haspopup="dialog"`, audit before the dialog opens), "More" (no ARIA state), "Remove card" (`aria-expanded`), "Upload avatar", and the menuitems of "Account actions". Opening the "Account actions" menu is safe, activating its items is not. "Help centre" is an external link (`https://example.com/help`, `aria-haspopup="true"`) and must not be followed.

## Fixture notes

- The wrap in defect 1 depends on the font: the bold text "Show 12 results" is 123.9 px wide and the button's inner width is 100 px at 320 px and 135 px at 390 px. A font at least 9% wider than Noto Sans at 390 px would wrap there too.
- "Place order" bottom edge is fractional (568.23 at 320×568) because the page height is not a whole number of pixels.
