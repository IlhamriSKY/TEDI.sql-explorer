//! Turning a `serde_json::Value` from the grid into a bound parameter.
//!
//! One `bind_<backend>` per engine, plus the extra PostgreSQL needs: it is the
//! only one of the three that type-checks parameters, so composites and NULLs
//! there have to be told what type they are. Values are always BOUND, never
//! inlined — the SQL a mutation runs carries identifiers and placeholders only.

use base64::Engine as _;
use serde_json::{Map, Value};
use sqlx::Row;
use std::collections::HashMap;

fn decode_bytes_marker(v: &Value) -> Option<Vec<u8>> {
    let obj = v.as_object()?;
    let kind = obj.get("__type").and_then(|t| t.as_str())?;
    if kind != "bytes" {
        return None;
    }
    let b64 = obj.get("b64").and_then(|t| t.as_str())?;
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

macro_rules! impl_bind {
    ($name:ident, $db:ty, $non_scalar:path) => {
        pub fn $name<'q>(
            mut q: sqlx::query::Query<'q, $db, <$db as sqlx::Database>::Arguments<'q>>,
            value: &'q Value,
        ) -> sqlx::query::Query<'q, $db, <$db as sqlx::Database>::Arguments<'q>> {
            match value {
                Value::Null => {
                    q = q.bind(None::<String>);
                }
                Value::Bool(b) => {
                    q = q.bind(*b);
                }
                Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        q = q.bind(i);
                    } else if let Some(f) = n.as_f64() {
                        q = q.bind(f);
                    } else {
                        q = q.bind(n.to_string());
                    }
                }
                Value::String(s) => {
                    q = q.bind(s.as_str());
                }
                // Object / Array — the `bytes` marker plus whatever the engine
                // can make of a composite value.
                other => q = $non_scalar(q, other),
            }
            q
        }
    };
}

/// MySQL / SQLite: bind a composite as its JSON text. Both coerce a string
/// into a JSON column, and neither has an array type to get wrong.
macro_rules! impl_json_text_fallback {
    ($name:ident, $db:ty) => {
        fn $name<'q>(
            q: sqlx::query::Query<'q, $db, <$db as sqlx::Database>::Arguments<'q>>,
            value: &'q Value,
        ) -> sqlx::query::Query<'q, $db, <$db as sqlx::Database>::Arguments<'q>> {
            match decode_bytes_marker(value) {
                Some(bytes) => q.bind(bytes),
                None => q.bind(value.to_string()),
            }
        }
    };
}

impl_json_text_fallback!(bind_mysql_other, sqlx::MySql);
impl_json_text_fallback!(bind_sqlite_other, sqlx::Sqlite);

impl_json_text_fallback!(bind_pg_other, sqlx::Postgres);

impl_bind!(bind_mysql, sqlx::MySql, bind_mysql_other);
impl_bind!(bind_pg, sqlx::Postgres, bind_pg_other);
impl_bind!(bind_sqlite, sqlx::Sqlite, bind_sqlite_other);

// ------------------------- PostgreSQL composite values ------------------------
//
// PostgreSQL will not take a composite as a text parameter: an ARRAY column
// answers "column is of type text[] but expression is of type text", and so
// does `jsonb`. That made every array and JSON column impossible to insert or
// edit — which only became reachable at all once arrays started decoding as
// arrays instead of NULL.
//
// Guessing the element type from the JSON shape does not scale: it cannot tell
// `int[]` from `bigint[]`, and says nothing about `numeric[]`, `date[]`,
// `uuid[]`, an enum array or a nested one. So ask the database instead. We look
// the column's declared type up once and cast the placeholder to it
// (`$1::text[]`), binding the value's Postgres text form; the cast runs that
// type's own input function, which is exactly how a `'{1,2}'::numeric[]`
// literal works. Values stay bound parameters — no user data is ever inlined
// into the statement.

/// True for a value PostgreSQL will refuse as a plain text parameter.
///
/// `Null` is in here for the same reason the composites are, and it is the
/// wider bug: sqlx types a bound `None` as TEXT, so clearing ANY non-text cell
/// ("column is of type integer but expression is of type text") failed —
/// integers, dates, timestamps, booleans, uuids, jsonb and arrays alike.
/// Casting the placeholder to the column's type makes `NULL::text::<type>`
/// resolve to a plain NULL of the right type.
pub fn pg_needs_cast(v: &Value) -> bool {
    match v {
        Value::Null | Value::Array(_) => true,
        Value::Object(_) => decode_bytes_marker(v).is_none(),
        _ => false,
    }
}

/// Render a JSON value in the text form Postgres' input functions expect: the
/// `{a,b}` array literal for arrays, plain JSON for anything else.
pub fn pg_text_form(v: &Value) -> String {
    match v {
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(pg_array_element).collect();
            format!("{{{}}}", parts.join(","))
        }
        other => other.to_string(),
    }
}

/// One element of a Postgres array literal. Unquoted `NULL` is the null
/// element; everything else is double-quoted with `\` and `"` escaped, which
/// is always valid and saves deciding when quoting is optional.
pub fn pg_array_element(v: &Value) -> String {
    match v {
        Value::Null => "NULL".to_string(),
        // A nested array keeps the brace form rather than being quoted, so
        // multi-dimensional arrays survive.
        Value::Array(_) => pg_text_form(v),
        Value::String(s) => format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"")),
        other => format!("\"{}\"", other.to_string().replace('\\', "\\\\").replace('"', "\\\"")),
    }
}

/// Guard for inlining a type name into the cast. `format_type()` output is the
/// server's own rendering and already re-parses, but it is still a string
/// crossing into SQL, so hold it to characters a type name can legitimately
/// use. Anything else falls back to the uncast bind.
pub fn pg_type_is_safe(t: &str) -> bool {
    !t.is_empty()
        && t.len() <= 128
        && t.chars()
            .all(|c| c.is_alphanumeric() || " _().,[]\"".contains(c))
}

/// Declared types for the columns of `values` that need a cast. Empty when
/// none do, so an ordinary scalar edit costs no extra round-trip.
pub async fn pg_cast_types(
    pool: &sqlx::PgPool,
    schema: &str,
    table: &str,
    values: &Map<String, Value>,
) -> HashMap<String, String> {
    if !values.values().any(pg_needs_cast) {
        return HashMap::new();
    }
    let rows = sqlx::query(
        "SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS full_type \
         FROM pg_attribute a \
         JOIN pg_class c ON c.oid = a.attrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped",
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    rows.into_iter()
        .filter_map(|r| {
            let name: String = r.try_get("name").ok()?;
            let ty: String = r.try_get("full_type").ok()?;
            let needs = values.get(&name).map(pg_needs_cast).unwrap_or(false);
            (needs && pg_type_is_safe(&ty)).then_some((name, ty))
        })
        .collect()
}

/// The `$N` placeholder for one column, cast to its declared type when the
/// value is a composite.
pub fn pg_placeholder(casts: &HashMap<String, String>, col: &str, idx: usize) -> String {
    match casts.get(col) {
        Some(ty) => format!("${idx}::{ty}"),
        None => format!("${idx}"),
    }
}

/// Bind one value, using its Postgres text form when the placeholder carries a
/// cast (the cast's input function parses it).
pub fn bind_pg_value<'q>(
    q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    casts: &HashMap<String, String>,
    col: &str,
    value: &'q Value,
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    match (casts.contains_key(col), value) {
        // A NULL has no text form to parse; bind a real one and let the
        // placeholder's cast give it the column's type.
        (true, Value::Null) => q.bind(None::<String>),
        (true, v) => q.bind(pg_text_form(v)),
        (false, v) => bind_pg(q, v),
    }
}

#[cfg(test)]
mod tests {
    use super::{pg_array_element, pg_text_form, pg_type_is_safe};
    use serde_json::json;

    #[test]
    fn renders_postgres_array_literals() {
        assert_eq!(pg_text_form(&json!(["a", "b"])), r#"{"a","b"}"#);
        assert_eq!(pg_text_form(&json!([1, 2])), r#"{"1","2"}"#);
        // A NULL element is the bare word, not a quoted string.
        assert_eq!(pg_text_form(&json!(["a", null])), r#"{"a",NULL}"#);
        assert_eq!(pg_text_form(&json!([])), "{}");
        // Nested arrays keep their braces so a 2-D array survives.
        assert_eq!(pg_text_form(&json!([[1, 2], [3]])), r#"{{"1","2"},{"3"}}"#);
        // The two characters that terminate an element must be escaped.
        assert_eq!(pg_array_element(&json!(r#"a"b\c"#)), r#""a\"b\\c""#);
        // Commas and braces inside a value are safe because we always quote.
        assert_eq!(pg_text_form(&json!(["a,b", "{c}"])), r#"{"a,b","{c}"}"#);
        // An object is handed over as JSON for a json / jsonb cast.
        assert_eq!(pg_text_form(&json!({"a": 1})), r#"{"a":1}"#);
    }

    #[test]
    fn rejects_a_type_name_that_is_not_one() {
        assert!(pg_type_is_safe("text[]"));
        assert!(pg_type_is_safe("character varying(20)[]"));
        assert!(pg_type_is_safe("\"My Enum\"[]"));
        assert!(!pg_type_is_safe("text; DROP TABLE t"));
        assert!(!pg_type_is_safe(""));
    }
}

