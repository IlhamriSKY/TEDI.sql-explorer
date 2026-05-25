# TEDI SQL Explorer

Companion extension for [TEDI](https://github.com/IlhamriSKY/TEDI) that
adds a HeidiSQL-style database workbench to the right-panel slot.
Connect to **MySQL / MariaDB**, **PostgreSQL**, or **SQLite**, browse
the schema, write multi-statement queries, edit rows inline, and export
results — all without leaving the editor.

<p align="center">
  <img src="logo.png" alt="SQL Explorer" width="128" />
</p>

> [!NOTE]
> A native Rust sidecar (`tedi-sql-helper`) ships inside the extension's
> release zip and runs as a local subprocess of TEDI. It binds
> `127.0.0.1` only, generates a fresh 32-byte bearer token on every
> boot, and is killed when the extension is disabled or uninstalled.
> The TEDI core does not bundle any database drivers — uninstalling the
> extension removes every one of them with it.

---

## Install

In TEDI:

1. Open **Settings → Extensions**.
2. Switch to the **From GitHub** tab.
3. Paste `IlhamriSKY/TEDI.sql-explorer` (or the full URL).
4. Click **Review → Install**.

That's it. No manual settings to flip. The extension registers a panel
+ command + keybinding with TEDI's generic extension API at activate;
from then on the **SQL Explorer** button in the status bar (or
`Mod+Alt+D`) opens the workbench in the right slot until you disable or
uninstall.

TEDI hits `releases/latest` on this repo, downloads the `.zip` asset
produced by the [release workflow](.github/workflows/release.yml), runs
its standard install pipeline (size cap, path-traversal guard, manifest
validation, fingerprint), and activates the extension. The card with
this README's logo appears in Settings → Extensions; the card-level
Switch is the only on/off control.

### Updating

The same Settings → Extensions screen has a **Check updates** button.
TEDI compares `tag_name` of the latest GitHub release against the
installed `manifest.version`. If newer, an **Update** button re-runs
the install pipeline against the new release. No manual download.

---

## Features

| Area              | What it does |
|-------------------|--------------|
| Connections       | MySQL / PostgreSQL / SQLite with TLS modes (`preferred`, `required`, `verify_ca`, `verify_full`). Passwords stored in the OS keychain (`ext:tedi.sql-explorer:conn:<id>`), never in settings JSON. |
| Schema tree       | Databases → schemas → tables / views → columns. Lazy fetch, per-node refresh, primary-key + AUTOINCREMENT detection. |
| Query editor      | Multi-statement scripts split on `;` honouring quote and comment state. Run / Stop / cancel via in-flight abort. |
| Result grid       | Paginated, sortable, NULL / bool / bytes chip rendering. Double-click a cell to inline-edit; UPDATE is issued via prepared statements using the table's primary key. |
| Row mutations     | INSERT new row via auto-generated form, DELETE selected row with PK confirmation. |
| Export            | CSV (RFC 4180), JSON, or `INSERT` SQL via the system download mechanism. |
| Safety            | Per-connection `allow_writes` flag (SELECT-only by default), query timeout, row cap, destructive-statement typed-confirm prompt. |

---

## How it works

```
TEDI webview                                    tedi-sql-helper.exe
┌──────────────────────────┐                   ┌─────────────────────────────┐
│ extension.js  (UI)       │   HTTP + Bearer   │ axum router on 127.0.0.1     │
│ right-panel slot         │ ◀───────────────▶ │ token = 32 random bytes      │
│ vanilla DOM, CSS vars    │   port = OS pick  │ sqlx pools per conn id       │
└──────────────────────────┘                   └────────────────┬─────────────┘
        │                                                        │ TLS + parametrised
        │ ctx.secrets (OS keychain)                              ▼
        ▼                                              MySQL / PostgreSQL / SQLite
   credentials store
```

On `activate(ctx)` the extension:

1. Resolves the sidecar binary path from `ctx.installPath` +
   `ctx.os.platform`/`arch` — the same convention `tedi.screenshot`
   uses.
2. Spawns it via `shell_bg_spawn_direct` (one process per TEDI window;
   no shell wrapper, the tracked PID is the helper itself).
3. Polls `shell_bg_logs` until the helper prints
   `READY {"port":N,"token":"..."}` (≤ 12s budget) and connects via
   `fetch()` with `Authorization: Bearer <token>` on every request.
4. Registers a right-panel renderer and the `tedi.sql-explorer.toggle`
   command keybind (`Mod+Alt+D`).

On `deactivate()`:

1. Best-effort `POST /shutdown` so sqlx can drain its pools.
2. `shell_bg_kill` as the hard fallback.

The host's permission gates do the rest: every Tauri command the
extension can call is listed in `manifest.permissions`, and TEDI's
`isInvokeAllowed` check refuses anything else. The sidecar itself
rejects every request whose bearer token does not match the per-boot
value — even from another process on the same machine.

### Security boundary

- **Network**: sidecar listens on `127.0.0.1:0` (kernel-assigned port).
  No other machine on the LAN can reach it.
- **Authentication**: 32-byte hex token, regenerated on every boot,
  never persisted to disk. Constant-time comparison.
- **SQL injection**: identifiers (database / schema / table / column
  names) pass through a strict `^[A-Za-z_][A-Za-z0-9_]*$` allow-list
  before being inlined; every cell value is bound via a sqlx prepared
  statement.
- **Credential storage**: passwords go straight to the OS keychain via
  `ctx.secrets.set`. The settings JSON only ever stores host / user /
  database / TLS-mode / `allow_writes` flags.
- **Write gate**: `allow_writes: false` by default. Any INSERT /
  UPDATE / DELETE / DDL is rejected at the sidecar with a clear error.
- **Destructive prompts**: `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE`,
  and `GRANT` require a typed-OK confirmation in the host UI **before**
  the request leaves the webview.

---

## Keybindings

| Action                          | Default       |
|---------------------------------|---------------|
| Toggle SQL Explorer panel       | `Mod+Alt+D`   |
| Run current query / statement   | `Mod+Enter` (inside the editor) |

The toggle is rebindable in *Settings → Shortcuts → Extensions* under
the **SQL Explorer** group. `Mod+Enter` is a DOM-level handler scoped
to the editor textarea and does not collide with TEDI core shortcuts.

---

## Permissions

Declared in `manifest.json`:

```json
"permissions": [
  "panels:register",
  "ui:toast",
  "settings:read",
  "settings:write",
  "secrets:read",
  "secrets:write",
  "invoke:shell_bg_spawn_direct",
  "invoke:shell_bg_logs",
  "invoke:shell_bg_kill"
]
```

| Permission                       | What it lets the extension do |
|----------------------------------|-------------------------------|
| `panels:register`                | Register the right-panel renderer + auto-render the status-bar toggle button from the manifest. |
| `ui:toast`                       | Surface connect / query / export results. |
| `settings:read` / `settings:write` | Persist saved connections (sans password) under `ext:tedi.sql-explorer:connections`. |
| `secrets:read` / `secrets:write` | Read / write each connection's password in the OS keychain (`ext:tedi.sql-explorer:conn:<id>`). |
| `invoke:shell_bg_spawn_direct`   | Spawn the sidecar without a shell wrapper. |
| `invoke:shell_bg_logs`           | Poll the sidecar's stdout for the READY line. |
| `invoke:shell_bg_kill`           | Terminate the sidecar on deactivate / restart. |

No filesystem permissions are requested. No `*` wildcard. The sidecar
is the only thing that ever holds an open database socket.

---

## Compatibility

Requires TEDI **>= 0.2.20** for `panels[].compact` semantics + stable
`ctx.os.platform`/`arch` + `shell_bg_spawn_direct` (same baseline the
`tedi.screenshot` extension declares).

If a missing host API at runtime breaks anything, the extension fires
a single warning toast at activate, names the missing function
(e.g. `ctx.registerPanelRenderer`), and stays idle so disable /
uninstall still tears down cleanly.

The sidecar build matrix covers:

| Platform  | Target                       |
|-----------|------------------------------|
| Windows   | `x86_64-pc-windows-msvc`     |
| macOS     | `x86_64-apple-darwin`        |
| macOS     | `aarch64-apple-darwin`       |
| Linux     | `x86_64-unknown-linux-gnu`   |

`runtime-tokio-rustls` keeps the binary free of system OpenSSL deps —
the sidecar is statically linked except for the platform libc and
SQLite is vendored.

---

## Local development

```bash
git clone https://github.com/IlhamriSKY/TEDI.sql-explorer.git
cd TEDI.sql-explorer

# Build the sidecar for your host (the CI workflow builds all four
# targets on release tags):
cd sidecar-src
cargo build --release
mkdir -p ../sidecar/windows-x86_64
cp target/release/tedi-sql-helper.exe ../sidecar/windows-x86_64/
cd ..

# Package + install into TEDI to test:
zip -r dev.zip manifest.json extension.js logo.png README.md CHANGELOG.md LICENSE sidecar
# In TEDI: Settings → Extensions → From file → dev.zip
```

After install, watch TEDI's dev-tools console (`Ctrl+Shift+I`) for
`[ext:tedi.sql-explorer]` log lines (sidecar boot, READY line, query
errors).

Cut a release with a `vX.Y.Z` tag — the bundled
[`.github/workflows/release.yml`](.github/workflows/release.yml) asserts
the tag matches `manifest.version`, builds the sidecar for every
matrix entry above, zips
`manifest.json + extension.js + logo.png + README.md + CHANGELOG.md +
LICENSE + sidecar/`, and uploads to the GitHub release that TEDI's
installer reads from `releases/latest`.

```bash
git tag v0.1.0
git push origin v0.1.0
```
