# Changelog

All notable changes to the TEDI SQL Explorer extension are documented here.

## 0.1.0 — 2026-05-25

Initial release.

- Native Rust sidecar (`tedi-sql-helper`) speaking HTTP+JSON on `127.0.0.1`
  with a per-session bearer token. Loopback bind, token rotated on every
  boot, never written to disk.
- Driver matrix via [`sqlx`](https://crates.io/crates/sqlx):
  - MySQL / MariaDB (TLS via native-tls)
  - PostgreSQL (TLS via native-tls)
  - SQLite (read/write or read-only modes)
- Connection manager
  - Stored under `ext:tedi.sql-explorer:connections` in TEDI settings.
  - Passwords stored separately in the OS keychain (`secrets:write`),
    never in the settings JSON.
- Schema browser
  - Databases → schemas → tables / views → columns.
  - Lazy fetch; refreshable per node.
- Query editor
  - Multi-statement scripts (split on `;` honouring quote/escape state).
  - Run / Stop / cancel via abort-signal forwarded to the sidecar.
  - Per-statement timing + rows-affected.
- Result grid
  - Paginated, sortable, column-resize, copy cell.
  - Inline edit with dirty-marker; save-as-UPDATE issued via prepared
    statements using the table's primary key.
  - INSERT new row and DELETE selected rows.
- Export
  - CSV (RFC 4180), JSON, and `INSERT` SQL.
  - Output via the standard TEDI save-file dialog.
- Security
  - Sidecar enforces an `allow_writes` flag per connection; SELECT-only by
    default. Toggle requires explicit confirmation.
  - Read row caps and query timeout (configurable per connection).
  - `DROP DATABASE` / `TRUNCATE` / `DROP SCHEMA` require a typed
    confirmation in the host UI before the statement reaches the sidecar.
