//! `/table-rows`: the paged, sorted, filtered SELECT behind the browse grid.
//!
//! Split from `edit.rs` because reading a page and mutating a row are separate
//! jobs with separate risks: this one is about paging and the search predicate,
//! that one about addressing exactly one row by primary key.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Column, Executor as _, Row, Statement as _};

use crate::db::{Backend, BackendKind};
use crate::error::{AppError, AppResult};
use crate::schema::{
    escape_mysql_ident, escape_pg_ident, qualify_mysql, qualify_pg, qualify_sqlite,
};
use crate::value::{decode_mysql_row, decode_pg_row, decode_sqlite_row, Cells};

/// Above this many (estimated) rows an unfiltered table reports the catalog's
/// estimate instead of running `COUNT(*)`, which is a full scan on InnoDB and
/// on PostgreSQL. A filtered count is always exact: it is what the user asked.
const EXACT_COUNT_MAX: i64 = 1_000_000;

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
    /// Free-text, case-insensitive substring search. Runs against
    /// `search_column` when set, otherwise ORed across `search_columns` (sent
    /// by the client so the helper needs no introspection round-trip).
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub search_column: Option<String>,
    #[serde(default)]
    pub search_columns: Option<Vec<String>>,
    /// Fill `total`. The client asks when the table or filter changes and
    /// reuses the cached number while only the page moves.
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
    /// `total` is the catalog's estimate, not a count.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub total_estimated: bool,
    pub page: u64,
    pub page_size: u64,
}

/// Wrap the search term in LIKE wildcards, escaping LIKE's own metacharacters
/// (`%`, `_`, `\`) so "a_b" matches a literal underscore.
fn like_pattern(q: &str) -> String {
    let mut out = String::with_capacity(q.len() + 2);
    out.push('%');
    for ch in q.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('%');
    out
}

/// The engine-specific SQL pieces of one page read.
struct PageSql {
    select: String,
    count: String,
    /// One bound value per search placeholder.
    binds: Vec<String>,
}

fn build_page_sql(kind: BackendKind, req: &TableRowsRequest, page_size: u64) -> AppResult<PageSql> {
    if !matches!(req.order_dir.to_ascii_lowercase().as_str(), "asc" | "desc") {
        return Err(AppError::BadRequest("order_dir must be asc / desc".into()));
    }
    type Quoter = fn(&str) -> AppResult<String>;
    let (table, quote): (String, Quoter) = match kind {
        BackendKind::Mysql => (
            qualify_mysql(&req.database, &req.table)?,
            escape_mysql_ident,
        ),
        BackendKind::Postgres => (qualify_pg(&req.schema, &req.table)?, escape_pg_ident),
        BackendKind::Sqlite => (qualify_sqlite(&req.table)?, escape_pg_ident),
    };

    let term = req.search.as_deref().unwrap_or("").trim();
    let columns: Vec<&str> = match (req.search_column.as_deref(), &req.search_columns) {
        _ if term.is_empty() => Vec::new(),
        (Some(c), _) => vec![c.trim()],
        (None, Some(cs)) => cs.iter().map(|c| c.trim()).collect(),
        (None, None) => Vec::new(),
    };
    let mut predicates = Vec::new();
    for (i, col) in columns.iter().filter(|c| !c.is_empty()).enumerate() {
        let c = quote(col)?;
        // Cast so numeric / binary / json cells take part in a text search.
        predicates.push(match kind {
            // MySQL LIKE is case-insensitive on default collations.
            BackendKind::Mysql => format!("CAST({c} AS CHAR) LIKE ? ESCAPE '\\\\'"),
            BackendKind::Postgres => format!("CAST({c} AS TEXT) ILIKE ${}", i + 1),
            // LOWER on both sides keeps non-ASCII matches case-insensitive.
            BackendKind::Sqlite => format!("LOWER(CAST({c} AS TEXT)) LIKE LOWER(?) ESCAPE '\\'"),
        });
    }
    let filter = if predicates.is_empty() {
        String::new()
    } else {
        format!(" WHERE ({})", predicates.join(" OR "))
    };
    let mut select = format!("SELECT * FROM {table}{filter}");
    if let Some(col) = &req.order_by {
        select.push_str(&format!(
            " ORDER BY {} {}",
            quote(col)?,
            req.order_dir.to_uppercase()
        ));
    }
    select.push_str(&format!(
        " LIMIT {page_size} OFFSET {}",
        req.page.saturating_mul(page_size)
    ));
    Ok(PageSql {
        select,
        count: format!("SELECT COUNT(*) AS n FROM {table}{filter}"),
        binds: vec![like_pattern(term); predicates.len()],
    })
}

pub async fn list_rows(backend: &Backend, req: &TableRowsRequest) -> AppResult<TableRowsResponse> {
    let page_size = req.page_size.clamp(1, 5_000);
    let sql = build_page_sql(backend.kind(), req, page_size)?;
    let filtered = !sql.binds.is_empty();

    macro_rules! read_page {
        ($pool:expr, $decode:path) => {{
            let mut q = sqlx::query(&sql.select);
            for b in &sql.binds {
                q = q.bind(b.as_str());
            }
            let rows = q.fetch_all($pool).await?;
            // A 0-row page (empty table, filter that matches nothing) still
            // needs its column names, which only a prepare can supply.
            let columns: Vec<String> = match rows.first() {
                Some(r) => r.columns().iter().map(|c| c.name().to_string()).collect(),
                None => $pool
                    .prepare(&sql.select)
                    .await
                    .map(|s| s.columns().iter().map(|c| c.name().to_string()).collect())
                    .unwrap_or_default(),
            };
            let decoded: Vec<Vec<Value>> =
                rows.iter().map(|r| $decode(r, Cells::Display)).collect();
            (columns, decoded)
        }};
    }
    macro_rules! count {
        ($pool:expr) => {{
            let mut q = sqlx::query(&sql.count);
            for b in &sql.binds {
                q = q.bind(b.as_str());
            }
            q.fetch_one($pool)
                .await
                .ok()
                .and_then(|r| r.try_get::<i64, _>("n").ok())
        }};
    }

    let (columns, rows) = match backend {
        Backend::Mysql(p) => read_page!(p, decode_mysql_row),
        Backend::Postgres(p) => read_page!(p, decode_pg_row),
        Backend::Sqlite(p) => read_page!(p, decode_sqlite_row),
    };
    let mut total = None;
    let mut total_estimated = false;
    if req.want_total {
        if !filtered {
            if let Some(est) = estimate_rows(backend, req)
                .await
                .filter(|&n| n > EXACT_COUNT_MAX)
            {
                total = Some(est);
                total_estimated = true;
            }
        }
        if total.is_none() {
            total = match backend {
                Backend::Mysql(p) => count!(p),
                Backend::Postgres(p) => count!(p),
                Backend::Sqlite(p) => count!(p),
            };
        }
    }
    Ok(TableRowsResponse {
        columns,
        rows,
        total,
        total_estimated,
        page: req.page,
        page_size,
    })
}

/// The catalog's row estimate: free, maintained by ANALYZE / InnoDB stats.
/// `None` when the engine has none (SQLite, a view, a never-analyzed table).
async fn estimate_rows(backend: &Backend, req: &TableRowsRequest) -> Option<i64> {
    let n = match backend {
        Backend::Postgres(p) => sqlx::query(
            "SELECT c.reltuples::bigint AS n FROM pg_class c \
             JOIN pg_namespace ns ON ns.oid = c.relnamespace \
             WHERE ns.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'm')",
        )
        .bind(&req.schema)
        .bind(&req.table)
        .fetch_optional(p)
        .await
        .ok()??
        .try_get::<i64, _>("n")
        .ok()?,
        Backend::Mysql(p) => {
            let row = sqlx::query(
                "SELECT TABLE_ROWS AS n FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'",
            )
            .bind(&req.database)
            .bind(&req.table)
            .fetch_optional(p)
            .await
            .ok()??;
            row.try_get::<Option<u64>, _>("n")
                .ok()
                .flatten()
                .or_else(|| {
                    row.try_get::<Option<i64>, _>("n")
                        .ok()
                        .flatten()
                        .map(|v| v as u64)
                })
                .map(|v| v as i64)?
        }
        Backend::Sqlite(_) => return None,
    };
    // PostgreSQL reports -1 for a table that was never analyzed.
    (n >= 0).then_some(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(search: Option<&str>, cols: Option<Vec<&str>>) -> TableRowsRequest {
        TableRowsRequest {
            conn: "c".into(),
            database: "app".into(),
            schema: "public".into(),
            table: "users".into(),
            order_by: Some("id".into()),
            order_dir: "desc".into(),
            page: 2,
            page_size: 10,
            search: search.map(Into::into),
            search_column: None,
            search_columns: cols.map(|c| c.into_iter().map(Into::into).collect()),
            want_total: true,
        }
    }

    #[test]
    fn builds_one_page_per_engine() {
        let pg = build_page_sql(
            BackendKind::Postgres,
            &req(Some("a_b"), Some(vec!["name", "email"])),
            10,
        )
        .unwrap();
        assert_eq!(
            pg.select,
            r#"SELECT * FROM "public"."users" WHERE (CAST("name" AS TEXT) ILIKE $1 OR CAST("email" AS TEXT) ILIKE $2) ORDER BY "id" DESC LIMIT 10 OFFSET 20"#
        );
        assert_eq!(pg.binds, vec![r"%a\_b%", r"%a\_b%"]);
        let my = build_page_sql(BackendKind::Mysql, &req(None, Some(vec!["name"])), 10).unwrap();
        assert_eq!(
            my.select,
            "SELECT * FROM `app`.`users` ORDER BY `id` DESC LIMIT 10 OFFSET 20"
        );
        assert_eq!(my.count, "SELECT COUNT(*) AS n FROM `app`.`users`");
        assert!(my.binds.is_empty());
        let mut bad = req(None, None);
        bad.order_dir = "asc; DROP TABLE x".into();
        assert!(build_page_sql(BackendKind::Mysql, &bad, 10).is_err());
    }
}
