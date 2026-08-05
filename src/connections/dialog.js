// SQL Explorer — connections/dialog: the New/Edit connection modal. The engine
// list + host/file fields + TLS options are driven by the dialect registry.
// Bundled into extension.js by build.mjs.
import { getDialect, listDialects } from "../dialects/index.js";
import { openCenteredDialog } from "../dialogs.js";
import { checkbox, clearChildren, cryptoId, el, input, numberInput, safeToast, select } from "../dom.js";
import { ctx } from "../runtime.js";
import { connectFromForm, saveAndConnect } from "./lifecycle.js";
import { listSshHosts, tunnelsSupported } from "./tunnel.js";
import { getSecret } from "./store.js";

export async function openConnectionDialog(existing) {
  const isEdit = Boolean(existing?.id);
  // Prefetch the password from the OS keychain BEFORE rendering the
  // dialog so the form is fully populated on first paint. The old
  // async-then-set-input flow had a window where a quick "Test" click
  // would fire with an empty password and fail before the secret
  // resolved.
  let prefetchedPassword = "";
  if (isEdit && existing?.kind !== "sqlite") {
    try {
      prefetchedPassword = (await getSecret(existing.id)) ?? "";
    } catch (err) {
      ctx?.logger?.warn?.("password prefetch failed", err);
    }
  }

  // Centered modal over a dimmed backdrop, like the Settings dialog. Esc /
  // backdrop-click / the X button close it.
  const { body, close } = openCenteredDialog({
    title: isEdit ? "Edit connection" : "New connection",
  });
  // Saved SSH hosts for the tunnel picker. Fetched before the first paint so
  // the field renders with its real options instead of popping in.
  const sshHosts = await listSshHosts();

  const form = {
    id: existing?.id ?? cryptoId(),
    sshTunnel: existing?.sshTunnel ?? "",
    name: existing?.name ?? "",
    kind: existing?.kind ?? "mysql",
    host: existing?.host ?? "127.0.0.1",
    port: existing?.port ?? "",
    user: existing?.user ?? "",
    database: existing?.database ?? "",
    password: prefetchedPassword,
    allow_writes: existing?.allow_writes ?? false,
    sslMode: existing?.sslMode ?? "none",
    sqliteReadOnly: existing?.sqliteReadOnly ?? false,
    sqlitePath:
      existing?.kind === "sqlite"
        ? (existing?.sqlitePath ?? existing?.host ?? existing?.database ?? "")
        : "",
    query_timeout_ms: existing?.query_timeout_ms ?? 30000,
    row_limit: existing?.row_limit ?? 10000,
  };

  const grid = el("div", { class: "tsql-form-grid" });

  function field(label, control, full = false) {
    const wrap = el("label", { class: `tsql-field${full ? " is-full" : ""}` });
    wrap.appendChild(el("span", { class: "tsql-label", text: label }));
    wrap.appendChild(control);
    return wrap;
  }

  const nameInput = input({ value: form.name, onInput: (v) => (form.name = v) });
  const kindSelect = select(
    listDialects().map((d) => ({ value: d.id, label: d.label })),
    form.kind,
    (v) => {
      form.kind = v;
      rerenderDialog();
    },
  );

  function renderHostFields() {
    if (getDialect(form.kind).fileBased) {
      const filePath = input({
        value: form.sqlitePath,
        onInput: (v) => (form.sqlitePath = v),
        placeholder: "C:/data/app.db or :memory:",
      });
      return [
        field("File path", filePath, true),
        field(
          "Read-only",
          checkbox(form.sqliteReadOnly, (v) => (form.sqliteReadOnly = v)),
        ),
      ];
    }
    return [
      field(
        "Host",
        input({ value: form.host, onInput: (v) => (form.host = v) }),
      ),
      field(
        "Port",
        input({
          value: form.port ?? "",
          onInput: (v) => (form.port = v),
          placeholder: getDialect(form.kind).defaultPort,
        }),
      ),
      field(
        "User",
        input({ value: form.user, onInput: (v) => (form.user = v) }),
      ),
      field(
        "Password",
        input({
          type: "password",
          value: form.password,
          onInput: (v) => (form.password = v),
        }),
      ),
      field(
        getDialect(form.kind).databaseIsConnectTarget
          ? "Maintenance database"
          : "Database (optional)",
        input({
          value: form.database,
          onInput: (v) => (form.database = v),
          placeholder: getDialect(form.kind).databaseIsConnectTarget
            ? "postgres"
            : "leave blank to browse all, or list several: app, shop",
        }),
      ),
      // Tunnel through a host saved in TEDI's SSH manager. Named by id: the
      // credentials stay in the keychain and never reach this extension.
      field(
        "SSH tunnel",
        sshHosts.length
          ? select(
              [
                { value: "", label: "None (connect directly)" },
                ...sshHosts.map((h) => ({
                  value: h.id,
                  label: `${h.name || h.host} (${h.user}@${h.host})`,
                  // Findable by address as well as by name, matching the host's
                  // own jump-host combobox in the SSH dialog.
                  keywords: `${h.user}@${h.host}:${h.port ?? ""} ${h.id}`,
                })),
              ],
              form.sshTunnel,
              (v) => (form.sshTunnel = v),
              { searchable: true, searchPlaceholder: "Search saved hosts…" },
            )
          : el("span", {
              class: "tsql-label-type",
              // Three reasons the list can be empty, and the user can only act
              // on two of them, so say which one this is.
              text: tunnelsSupported()
                ? "No verified SSH hosts yet. Add one in the SSH sidebar and open it once to confirm its fingerprint."
                : "SSH tunnels need a newer TEDI.",
            }),
        true,
      ),
      field(
        "TLS",
        select(
          [
            { value: "none", label: "None" },
            { value: "preferred", label: "Preferred" },
            { value: "required", label: "Required" },
            { value: "verify_ca", label: "Verify CA" },
            { value: "verify_full", label: "Verify full" },
          ],
          form.sslMode,
          (v) => (form.sslMode = v),
        ),
      ),
    ];
  }

  function rerenderDialog() {
    clearChildren(grid);
    grid.appendChild(field("Name", nameInput, true));
    grid.appendChild(field("Engine", kindSelect));
    for (const f of renderHostFields()) grid.appendChild(f);
    grid.appendChild(
      field(
        "Mode",
        select(
          [
            { value: "ro", label: "Read-only" },
            { value: "rw", label: "Read + Write" },
          ],
          form.allow_writes ? "rw" : "ro",
          (v) => (form.allow_writes = v === "rw"),
        ),
      ),
    );
    grid.appendChild(
      field(
        "Query timeout (ms)",
        numberInput({
          value: String(form.query_timeout_ms),
          min: 0,
          step: 100,
          onInput: (v) => (form.query_timeout_ms = Number(v) || 0),
        }),
      ),
    );
    grid.appendChild(
      field(
        "Row cap",
        numberInput({
          value: String(form.row_limit),
          min: 0,
          step: 100,
          onInput: (v) => (form.row_limit = Number(v) || 0),
        }),
      ),
    );
  }

  rerenderDialog();
  body.appendChild(grid);

  const error = el("p", { class: "tsql-form-error" });
  body.appendChild(error);

  const actions = el(
    "div",
    { class: "tsql-dialog-actions" },
    el("button", {
      class: "tsql-btn is-outline",
      text: "Cancel",
      attrs: { type: "button" },
      on: {
        click: () => close(),
      },
    }),
    el("button", {
      // Secondary, NOT primary: Test and Add were the same filled blue, so the
      // footer offered two equally-loud actions and neither read as the one
      // that finishes the dialog.
      class: "tsql-btn is-outline",
      text: "Test",
      attrs: { type: "button" },
      on: {
        click: async () => {
          error.textContent = "";
          try {
            await connectFromForm(form, { test: true });
            error.style.color = "var(--primary)";
            error.textContent = "Connected successfully.";
            safeToast(`Connected to ${form.name || form.host || form.sqlitePath}`, "success");
          } catch (err) {
            error.style.color = "var(--destructive, #ef4444)";
            error.textContent = `Test failed: ${err?.message ?? err}`;
          }
        },
      },
    }),
    el("button", {
      class: "tsql-btn is-primary",
      text: isEdit ? "Save" : "Add",
      attrs: { type: "button" },
      on: {
        click: async () => {
          error.textContent = "";
          try {
            await saveAndConnect(form);
            close();
            safeToast(
              `${isEdit ? "Updated" : "Added"} connection ${form.name || form.id}`,
              "success",
            );
          } catch (err) {
            error.style.color = "var(--destructive, #ef4444)";
            error.textContent = err?.message ?? String(err);
          }
        },
      },
    }),
  );
  body.appendChild(actions);
}
