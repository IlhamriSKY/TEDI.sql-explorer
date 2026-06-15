# TEDI SQL Explorer

HeidiSQL-style database workbench for [TEDI](https://github.com/IlhamriSKY/TEDI):
connect to **MySQL / MariaDB**, **PostgreSQL**, or **SQLite**, browse
the schema, write multi-statement queries with syntax highlight, edit
rows inline, and export results — all in a workspace tab next to your
terminals.

<p align="center">
  <img src="logo.png" alt="SQL Explorer" width="128" />
</p>

> [!NOTE]
> Requires TEDI >= 0.3.37 (see `engines.tedi` in manifest.json — the
> authoritative value) for the `ctx.sidebar`, `ctx.tabs.openExtensionTab` /
> `openExtensionPane`, and `ctx.ui.codeEditor` host APIs the workbench uses.

---

## Install

1. Open **Settings → Extensions** in TEDI.
2. Switch to the **From GitHub** tab.
3. Paste `IlhamriSKY/TEDI.sql-explorer` and click **Review → Install**.

Open a connection from the **Databases** section in the left sidebar, or
press `Mod+Alt+D`, to open the workbench.

## Update

In **Settings → Extensions**, click **Check updates** on this extension's
card. If a new release exists, click **Update** to reinstall in place.

## How it works

```
TEDI webview                            Native sidecar
┌────────────────────────┐  HTTP +    ┌──────────────────────────┐
│ extension.js (UI)      │  Bearer    │ tedi-sql-helper          │
│ • workspace tab        │ ◀────────▶ │ • axum on 127.0.0.1:rand │
│ • schema tree          │  random    │ • per-boot 32-byte token │
│ • CodeMirror SQL editor│  port      │ • sqlx pool per conn id  │
│ • result grid          │            └────────────┬─────────────┘
└────────────────────────┘                         │ TLS + prepared
        │ ctx.secrets (OS keychain)                ▼
        ▼                                    MySQL / PG / SQLite
   credentials store
```

On open:

1. Extension spawns the sidecar via `shell_bg_spawn_direct`.
2. Sidecar prints `READY {port,token}`; the extension reads via
   `shell_bg_logs` and authenticates every request with the token.
3. CRUD goes through prepared statements:
   - **UI:** insert dialog, double-click cell to edit, row delete.
   - **Query editor:** free-form multi-statement, gated on the
     per-connection `allow_writes` flag.
4. Passwords live in the OS keychain; never persisted to JSON.
5. Identifiers (db / schema / table / column) pass a strict
   `^[A-Za-z_][A-Za-z0-9_]*$` allow-list before being inlined.

## Permissions

| Permission | Why |
| --- | --- |
| `panels:register` | Mount the workbench renderer as a pane. |
| `sidebar:write` | The "Databases" connection + schema tree in the left sidebar. |
| `tabs:open` | Open / focus the workbench pane. |
| `ui:toast` | Connect / save / export result toasts. |
| `settings:read` / `settings:write` | Persist saved connections (sans password). |
| `secrets:read` / `secrets:write` | Read / write passwords in the OS keychain. |
| `invoke:shell_bg_spawn_direct` / `invoke:shell_bg_logs` / `invoke:shell_bg_kill` | Spawn, poll, and stop the sidecar. |

No filesystem permissions. The sidecar binds `127.0.0.1` only and
authenticates every call with the per-boot bearer token; no other
machine on the LAN can reach it.

## Development

### Source layout

The extension UI is written as small ES modules under `src/` and **bundled**
into the single `extension.js` that TEDI loads (the host reads only
`manifest.main` and imports it as one module, so the shipped extension must be
a single file). `extension.js` is generated — **edit `src/`, not
`extension.js`** — and committed so install-from-GitHub needs no build step.

| Module | Responsibility |
| --- | --- |
| `runtime.js` | Shared state singletons (`ctx`, `sidecar`, `panelRoot`, …) + app constants + their setters. |
| `sidecar.js` | Spawn / handshake / auto-respawn the native helper; `fetchJson`. |
| `dom.js` | DOM toolkit: `el`, icons, inputs, `select`, context menu, tooltip layer. |
| `dialogs.js` | Centered / confirm modals + read-only SQL preview. |
| `sql.js` | Identifier quoting + `SELECT/INSERT/UPDATE/DELETE` builders. |
| `columns.js` | Column-type classification + `/columns` metadata fetch. |
| `connections.js` | Connection dialog, CRUD, connect-with-retry, secrets. |
| `tree.js` | Left-sidebar connection → db → schema → table tree. |
| `render.js` | Panel shell, editor + results layout, action-SQL strip. |
| `query.js` | Run / cancel queries, multi-statement result rendering. |
| `grid.js` | Result + table-browse grids, paging, copy, cell display. |
| `gridedit.js` | Inline cell edit, row insert/delete, Structure view. |
| `export.js` | CSV / JSON / SQL export dialog. |
| `styles.js` | Scoped CSS. |
| `index.js` | `activate` / `deactivate` + wiring. |

### Build

```bash
git clone https://github.com/IlhamriSKY/TEDI.sql-explorer.git
cd TEDI.sql-explorer

# UI: install the bundler (esbuild) and build extension.js from src/.
npm install
npm run build          # one-shot: src/ → extension.js
npm run watch          # rebuild on save during development

# Sidecar: build the native helper for your host.
cd sidecar-src
cargo build --release
mkdir -p ../sidecar/<platform>-<arch>      # e.g. windows-x86_64
cp target/release/tedi-sql-helper* ../sidecar/<platform>-<arch>/
cd ..

# Package + install via Settings → Extensions → From file
# (ships the BUILT extension.js, not src/):
zip -r dev.zip manifest.json extension.js logo.png README.md CHANGELOG.md LICENSE sidecar
```

> When developing against a TEDI checkout that dev-links this folder
> (`pnpm tauri:dev:ext`), run `npm run watch` here so `extension.js`
> rebuilds on every edit, then reload the TEDI window (Ctrl+R).

To cut a release, tag `vX.Y.Z` and push. The CI in
[`.github/workflows/release.yml`](.github/workflows/release.yml) builds
the sidecar for every supported platform and uploads the zip to the
GitHub release.
