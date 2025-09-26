# Arc-Style Side Tabs Extension

This project implements a Chrome extension that recreates Arc browser’s side tab experience.
It surfaces the current window’s pinned tabs and unpinned tabs/groups in a responsive side panel
with Arc-inspired styling.

## High-Level Features
- **Arc-inspired UI:** Frosted glass backdrop, compact typography, gradient divider, and Arc-like
  folder icons to distinguish open vs. collapsed tab groups.
- **Pinned & tab list:** Pinned tabs appear as a grid at the top; the rest of the window’s tabs
  (including tab groups) render in a vertically scrolling list.
- **Live tab management:** The panel listens to Chrome tab & group events so it stays synced with
  the browser without manual refresh.
- **Interactions:**
  - Activate tabs by clicking a row.
  - Pin/unpin, move between groups, and create new groups from a custom inline menu.
  - Inline tab renaming by double-click.
  - Drag-and-drop to reorder tabs, move them between groups, and pin/unpin by dropping into the
    pinned grid.
- **Accessibility niceties:** Keyboard navigation for activation/context menu, focus outlines, and
  ellipsis behavior that prevents horizontal scroll.

## Implementation Notes
- **Manifest (Manifest V3):** `manifest.json` declares a side panel entry, service worker background,
  and required permissions (`tabs`, `tabGroups`, `sidePanel`).
- **Background worker:** `background.js` configures the action button to open the side panel by default.
- **Side panel UI:**
  - `sidepanel.html` defines the pinned section, gradient divider, tab list container, and templates
    for tab rows and tab-group sections.
  - `sidepanel.css` drives the Arc look: translucent slate palette, rounded geometry, compact spacing,
    pinned grid layout, pill-style row highlights, drag-target cues, and visible scrolling.
  - `sidepanel.js` orchestrates data fetching & rendering, tab/group event listeners, drag-and-drop,
    inline rename logic, and context-menu actions.
- **Assets:** The extension ships lightweight SVG assets for the folder icons (`assets/group-open.svg`,
  `assets/group-closed.svg`) plus generated PNG icons for the extension itself.

## Recent Enhancements
1. **UI polish:** Converted the layout to a single vertical scroll, ensured icons remain fixed size,
   tightened spacing, and improved active-state visuals.
2. **Drag-and-drop:** Added ability to reorder tabs, move them between groups, and pin/unpin via drag.
3. **Inline rename:** Double-click (or menu) opens an inline input, removing the previous prompt.
4. **Pinned divider:** Always-visible gradient divider clearly separates pinned tabs from the list.
5. **Arc-like group headers:** Removed text indicators in favor of Arc-style folder icons and cleaned up
   header styling.
6. **Context menus:** Added “Rename tab…” and refined labels to use actual group titles.
7. **Accessibility & trimming:** Ensured no horizontal scroll, added ellipsis, stabilized scrollbar,
   and made the experience resilient at minimum side-panel widths.

This document summarizes the agent-driven iteration on the project. For usage:
1. Load the folder as an unpacked extension in Chrome.
2. Open the side panel via the extension button.
3. Use pinned tabs, groups, and the context menu to interact with your current window’s tabs.
