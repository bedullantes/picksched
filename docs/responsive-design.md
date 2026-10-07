# Responsive design

The web app has one stylesheet (`web/src/styles.css`) and uses the same colors and typography at every size.

## Breakpoints

| Range | Name | What changes |
|---|---|---|
| `< 768px` | Mobile | The header collapses into a menu button. Calendar columns stack as cards of slot chips. Filters stack. The analytics table becomes one card per day |
| `768–1024px` | Tablet | The navigation is inline. Dashboard tiles go two per row with charts one per row, and the analytics table scrolls sideways if needed. The calendar week view uses narrower columns (`.slot-grid--dense`) so all 7 days fit |
| `> 1024px` | Desktop | The full grid layouts |

Media queries use `max-width: 767.98px` (mobile) and `max-width: 1024px` (tablet and below).

## Rules

- **Touch targets of at least 44×44px** (`--touch`) for every button, input, select, menu link, radio label, modal close button and standalone link. The only exception is a link inside a sentence, such as "Try again" in a banner, which WCAG 2.5.8 allows to stay text-sized; add `.link-button--standalone` when a link-button stands on its own.
- **No horizontal page scroll.** Long text wraps (`overflow-wrap`), media is capped at 100% width, and grid columns use `min-width: 0` so they can't spill into their neighbors. Wide content (the calendar grid on desktop, the analytics table on tablet) scrolls inside its own container.
- **Form text is 16px**, because smaller sizes make iOS Safari zoom in on focus. Headings and the big dashboard figures scale with `clamp()`.
- **Modals** are centered at every size and never taller than the viewport (`100dvh`, minus safe-area padding). The body scrolls while the title and actions stay visible.
- **Mobile menu** (`AppHeader`): the button has `aria-expanded` and `aria-controls`, and the current page is marked with `aria-current`. The menu closes on navigation, on Escape (returning focus to the button) and on a tap outside.
- **Tables shown as cards** keep explicit ARIA table roles, so screen readers still announce rows and columns.

## Checking it

The browser audit used for this work loaded every page and modal, for both players and owners, at 320, 390, 768, 1024 and 1280px. At each size it checked for page overflow, touch targets under 44px, form text under 16px, modals inside the viewport and centered, and overlapping calendar columns. Re-run that kind of check after layout changes: the unit tests (`npm test -w web`) cover menu behavior, but not CSS layout.
