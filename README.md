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
> Requires TEDI >= 0.2.26 for the `ctx.headerBar`,
> `ctx.tabs.openExtensionTab`, `ctx.ui.codeEditor`, and
> `ctx.app.setSidebarVisible` host APIs the workbench uses.

---

## Install

1. Open **Settings → Extensions** in TEDI.
2. Switch to the **From GitHub** tab.
3. Paste `IlhamriSKY/TEDI.sql-explorer` and click **Review → Install**.

Click the **Database icon** that appears in the header next to the SSH
icon, or press `Mod+Alt+D`, to open the workbench tab.

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
| `panels:register` | Mount the workbench renderer as a workspace tab. |
| `headerbar:write` | Header button next to the SSH icon. |
| `tabs:open` | Open / focus the workbench tab. |
| `ui:toast` | Connect / save / export result toasts. |
| `settings:read` / `settings:write` | Persist saved connections (sans password). |
| `secrets:read` / `secrets:write` | Read / write passwords in the OS keychain. |
| `invoke:shell_bg_spawn_direct` / `invoke:shell_bg_logs` / `invoke:shell_bg_kill` | Spawn, poll, and stop the sidecar. |

No filesystem permissions. The sidecar binds `127.0.0.1` only and
authenticates every call with the per-boot bearer token; no other
machine on the LAN can reach it.

## Development

```bash
git clone https://github.com/IlhamriSKY/TEDI.sql-explorer.git
cd TEDI.sql-explorer

# Build the sidecar for your host.
cd sidecar-src
cargo build --release
mkdir -p ../sidecar/<platform>-<arch>      # e.g. windows-x86_64
cp target/release/tedi-sql-helper* ../sidecar/<platform>-<arch>/
cd ..

# Package + install via Settings → Extensions → From file:
zip -r dev.zip manifest.json extension.js logo.png README.md CHANGELOG.md LICENSE sidecar
```

To cut a release, tag `vX.Y.Z` and push. The CI in
[`.github/workflows/release.yml`](.github/workflows/release.yml) builds
the sidecar for every supported platform and uploads the zip to the
GitHub release.
