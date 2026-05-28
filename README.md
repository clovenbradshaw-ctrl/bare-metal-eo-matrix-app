# bare-metal-eo — Airtable+ patch

A drop-in patch that brings the matrix-app closer to Airtable parity (and
beyond, where the event log gives us reach Airtable can't match).

## What changed

### Date column — per-field display config (May 2026)

Previously `formatDateCell()` accepted a friendly/iso/relative `dateFormat`
flag but there was no UI for it. This round wires the whole thing up as a
first-class per-column config, **timezone-aware**.

- **`field.dateOpts`** — new schema-as-log field shape, stored at
  `_schema.fields.<entityType>[i].dateOpts`. Defaults:
  ```js
  {
    format: 'friendly',     // 'friendly' | 'absolute' | 'relative' | 'iso'
    includeTime: false,
    hour12: false,
    showSeconds: false,
    showWeekday: false,
    showYear: 'auto',       // 'auto' | 'always' | 'never'
    timezone: 'local',      // 'local' | 'utc' | IANA id (e.g. 'America/Los_Angeles')
    showRelativeSub: false, // small italic relative-time line under the cell
  }
  ```
  `defaults` come from `DEFAULT_DATE_OPTS` in `table-view.jsx`. The fold
  doesn't touch this — it's pure display config under `_schema.*` like
  everything else.
- **Column-type popover gets a date-params editor** (`<DateParams>` in
  `table-view.jsx`). Four-button segmented control for the format,
  toggle chips for time / 12-hour / seconds / weekday / relative-sub,
  year dropdown, curated IANA timezone dropdown + custom IANA input
  with `Intl.DateTimeFormat` validation, and a **live preview block** at
  the bottom that re-renders against `new Date()` as you toggle.
- **`formatDateCell()` rewrite** — projects through the chosen IANA
  timezone via `Intl.DateTimeFormat` + a `partsInTz()` helper, so
  "today / tomorrow / yesterday" are calculated in the display zone
  (stable across DST and remote-zone setups). Returns
  `{ text, sub, title, tone, tzLabel }`:
  - `text` — the headline (`today, 3:42 PM`, `in 3d`, `May 28`, etc.)
  - `sub` — optional italic sub-line (the *other* representation —
    relative if headline is absolute and vice versa)
  - `title` — multi-line tooltip with absolute, relative, tz short
    name + offset, and full ISO
  - `tone` — `date-past` / `date-today` / `date-soon` / `date-future`
    (unchanged)
  - `tzLabel` — short zone tag (`PDT`, `JST`, `UTC+5:30`), only set
    when the display zone differs from the browser zone; rendered
    inline next to the cell as a small pill
- **Date-only values bypass the timezone projection.** A stored
  `'2026-05-28'` is parsed at noon-local so it lands on the same
  calendar day regardless of the viewer's zone; only timestamped
  values get reprojected.
- **`EditableCell` editor honors `includeTime`** — switches to
  `<input type="datetime-local">` when the column has time enabled,
  pre-populating from the stored ISO. Plain date input otherwise.
- **CSS additions** (`index.html`):
  - `.date-params` editor styles (segmented control, toggle chips,
    pair rows, live-preview card).
  - `.cell.date` becomes a flex column to host `.cell-main` +
    `.cell-sub`.
  - `.date-tz-pill` — small uppercase mono badge for the tz tag.
  - Refined tone bars (left inset shadow per `tone` class).
- **`fmtAbsDate` / `fmtRelTime`** (used by schema stats + entity
  timeline) tightened: minute/hour/day/month/year units, year only
  shown for cross-year timestamps, common `formatRelative()` helper
  shared with the cell formatter.
- **`entity-timeline.jsx`** gets a `fmtDateWithRel(ts)` helper —
  every timestamp on entity meta and event cards now renders as
  `Mar 12, 2:14 PM · 3d ago` with full ISO on hover.

### Top-line additions (earlier round)

- **Real formulas** (`public/formula.js`, new) — runtime evaluator with ~80
  functions covering Airtable's reference list (string / numeric / logic /
  date / regex / arrays). Computed at render time; **not** written to the
  log. The expression lives in `_schema.fields.<set>.formula`.
- **Rollups** — first-class `type: 'rollup'` field with `{via, field, fn}`
  config; aggregates over CON edges (`count` / `sum` / `avg` / `min` /
  `max` / `list` / `concat` / `and` / `or`).
- **Smart dates** — `date` field type now displays as friendly relative
  text (today / tomorrow / 3d ago / Aug 5) with full ISO on hover, gets
  tone classes (`date-past` / `date-today` / `date-soon` / `date-future`)
  for conditional formatting, and accepts natural-language input ("next
  fri", "in 3 days", "tomorrow") in the editor via `smartParseDate()`.
- **Duration field** (`type: 'duration'`) — stored as seconds, rendered
  as `2h 30m` / `1d 4h`, accepts `1h 15m` / `45m` / plain minutes input.
- **Phosphor icons** (`@phosphor-icons/web` CDN) — per-field-type icons
  everywhere: column headers, the column popover, kanban card field
  rows, the schema view.
- **Column popover** — click a header to rename / change type / set
  params (formula textarea, rollup selects, select options chips) all
  inline. Right-click works as a shortcut.
- **Formula autocomplete** — type `{` for field names, letters for
  function names; ↑↓ to navigate, ⏎/⇥ to accept, ⌘/Ctrl+⏎ to save.
- **Kanban airtable-style toolbar** — `fields` menu (toggle which fields
  show on cards), `filter cards…` search, live count, **+ add column**
  drop zone at the right that emits `DEF _schema.partitions.<type>`.
- **Topbar `import` button** in demo mode too (CSV-only) — graceful
  fallback message for non-CSV files when not signed in.
- **Time-travel scrubber collapsed by default** — toggled from the
  topbar; auto-opens when the cursor isn't live, so the user can
  always return.
- **Activity ephemerals** — clicks on real UI controls (sidebar /
  topbar / tabs / etc.) get captured as ephemeral `sig` signals and
  surface in a floating bottom-right rail.
- **Log reversed** — most-recent event at the top of the timeline,
  but `idx` still tied to the actual log position.

### Grid-cosmetic / UX cleanup

- "Formula fields" toggle button + col tallies removed from the
  dbtable header and schema view.
- New columns added via `+` always land on the rightmost edge of the
  grid (partition + linked-records columns moved to the LEFT of the
  user's schema fields, with auto-scroll-right on add).
- Min-widths on every cell so adding a new column doesn't make the
  existing ones jump width.
- "+ new set" moved to the top of the sidebar's sets section.

### Engine — one event per import

- `engine.js` `INS` fold now expands a `rows: […]` payload into N
  entities. A whole CSV import is **one event** that materialises N
  rows at fold time (the wrapper entity at `anchor` also records
  `_bulkCount` and `_bulkTarget` so the file shows up in audit views).
- `csv-import.jsx` still needs a follow-up to switch from N+3 events
  to 1 + schema-DEFs — the engine support is in place but the
  importer hasn't been re-wired yet (left as a separate diff).

## Files in this patch

```
patches/
├─ index.html                       → repo root (REPLACE)
├─ public/engine.js                 → public/   (REPLACE)
├─ public/formula.js                → public/   (NEW)
├─ public/app.jsx                   → public/   (REPLACE)
├─ public/app-view.jsx              → public/   (REPLACE)
├─ public/db-view.jsx               → public/   (REPLACE)
├─ public/table-view.jsx            → public/   (REPLACE)
├─ public/entity-timeline.jsx       → public/   (REPLACE)
├─ public/sidebar.jsx               → public/   (REPLACE)
└─ public/matrix-auth.jsx           → public/   (REPLACE)
```

## How to apply

1. Unzip into a working copy of `bare-metal-eo-matrix-app/`.
2. Copy each file into its destination (mirror the `patches/` tree
   into the repo root).
3. `npm install` is **not** required for this patch — no new npm deps
   were added. The only new external is the Phosphor CSS/icons CDN
   loaded from `<script src="https://unpkg.com/@phosphor-icons/web@2.1.1">`.
4. `npm run dev` (or whatever your dev script is) and reload.

### Schema-as-log migration notes

The date-display round adds a new optional `dateOpts` key on `date`
fields under `_schema.fields.<entityType>[i]`. Old rooms with no
`dateOpts` keep working unchanged — `formatDateCell` falls back to
`DEFAULT_DATE_OPTS` (`friendly`, no time, browser tz, year=auto).

No `REC` is required; this is a strictly additive display-side
extension. Other clients that read the same room but don't know
about `dateOpts` will just render with their own default formatter,
which is the interop story the schema-as-log convention promises.

Nothing changes about the event protocol, the room manifest, the
auth flow, the IndexedDB scoping, or the outbox — this patch is
entirely additive on top of the existing engine + UI.

## Try it

- Click a column header in any table → rename / change type /
  edit params inline.
- Add a column with `+` at the right edge → type picker first
  (Airtable flow), new column lands rightmost.
- On a `formula` field, type `{` to autocomplete field names,
  letters for functions; press ⌘/Ctrl+⏎ to save.
- On a `rollup` field, pick a relation + fn + (optional) field
  via three selects. Try `sum(estimate_h) via blocks` on a task.
- In the kanban projection, click `fields` to hide priority/etc.
  on cards; type in `filter cards…` to live-filter. Drag the
  `+ add column` form open at the right to add a new partition.
- Type `next fri`, `tomorrow`, `+3 days`, `Aug 5` into a date
  cell — smart-parses to a real date.

## Known follow-ups

- The CSV importer (`csv-import.jsx`) still emits N row INSes;
  switching it to a single-event `rows: […]` payload is a small
  diff — the engine already accepts it.
- The right-click "edit params" path inside the column popover is
  wired for formula / rollup / select / multiselect / **date**.
- Date editor doesn't yet do **natural-language parsing in tz**
  (e.g. "tomorrow 9am Tokyo"); the `<input type="datetime-local">`
  reads in browser-local. The stored ISO is still UTC, so display
  reprojection works correctly — but a typed "tomorrow" lands at
  the browser's wall-clock, not the column's display zone.
- No per-row override yet — `dateOpts` is purely column-level. A
  cell-level override would mean per-cell `DEF` on a synthetic
  `_displayOpts.<field>` path; deferred until someone actually
  needs it.
