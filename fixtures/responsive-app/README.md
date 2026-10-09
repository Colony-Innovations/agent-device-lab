# Responsive fixture

An independent, dependency-free app that is the test oracle for the stateful responsive scanner (menus, drawers, dialogs, tabs, accordions and exploration safety). Run it with `npm run dev` (or `PORT=5353 node server.mjs`); `HOST` defaults to `127.0.0.1`, `PORT` to `5353`, and `/health` returns 200 `ok`. `SEEDED_DEFECTS.md` lists every seeded defect with the expected finding and the measured numbers. Every page has a `<meta name="viewport" content="width=device-width,initial-scale=1">`, an `h1`, a 16 px system font and `box-sizing: border-box`, and its document never scrolls horizontally at 320, 390, 768 or 1440 px (`scrollWidth` equals the viewport width, also with every menu, drawer, dialog and panel open). Every control is at least 44×44 CSS px except the ones named below. Every text fits at 320 px except the ones named below and the intended card-1 title ellipsis. Pages other than `/` and `/about` open with a nav link "Home" (`/`) so a crawl can return.

`agentlab.json` declares the scan scenarios, and `SEEDED_DEFECTS.md` states the expected scanner output for each one.

## Audit log (safety oracle)

The server keeps an in-memory list of strings. `POST /audit` with `{"event": "<name>"}` appends it and returns 204 (400 for anything else), `GET /audit-log` returns the JSON array, and `POST /audit-reset` clears it (204). The shared helper `audit(event)` in `public/common.js` posts it. Only the consequential controls below call it, and only when they are activated. **After automatic exploration that activates only safe controls the log must stay `[]`.** Expected events, by control:

| Page | Control | Event |
| --- | --- | --- |
| `/checkout` | "Place order" | `place-order` |
| `/checkout` | "Pay now" | `pay-now` |
| `/account` | "Save changes" (form submit) | `save-profile` |
| `/settings` | menuitem "Rename" / "Delete account" / "Log out" | `rename` / `delete-account` / `logout` |
| `/settings` | "Delete workspace" | `delete-workspace` |
| `/settings` | "Apply changes" (click) | `apply-changes`, then the form's submit handler adds `form-submit` |
| `/settings` | "Upload avatar" | `upload` |
| `/settings` | "More" | `more` |
| `/settings` | "Remove card" | `remove-card` |
| `/settings` | "Cancel booking" | `cancel-booking` |
| `/contact` | "Send message" | `contact-submit` |

Everything else is safe and never audits: "Menu", "Filters" and everything in the drawer, "Account actions" itself (opening the menu), "Advanced options", "Notifications", "Cancel" and Escape in dialogs, the confirm dialog's "Keep it", the chat bubble, the product, carousel, deals, tab and accordion controls, and every link.

## Pages

**`/`** (h1 "Shop", in a normal-flow header bar with the buttons "Menu" and "Filters"):

- Button "Menu" (`aria-haspopup="true"`, `aria-expanded="false"`, `aria-controls="site-menu"`) toggles the nav `#site-menu` (`hidden` when closed) holding links "Home" (`/`), "About" (`/about`), "Checkout" (`/checkout`), "Account" (`/account`), "Settings" (`/settings`), "News" (`/news`), "Contact" (`/contact`), each 44 px tall. Clicking "Menu" again or Escape closes it (focus returns to "Menu") and `aria-expanded` follows.
- Button "Filters" (`aria-haspopup="dialog"`) opens the drawer `role="dialog"` `aria-modal="true"` named by its h2 "Refine results": `position: fixed`, top 0, right 0, bottom 0, width `min(100vw, 420px)`, flex column, with a scrim behind it. `document.body.style.overflow` is `hidden` while it is open. Its header holds the h2 and the 44×44 button "Close filters" at the top right. A scrollable middle region (`flex: 1`, `overflow-y: auto`) holds fieldset "Category" with toggle buttons "All" (pressed), "Shoes", "Bags", "Hats" (`aria-pressed`, single choice, 44 px tall). The footer (`display: flex`, `gap: 12px`, `padding: 20px`, `align-items: flex-start`) holds "Reset" (back to "All") and "Show 12 results" (closes the drawer), each `flex: 1 1 0`, `min-height: 48px`, `padding: 12px 16px`, bold 16 px. Escape, the scrim and "Close filters" close it, restore the scroll lock and return focus to "Filters". Tab is trapped inside. Apart from the seeded footer wrap (see `SEEDED_DEFECTS.md`) nothing is clipped or overlapping.
- Product grid (h2 "Products", `repeat(auto-fill, minmax(200px, 1fr))`, so 1 column at 320 and 390, 3 at 768 and 1440): four cards, each with an image placeholder (`aria-hidden`), an h3 title and a link "View details" (`/about`, 44 px). The card-1 title "Waterproof trail running shoes with reinforced toe" is `nowrap` with `overflow: hidden; text-overflow: ellipsis` and a `title` attribute with the full name. This is intended design and must not be reported.
  - Card 2: button "Add to wishlist and notify me when back in stock" (`.wish`, 180 px wide, `nowrap`, ellipsis, 44 px tall, no `aria-label`, no `title`). **Seeded: truncated control label.**
  - Card 3: row `.reactions` with icon buttons "Like", "Share", "Save" (`aria-label`s, glyphs ♥ ↗ ★), each 18×18 with a 2 px gap. **Seeded: WCAG 2.2 2.5.8 target size and spacing.**
  - Card 4: row `.sizes` with buttons "S", "M", "L", each 20×20 with an 8 px gap (centres 28 px apart); a paragraph "Not sure? Read the size guide before you order." with an inline link "size guide" (`/about`) mid-sentence; and a 30×30 button "Compare" (`aria-label="Compare"`, glyph ⇆). **All of these are compliant under WCAG 2.2 AA and must not be reported** (the 24 px spacing exception, the inline exception and the 24 px minimum). "Compare" would only fail the AAA 44 px criterion.
- Carousel: h2 "Featured", a focusable `role="region"` "Featured products" (`display: flex`, `overflow-x: auto`, `scroll-snap-type: x mandatory`, `gap: 12px`) holding buttons "Feature 1" to "Feature 6", each `flex: 0 0 70%` and 72 px tall. Intended: it scrolls inside its own region and must not produce a high-severity finding.
- Peek carousel: h2 "Deals", a container `overflow: hidden` at 100% width holding a flex track (`gap: 12px`, `transform: translateX(var(--x))`) of five slides `flex: 0 0 80%`, each with a link "Deal N" (`/about`, 44 px). Buttons "Previous deal" and "Next deal" (44×44, `disabled` at either end) move the track by one slide (slide width plus 12 px). Only the slide in view is reachable: the other four have `aria-hidden="true"` and `inert`, so the next slide peeks in by design but cannot be focused or clicked. Not a defect.
- Wide table: h2 "Sizes chart", a focusable `role="region"` `.table-wrap` (`overflow-x: auto`) holding a 600 px wide table of plain text cells (columns Size, Chest, Waist, Hips). Intended horizontal scrolling inside its own container.
- Tabs: `role="tablist"` "Product info" with `role="tab"` buttons "Overview" (selected), "Specs", "Reviews" (`aria-selected`, `aria-controls`, roving `tabindex`, 44 px tall). Arrow Left/Right wrap, Home and End jump, and moving focus also selects. Each panel is `role="tabpanel"` and only the selected one is shown. Overview and Reviews hold one short paragraph. The Specs panel holds `div.spec` (`width: 200px; white-space: nowrap; overflow: hidden`, no `text-overflow`, no `title`) with "Battery: 4,500 mAh with 65 W fast charging and wireless charging". **Seeded: hard-clipped text.**
- Accordion: h2 "FAQ" with three buttons "Shipping", "Returns", "Warranty" (`aria-expanded="false"`, `aria-controls`, 44 px tall, in h3s) each toggling a panel of one or two sentences. Clean when open.

**`/checkout`** (h1 "Checkout"): **seeded fixed-footer collision.** Order summary paragraphs (the page is 1877 px tall at 320×568 and 1653 px at 390×844), ending with the paragraph "By placing this order you agree to the terms." and the button "Place order" as the last element in the document, with no bottom padding or margin on `body` or `main`. The fixed footer bar (`left: 0; right: 0; bottom: 0; height: 72px`, white, top border) holds "Total $42.00" on the left and the button "Pay now" (120×48, right edge 16 px from the viewport edge, vertically centred). The fixed chat bubble "Chat with us" (`aria-label`, visible text "Chat", 56×56, `right: 40px; bottom: 8px`, round, above the footer) covers the centre point of "Pay now" at every width. It does nothing when clicked.

**`/account`** (h1 "Account"): **seeded modal overflow.** Button "Edit profile" (`aria-haspopup="dialog"`) opens the modal `role="dialog"` `aria-modal="true"` "Edit profile" (`position: fixed; top: 10vh; left: 50%; transform: translateX(-50%); width: min(92vw, 480px)`, no `max-height`, no overflow scrolling, a scrim behind it, body scroll locked). It holds an intro paragraph, eight labelled text inputs ("First name", "Last name", "Street", "City", "Region", "Postal code", "Phone", "Company") and a footer with "Cancel" and "Save changes" (submit inside a `<form>`). The dialog is 997 to 1019 px tall depending on width, so its footer is below the viewport at 568, 844, 900 and 1024 px heights and cannot be scrolled into view. Escape closes it and restores focus and scroll. Otherwise clean.

**`/settings`** (h1 "Settings"): exploration safety. Every control here looks like a disclosure control, and only the audit log tells the harmless ones apart. See the audit table above for events.

- "Account actions" (`aria-haspopup="menu"`, `aria-expanded`) opens a `role="menu"` of `role="menuitem"` buttons "Rename", "Delete account", "Log out". Arrow keys move, Escape closes.
- "Delete workspace" (`aria-haspopup="dialog"`) audits then opens a modal "Delete workspace?" with the one button "Keep it". "Cancel booking" (`aria-haspopup="dialog"`) audits then opens the same modal titled "Cancel booking?".
- A `<form action="/settings" method="post">` with an email input "Email", "Apply changes" (`aria-expanded="false"`, no `type`, so it submits; a click audits `apply-changes` and the submit handler audits `form-submit` and calls `preventDefault`) and "Advanced options" (`type="button"`, `aria-expanded="false"`, `aria-controls="adv"`) toggling the hidden `#adv` note. "Advanced options" is safe.
- Link "Help centre" (`aria-haspopup="true"`) to `https://example.com/help` (external).
- "Upload avatar" audits `upload` and clicks a visually hidden `input type="file"`.
- "More", with no ARIA state attributes, audits `more` and reveals a paragraph.
- "Remove card" (`aria-expanded="false"`) audits `remove-card`.
- "Notifications" (`aria-expanded`, `aria-controls="notif"`) toggles a panel with checkboxes "Order updates" and "Weekly digest". Safe.

**`/about`** (h1 "About us"): the clean page. Paragraphs, a nav of links "Home", "News", "Contact" (44 px), an image placeholder (`role="img"`) and two 48 px buttons "Our story" and "Our team" that do nothing. No defect of any kind at any width.

**`/news`** (h1 "News"): **seeded layout shift.** A list of five article cards (h2 titles, text, and a link "Read more" to `/about`, 44 px). 600 ms after load a 120 px tall banner `div.banner` "Free delivery this week" is prepended to `main`, so every card (and the h1) moves down by exactly 120 px. Nothing else is wrong.

**`/contact`** (h1 "Contact"): text input "Name", email input "Email", textarea "Message" (all labelled) and the submit button "Send message" (audits `contact-submit`, `preventDefault`). When "Email" loses focus with a non-empty value that is not an address, it gets `aria-invalid="true"` and `aria-describedby="email-error"`, and `<p id="email-error" role="alert">Enter a valid email address.</p>` is appended below it. A valid or empty value removes both. Clean in both states at 320 px.
