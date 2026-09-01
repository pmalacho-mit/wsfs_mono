# Changelog

## dockview 4.11 → 8.1

The wrapper now depends on `dockview@^8.1.0` alone: `dockview-core` is gone from
`package.json`, and so is the React dependency the prop types used to borrow.

### Breaking

Most of this is dockview's, not ours.

- `theme="replit"` no longer exists — `themeReplit` was removed in v6. `Theme` is a
  public union, so this stops compiling rather than silently falling back.
- `api.onDidActivePanelChange` emits `{ panel, origin }` instead of the panel.
- Renames: `api.onUnhandledDragOverEvent` → `onUnhandledDragOver`; `PaneviewDropEvent` →
  `PaneviewDidDropEvent`; `DockviewGroupPanelFloatingChangeEvent` →
  `DockviewGroupPanelLocationChangeEvent`; `AddComponentOptions` →
  `AddGridviewComponentOptions`; `Contraints` → `Constraints`.
- `api.moveToNext` / `moveToPrevious` → `activateNext` / `activatePrevious`. The old
  names are kept as deprecated aliases.
- Panels are told the size of their **content area**, not the group box:
  `onDidDimensionsChange` no longer includes the tab header along the header's axis.
  Only matters to panels that size themselves from those numbers (canvas, virtualised
  lists).
- `rootOverlayModel` is gone; use `dropOverlayModel` / `dndEdges`.
- Custom tab components now also receive `tabLocation` (`"header" | "headerOverflow"`),
  and header action components receive `headerPosition` and `location`.

### Added

- Eleven themes: `nord(+Spaced)`, `catppuccinMocha(+Spaced)`, `monokai`,
  `solarizedLight(+Spaced)`, `githubDark(+Spaced)`, `githubLight(+Spaced)`.
- The `theme` prop takes a `DockviewTheme` object as well as a name. Settings like
  `tabAnimation` stopped being top-level options in v6 and are reachable only this way.
- `tabGroupChip` and `groupDragGhost` props, taking a component or a snippet like
  `watermark` does.
- `tabContextMenu`, a component or snippet rendered at the pointer on right-click and
  given `{ panel, group, api, close }`. Configuring one makes `DefaultDockTab` the
  default tab, since dockview's own built-in tab cannot be instrumented.
- `panel(...).group(...)` places a panel into a group — an edge group from
  `api.addEdgeGroup(position, options)`, or any group, by value, api or id.
- `createLayoutHistory(api)`, an opt-in undo stack. It does not shadow `api.undo` /
  `redo` / `canUndo` / `onDidChangeHistory`, which exist on the free typings and are
  inert without the enterprise LayoutHistory module.
- Everything `PROPERTY_KEYS_DOCKVIEW` grew (17 keys → 42) is settable as a prop,
  including `messages`, `announcer`, `dndStrategy`, `dropPositionResolver`,
  `reuseExistingPanels`, `scrollbars` and `nonce`.
- Free from upstream: WAI-ARIA roles and states, screen-reader live regions, keyboard
  tab navigation, tab strips on any edge, `onShow` / `onHide` renderer hooks, and
  floating/popout windows as nested multi-group layouts.

### Notes

- The stylesheet moved with the package: `dockview/dist/styles/dockview.css`. The copy
  vendored at `release/styles/dockview.css` was refreshed — v6 rebuilt the spaced themes
  on CSS variables.
- Several features are now licensed separately (`dockview-enterprise`): pinned tabs,
  multi-row tabs, advanced overflow, the DnD compass, smart guides, auto-hide edge
  groups, spatial keyboard navigation, tab context menus and layout history. Their
  options type-check on the free package and do nothing. The last two are rebuilt here
  on the public api; `pin` is the one built-in context menu item that cannot be.
