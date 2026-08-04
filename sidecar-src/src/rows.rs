//! `/table-rows`: the paged, sorted, filtered SELECT behind the browse grid.
//!
//! Split from `edit.rs` because reading a page and mutating a row are separate
//! jobs with separate risks: this one is about paging and the search predicate,
//! that one about addressing exactly one row by primary key.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Column, Executor as _, Row, Statement as _};

use crate::db::Backend;
use crate::error::{AppError, AppResult};
use crate::schema::{escape_mysql_ident, escape_pg_ident, qualify_mysql, qualify_pg, qualify_sqlite};
use crate::value::{decode_mysql_row, decode_pg_row, decode_sqlite_row};

#[derive(Deserialize)]
pub struct TableRowsRequest {
    pub conn: String,
    pub database: String,
    pub schema: String,
    pub table: String,
    #[serde(default)]
    pub order_by: Option<String>,
    #[serde(default = "default_order_dir")]
    pub order_dir: String,
    #[serde(default)]
    pub page: u64,
    #[serde(default = "default_page_size")]
    pub page_size: u64,
    /// Free-text search applied as a case-insensitive substring match.
    /// When `search_column` is set, the predicate runs against that one
    /// column; otherwise the client may supply `search_columns` to OR
    /// the predicate across multiple cells. Empty / missing means "no
    /// filter".
    #[serde(default)]
    pub search: Option<String>,
    /// Restrict the substring search to this single column. Mutually
    /// exclusive with `search_columns`; `search_column` wins if both
    /// are sent.
    #[serde(default)]
    pub search_column: Option<String>,
    /// All columns to OR the substring search across. Sent by the client
    /// because the sidecar would otherwise need an extra introspection
    /// round-trip to learn the column list per page load.
    #[serde(default)]
    pub search_columns: Option<Vec<String>>,
    /// Run the `COUNT(*)` that fills `total`. On a big InnoDB table that
    /// count is a full scan and it used to run on EVERY page flip, so
    /// paging through a large table paid for it again and again. The client
    /// asks for it when the filter changes and reuses the cached number
    /// while only the page moves.
    #[serde(default = "default_want_total")]
    pub want_total: bool,
}

fn default_want_total() -> bool {
    true
}

fn default_order_dir() -> String {
    "asc".into()
}

fn default_page_size() -> u64 {
    100
}

#[derive(Serialize)]
pub struct TableRowsResponse {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub total: Option<i64>,
    pub page: u64,
    pub page_size: u64,
}

fn order_dir_ok(s: &str) -> bool {
    matches!(s.to_ascii_lowercase().as_str(), "asc" | "desc")
}

// --------------------------- /table-rows -------------------------------------

/// Effective search query: trimmed; `None` if absent / empty.
fn search_term(req: &TableRowsRequest) -> Option<String> {
    let s = req.search.as_deref().unwrap_or("").trim();
    if s.is_empty() { None } else { Some(s.to_string()) }
}

/// Wrap the user-typed query in LIKE wildcards. We escape the SQL LIKE
/// metacharacters (%, _, \) so a search for "a_b" matches the literal
/// underscore instead of "any char between a and b".
fn like_pattern(q: &str) -> String {
    let mut out = String::with_capacity(q.len() + 2);
    out.push('%');
    for ch in q.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out.push('%');
    out
}

/// Build the `WHERE ...` clause and the ordered bind list for a search.
/// Returns `(where_sql_without_keyword, binds)` or `None` if no filter.
/// `quote_ident` formats the column identifier safely for the target
/// engine, `predicate` builds the per-column predicate including its
/// bind placeholder so MySQL/SQLite (`?`) and Postgres (`$N`) can both
/// route through this helper.
fn build_search_clause<F, G>(
    req: &TableRowsRequest,
    quote_ident: F,
    mut predicate: G,
) -> AppResult<Option<(String, Vec<String>)>>
where
    F: Fn(&str) -> AppResult<String>,
    G: FnMut(&str) -> String,
{
    let term = match search_term(req) {
        Some(t) => t,
        None => return Ok(None),
    };
    let pat = like_pattern(&term);
    let cols: Vec<String> = if let Some(col) = req.search_column.as_deref() {
        let t = col.trim();
        if t.is_empty() { return Ok(None); }
        vec![quote_ident(t)?]
    } else if let Some(cs) = &req.search_columns {
        let mut out = Vec::with_capacity(cs.len());
        for c in cs {
            let t = c.trim();
            if t.is_empty() { continue; }
            out.push(quote_ident(t)?);
        }
        out
    } else {
        return Ok(None);
    };
    if cols.is_empty() {
        return Ok(None);
    }
    let parts: Vec<String> = cols.iter().map(|c| predicate(c)).collect();
    let mut binds = Vec::with_capacity(parts.len());
    for _ in 0..parts.len() {
        binds.push(pat.clone());
    }
    let clause = format!("({})", parts.join(" OR "));
    Ok(Some((clause, binds)))
}

pub async fn list_rows(backend: &Backend, req: &TableRowsRequest) -> AppResult<TableRowsResponse> {
    if !order_dir_ok(&req.order_dir) {
        return Err(AppError::BadRequest("order_dir must be asc / desc".into()));
    }
    let page_size = req.page_size.clamp(1, 5_000);
    let offset = req.page.saturating_mul(page_size);

    match backend {
        Backend::Mysql(pool) => {
            let table = qualify_mysql(&req.database, &req.table)?;
            let mut sql = format!("SELECT * FROM {table}");
            // MySQL LIKE is case-insensitive on default collations; cast
            // non-string columns to CHAR so binary / numeric cells still
            // surface in the search.
            let search = build_search_clause(
                req,
                escape_mysql_ident,
                |c| format!("CAST({c} AS CHAR) LIKE ? ESCAPE '\\\\'"),
            )?;
            if let Some((clause, _)) = &search {
                sql.push_str(&format!(" WHERE {clause}"));
            }
            if let Some(col) = &req.order_by {
                let col = escape_mysql_ident(col)?;
                sql.push_str(&format!(" ORDER BY {col} {}", req.order_dir.to_uppercase()));
            }
            sql.push_str(&format!(" LIMIT {} OFFSET {}", page_size, offset));
            let mut q = sqlx::query(&sql);
            if let Some((_, binds)) = &search {
                for b in binds {
                    q = q.bind(b.as_str());
                }
            }
            // Preflight prepare so the column list survives 0-row results
            // (empty table, filter that matches nothing). sqlx caches the
            // prepared statement so the fetch below reuses it.
            let prep_cols: Option<Vec<String>> = pool.prepare(&sql).await.ok().map(|s| {
                s.columns().iter().map(|c| c.name().to_string()).collect()
            });
            let rows = q.fetch_all(pool).await?;
            let columns: Vec<String> = if rows.is_empty() {
                prep_cols.unwrap_or_default()
            } else {
                rows.first()
                    .unwrap()
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect()
            };
            let decoded: Vec<Vec<Value>> = rows.iter().map(decode_mysql_row).collect();
            let total = if req.want_total {
                count_mysql(pool, &table, search.as_ref()).await.ok()
            } else {
                None
            };
            Ok(TableRowsResponse {
                columns,
                rows: decoded,
                total,
                page: req.page,
                page_size,
            })
        }
        Backend::Postgres(pool) => {
            let table = qualify_pg(&req.schema, &req.table)?;
            // Postgres LIKE is case-sensitive; use ILIKE for case-
            // insensitive. Cast non-text columns to text so numeric /
            // jsonb / uuid cells participate in the substring search.
            let mut pg_idx: usize = 1;
            let search = build_search_clause(
                req,
                escape_pg_ident,
                |c| {
                    let s = format!("CAST({c} AS TEXT) ILIKE ${pg_idx}");
                    pg_idx += 1;
                    s
                },
            )?;
            let mut sql = format!("SELECT * FROM {table}");
            if let Some((clause, _)) = &search {
                sql.push_str(&format!(" WHERE {clause}"));
            }
            if let Some(col) = &req.order_by {
                let col = escape_pg_ident(col)?;
                sql.push_str(&format!(" ORDER BY {col} {}", req.order_dir.to_uppercase()));
            }
            sql.push_str(&format!(" LIMIT {} OFFSET {}", page_size, offset));
            let mut q = sqlx::query(&sql);
            if let Some((_, binds)) = &search {
                for b in binds {
                    q = q.bind(b.as_str());
                }
            }
            let prep_cols: Option<Vec<String>> = pool.prepare(&sql).await.ok().map(|s| {
                s.columns().iter().map(|c| c.name().to_string()).collect()
            });
            let rows = q.fetch_all(pool).await?;
            let columns: Vec<String> = if rows.is_empty() {
                prep_cols.unwrap_or_default()
            } else {
                rows.first()
                    .unwrap()
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect()
            };
            let decoded: Vec<Vec<Value>> = rows.iter().map(decode_pg_row).collect();
            let total = if req.want_total {
                count_pg(pool, &table, search.as_ref()).await.ok()
            } else {
                None
            };
            Ok(TableRowsResponse {
                columns,
                rows: decoded,
                total,
                page: req.page,
                page_size,
            })
        }
        Backend::Sqlite(pool) => {
            let table = qualify_sqlite(&req.table)?;
            // SQLite LIKE is case-insensitive for ASCII by default;
            // wrap in LOWER to keep Unicode matches consistent. Cast to
            // TEXT so blob / numeric columns also participate.
            let search = build_search_clause(
                req,
                escape_pg_ident,
                |c| format!("LOWER(CAST({c} AS TEXT)) LIKE LOWER(?) ESCAPE '\\'"),
            )?;
            let mut sql = format!("SELECT * FROM {table}");
            if let Some((clause, _)) = &search {
                sql.push_str(&format!(" WHERE {clause}"));
            }
            if let Some(col) = &req.order_by {
                let col = escape_pg_ident(col)?;
                sql.push_str(&format!(" ORDER BY {col} {}", req.order_dir.to_uppercase()));
            }
            sql.push_str(&format!(" LIMIT {} OFFSET {}", page_size, offset));
            let mut q = sqlx::query(&sql);
            if let Some((_, binds)) = &search {
                for b in binds {
                    q = q.bind(b.as_str());
                }
            }
            let prep_cols: Option<Vec<String>> = pool.prepare(&sql).await.ok().map(|s| {
                s.columns().iter().map(|c| c.name().to_string()).collect()
            });
            let rows = q.fetch_all(pool).await?;
            let columns: Vec<String> = if rows.is_empty() {
                prep_cols.unwrap_or_default()
            } else {
                rows.first()
                    .unwrap()
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect()
            };
            let decoded: Vec<Vec<Value>> = rows.iter().map(decode_sqlite_row).collect();
            let total = if req.want_total {
                count_sqlite(pool, &table, search.as_ref()).await.ok()
            } else {
                None
            };
            Ok(TableRowsResponse {
                columns,
                rows: decoded,
                total,
                page: req.page,
                page_size,
            })
        }
    }
}

// The three count helpers are identical apart from the pool type; the
// per-backend placeholder dialect is already baked into `clause` by
// build_search_clause, so a macro is safe.
macro_rules! impl_count {
    ($name:ident, $pool:ty) => {
        async fn $name(
            pool: &$pool,
            table: &str,
            search: Option<&(String, Vec<String>)>,
        ) -> AppResult<i64> {
            let mut sql = format!("SELECT COUNT(*) AS n FROM {table}");
            if let Some((clause, _)) = search {
                sql.push_str(&format!(" WHERE {clause}"));
            }
            let mut q = sqlx::query(&sql);
            if let Some((_, binds)) = search {
                for b in binds {
                    q = q.bind(b.as_str());
                }
            }
            let row = q.fetch_one(pool).await?;
            Ok(row.try_get::<i64, _>("n").unwrap_or(0))
        }
    };
}

impl_count!(count_mysql, sqlx::MySqlPool);
impl_count!(count_pg, sqlx::PgPool);
impl_count!(count_sqlite, sqlx::SqlitePool);

