//! Cell-value decoding for arbitrary column types.
//!
//! Each backend gets its own decode function that walks the row column by
//! column and produces a `serde_json::Value` suitable for the result grid.
//! Non-scalar / binary types are wrapped in a `{ "__type": "...", ... }`
//! object so the frontend can render them as chips instead of trying to
//! coerce them to text.

use base64::Engine as _;
use serde_json::{Map, Value, json};
use sqlx::{Column, Row, TypeInfo, ValueRef};

/// Convert a slice of bytes into a sane string. Falls back to the lossy
/// representation only after the strict path fails so well-formed UTF-8 keeps
/// its original bytes.
fn bytes_to_string(b: &[u8]) -> String {
    match std::str::from_utf8(b) {
        Ok(s) => s.to_owned(),
        Err(_) => String::from_utf8_lossy(b).into_owned(),
    }
}

fn bytes_payload(b: &[u8]) -> Value {
    let mut map = Map::new();
    map.insert("__type".into(), Value::String("bytes".into()));
    map.insert(
        "b64".into(),
        Value::String(base64::engine::general_purpose::STANDARD.encode(b)),
    );
    map.insert("size".into(), Value::from(b.len()));
    Value::Object(map)
}

fn datetime_iso(s: impl AsRef<str>) -> Value {
    Value::String(s.as_ref().to_string())
}

/// Largest integer JavaScript can hold exactly (`Number.MAX_SAFE_INTEGER`).
const JS_SAFE_INT: i64 = 9_007_199_254_740_991;

/// Render a 64-bit integer for a JavaScript client.
///
/// The JSON we emit carries the exact digits, but the frontend's `JSON.parse`
/// rounds anything past 2^53 to the nearest double. On a `bigint` key that is
/// not cosmetic: two distinct rows rendered the SAME id, and an inline edit
/// then sent the rounded value as the WHERE key, matching no row while the UI
/// reported success. Values that survive the round trip stay numbers; the rest
/// become strings so at least the true value is what the user sees.
///
/// ponytail: display-only. Editing a key above 2^53 now fails loudly (the
/// string binds as text and the server rejects the comparison) instead of
/// silently updating nothing. Making it round-trip needs a typed marker like
/// the `bytes` one below, plus matching bind + render paths.
fn json_int(v: i64) -> Value {
    if v.abs() <= JS_SAFE_INT {
        Value::from(v)
    } else {
        Value::String(v.to_string())
    }
}

/// Decode a MySQL integer that fits in 64 bits. Signed first; fall back to
/// unsigned because sqlx tags `... UNSIGNED` columns with the UNSIGNED flag,
/// which makes `i64` incompatible — without the fallback every UNSIGNED
/// column (including `TINYINT UNSIGNED`, whose type name matches no signed
/// arm) silently decodes to NULL. The covered types all fit in `i64`, so the
/// JSON number stays exact. (`BIGINT UNSIGNED` keeps its dedicated string
/// path so values above 2^53 survive the JS client.)
fn mysql_uint_safe(row: &sqlx::mysql::MySqlRow, idx: usize) -> Value {
    if let Ok(v) = row.try_get::<i64, _>(idx) {
        return json_int(v);
    }
    if let Ok(v) = row.try_get::<u64, _>(idx) {
        return match i64::try_from(v) {
            Ok(n) => json_int(n),
            Err(_) => Value::String(v.to_string()),
        };
    }
    Value::Null
}

// ----------------------------- MySQL -----------------------------------------

pub fn decode_mysql_row(row: &sqlx::mysql::MySqlRow) -> Vec<Value> {
    let mut out = Vec::with_capacity(row.columns().len());
    for (i, col) in row.columns().iter().enumerate() {
        out.push(decode_mysql_cell(row, i, col));
    }
    out
}

fn decode_mysql_cell(row: &sqlx::mysql::MySqlRow, idx: usize, col: &sqlx::mysql::MySqlColumn) -> Value {
    use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};

    if let Ok(raw) = row.try_get_raw(idx) {
        if raw.is_null() {
            return Value::Null;
        }
    }

    let type_name = col.type_info().name().to_ascii_uppercase();
    match type_name.as_str() {
        "BOOL" | "BOOLEAN" => row
            .try_get::<bool, _>(idx)
            .map(Value::Bool)
            .unwrap_or(Value::Null),
        "TINYINT" => {
            // MySQL booleans are TINYINT(1); try i8 first, then bool.
            if let Ok(v) = row.try_get::<i8, _>(idx) {
                return Value::from(v as i64);
            }
            row.try_get::<bool, _>(idx)
                .map(Value::Bool)
                .unwrap_or(Value::Null)
        }
        "TINYINT UNSIGNED" | "SMALLINT" | "SMALLINT UNSIGNED" | "MEDIUMINT"
        | "MEDIUMINT UNSIGNED" | "INT" | "INT UNSIGNED" | "YEAR" => mysql_uint_safe(row, idx),
        "BIGINT" => row
            .try_get::<i64, _>(idx)
            .map(json_int)
            .unwrap_or(Value::Null),
        "BIGINT UNSIGNED" => {
            // u64 may exceed i64 range; serialize as string to preserve digits.
            row.try_get::<u64, _>(idx)
                .map(|v| Value::String(v.to_string()))
                .unwrap_or(Value::Null)
        }
        "FLOAT" | "DOUBLE" => row
            .try_get::<f64, _>(idx)
            .map(|v| {
                if v.is_finite() {
                    json!(v)
                } else {
                    Value::String(v.to_string())
                }
            })
            .unwrap_or(Value::Null),
        "DECIMAL" | "NUMERIC" => {
            // BigDecimal preserves precision; render as string.
            if let Ok(v) = row.try_get::<bigdecimal::BigDecimal, _>(idx) {
                return Value::String(v.to_string());
            }
            row.try_get::<String, _>(idx)
                .map(Value::String)
                .unwrap_or(Value::Null)
        }
        "DATE" => row
            .try_get::<NaiveDate, _>(idx)
            .map(|d| datetime_iso(d.to_string()))
            .unwrap_or(Value::Null),
        "TIME" => row
            .try_get::<NaiveTime, _>(idx)
            .map(|d| datetime_iso(d.to_string()))
            .unwrap_or(Value::Null),
        "DATETIME" => row
            .try_get::<NaiveDateTime, _>(idx)
            .map(|d| datetime_iso(d.format("%Y-%m-%dT%H:%M:%S%.f").to_string()))
            .unwrap_or(Value::Null),
        "TIMESTAMP" => row
            .try_get::<DateTime<Utc>, _>(idx)
            .map(|d| datetime_iso(d.to_rfc3339()))
            .unwrap_or(Value::Null),
        "JSON" => row
            .try_get::<Value, _>(idx)
            .unwrap_or(Value::Null),
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => {
            row.try_get::<Vec<u8>, _>(idx)
                .map(|b| bytes_payload(&b))
                .unwrap_or(Value::Null)
        }
        // Default text-y types
        _ => {
            if let Ok(s) = row.try_get::<String, _>(idx) {
                return Value::String(s);
            }
            if let Ok(b) = row.try_get::<Vec<u8>, _>(idx) {
                return Value::String(bytes_to_string(&b));
            }
            Value::Null
        }
    }
}

// --------------------------- PostgreSQL --------------------------------------

pub fn decode_pg_row(row: &sqlx::postgres::PgRow) -> Vec<Value> {
    let mut out = Vec::with_capacity(row.columns().len());
    for (i, col) in row.columns().iter().enumerate() {
        out.push(decode_pg_cell(row, i, col));
    }
    out
}

fn decode_pg_cell(row: &sqlx::postgres::PgRow, idx: usize, col: &sqlx::postgres::PgColumn) -> Value {
    use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};

    if let Ok(raw) = row.try_get_raw(idx) {
        if raw.is_null() {
            return Value::Null;
        }
    }

    let type_name = col.type_info().name();
    match type_name {
        "BOOL" => row
            .try_get::<bool, _>(idx)
            .map(Value::Bool)
            .unwrap_or(Value::Null),
        "INT2" | "INT4" => row
            .try_get::<i32, _>(idx)
            .map(|v| Value::from(v as i64))
            .unwrap_or(Value::Null),
        "INT8" => row
            .try_get::<i64, _>(idx)
            .map(json_int)
            .unwrap_or(Value::Null),
        "OID" => row
            .try_get::<i64, _>(idx)
            .map(json_int)
            .unwrap_or(Value::Null),
        "FLOAT4" => row
            .try_get::<f32, _>(idx)
            .map(|v| json!(v as f64))
            .unwrap_or(Value::Null),
        "FLOAT8" => row
            .try_get::<f64, _>(idx)
            .map(|v| {
                if v.is_finite() {
                    json!(v)
                } else {
                    Value::String(v.to_string())
                }
            })
            .unwrap_or(Value::Null),
        "NUMERIC" => {
            if let Ok(v) = row.try_get::<bigdecimal::BigDecimal, _>(idx) {
                return Value::String(v.to_string());
            }
            row.try_get::<String, _>(idx)
                .map(Value::String)
                .unwrap_or(Value::Null)
        }
        "DATE" => row
            .try_get::<NaiveDate, _>(idx)
            .map(|d| datetime_iso(d.to_string()))
            .unwrap_or(Value::Null),
        "TIME" => row
            .try_get::<NaiveTime, _>(idx)
            .map(|d| datetime_iso(d.to_string()))
            .unwrap_or(Value::Null),
        "TIMESTAMP" => row
            .try_get::<NaiveDateTime, _>(idx)
            .map(|d| datetime_iso(d.format("%Y-%m-%dT%H:%M:%S%.f").to_string()))
            .unwrap_or(Value::Null),
        "TIMESTAMPTZ" => row
            .try_get::<DateTime<Utc>, _>(idx)
            .map(|d| datetime_iso(d.to_rfc3339()))
            .unwrap_or(Value::Null),
        "JSON" | "JSONB" => row
            .try_get::<Value, _>(idx)
            .unwrap_or(Value::Null),
        "UUID" => row
            .try_get::<uuid::Uuid, _>(idx)
            .map(|u| Value::String(u.to_string()))
            .unwrap_or(Value::Null),
        "BYTEA" => row
            .try_get::<Vec<u8>, _>(idx)
            .map(|b| bytes_payload(&b))
            .unwrap_or(Value::Null),
        _ => decode_pg_fallback(row, idx, type_name),
    }
}

/// Everything `decode_pg_cell` has no named arm for.
///
/// This used to be "try String, try Vec<u8>, else NULL", which meant every
/// PostgreSQL ARRAY, user-defined ENUM, INTERVAL and network type rendered as
/// NULL in the grid — indistinguishable from a real NULL, and silent. Arrays
/// and enums in particular are ordinary things to have in a schema.
///
/// The ladder, cheapest first:
///   1. arrays of the scalar types people actually store;
///   2. text-shaped values whose Postgres type is not TEXT (enums, domains,
///      citext, xml). `try_get_unchecked` skips the type-compatibility check
///      and runs the String decoder on the raw bytes, which for these is the
///      UTF-8 label; invalid UTF-8 fails cleanly and falls through;
///   3. INTERVAL, rendered the way Postgres itself writes it;
///   4. raw bytes;
///   5. a marker naming the type, so the UI can say "there is a value here I
///      can't show" instead of lying with NULL.
fn decode_pg_fallback(row: &sqlx::postgres::PgRow, idx: usize, type_name: &str) -> Value {
    // Arrays: sqlx decodes `Vec<T>` for any T with a Postgres array type.
    // `Option<T>` elements, because a Postgres array may contain NULLs and a
    // `Vec<i32>` decode fails outright on `ARRAY[1,NULL,3]`.
    macro_rules! try_arrays {
        ($($t:ty => $conv:expr),* $(,)?) => {
            $(
                if let Ok(v) = row.try_get::<Vec<Option<$t>>, _>(idx) {
                    #[allow(clippy::redundant_closure_call)]
                    return Value::Array(
                        v.into_iter().map(|e| e.map_or(Value::Null, $conv)).collect(),
                    );
                }
            )*
        };
    }
    if type_name.ends_with("[]") {
        try_arrays!(
            String => Value::String,
            i64 => json_int,
            i32 => |v: i32| Value::from(v as i64),
            i16 => |v: i16| Value::from(v as i64),
            f64 => |v: f64| json!(v),
            bool => Value::Bool,
            uuid::Uuid => |v: uuid::Uuid| Value::String(v.to_string()),
            bigdecimal::BigDecimal => |v: bigdecimal::BigDecimal| Value::String(v.to_string()),
            Value => |v: Value| v,
        );
    }

    if let Ok(s) = row.try_get::<String, _>(idx) {
        return Value::String(s);
    }
    // Enums / domains / citext / xml: right shape, wrong declared type.
    // `looks_like_text` is the guard that makes this safe — see its comment.
    if type_name.ends_with("[]") {
        if let Ok(v) = row.try_get_unchecked::<Vec<String>, _>(idx) {
            if v.iter().all(|s| looks_like_text(s)) {
                return Value::Array(v.into_iter().map(Value::String).collect());
            }
        }
    } else if let Ok(s) = row.try_get_unchecked::<String, _>(idx) {
        if looks_like_text(&s) {
            return Value::String(s);
        }
    }
    if type_name == "INTERVAL" {
        if let Ok(iv) = row.try_get::<sqlx::postgres::types::PgInterval, _>(idx) {
            return Value::String(format_interval(&iv));
        }
    }
    if let Ok(b) = row.try_get::<Vec<u8>, _>(idx) {
        return Value::String(bytes_to_string(&b));
    }
    // Nothing worked. Say so rather than pretending the cell is empty.
    let mut map = Map::new();
    map.insert("__type".into(), Value::String("unsupported".into()));
    map.insert("pg_type".into(), Value::String(type_name.to_string()));
    Value::Object(map)
}

/// Guard for the `try_get_unchecked::<String>` escape hatch.
///
/// Unchecked decoding runs the String decoder over whatever bytes the column
/// holds, so it succeeds on any binary encoding that happens to be valid UTF-8
/// — `macaddr`, `tsvector`, `int4range` and an enum ARRAY all came back as
/// mojibake, which is worse than the NULL it replaced. Their binary forms carry
/// length prefixes and OIDs, i.e. control bytes; real text values (an enum
/// label, xml, citext) do not. Tabs and newlines stay allowed because a genuine
/// text column can contain them.
fn looks_like_text(s: &str) -> bool {
    !s.chars()
        .any(|c| c.is_control() && c != '\t' && c != '\n' && c != '\r')
}

/// `PgInterval` is months/days/microseconds; render it the way Postgres prints
/// one so the grid shows `1 mon 2 days 03:00:00` rather than a struct.
fn format_interval(iv: &sqlx::postgres::types::PgInterval) -> String {
    let mut parts = Vec::new();
    if iv.months != 0 {
        parts.push(format!("{} mon", iv.months));
    }
    if iv.days != 0 {
        parts.push(format!("{} days", iv.days));
    }
    let micros = iv.microseconds;
    if micros != 0 || parts.is_empty() {
        let neg = if micros < 0 { "-" } else { "" };
        let abs = micros.unsigned_abs();
        let (secs, frac) = (abs / 1_000_000, abs % 1_000_000);
        let time = format!("{neg}{:02}:{:02}:{:02}", secs / 3600, (secs / 60) % 60, secs % 60);
        parts.push(if frac == 0 {
            time
        } else {
            format!("{time}.{:06}", frac)
        });
    }
    parts.join(" ")
}

// ----------------------------- SQLite ----------------------------------------

pub fn decode_sqlite_row(row: &sqlx::sqlite::SqliteRow) -> Vec<Value> {
    let mut out = Vec::with_capacity(row.columns().len());
    for (i, col) in row.columns().iter().enumerate() {
        out.push(decode_sqlite_cell(row, i, col));
    }
    out
}

fn decode_sqlite_cell(row: &sqlx::sqlite::SqliteRow, idx: usize, col: &sqlx::sqlite::SqliteColumn) -> Value {
    // SQLite reports declared (declared) type via column.type_info().name(),
    // which is the column's storage class hint. Sqlx maps common forms to
    // INTEGER / REAL / TEXT / BLOB / NULL. We try each candidate in
    // affinity order.
    if let Ok(raw) = row.try_get_raw(idx) {
        if raw.is_null() {
            return Value::Null;
        }
    }
    let type_name = col.type_info().name().to_ascii_uppercase();
    if type_name.contains("INT") {
        if let Ok(v) = row.try_get::<i64, _>(idx) {
            return json_int(v);
        }
    }
    if type_name.contains("REAL") || type_name.contains("FLOA") || type_name.contains("DOUB") {
        if let Ok(v) = row.try_get::<f64, _>(idx) {
            return if v.is_finite() {
                json!(v)
            } else {
                Value::String(v.to_string())
            };
        }
    }
    if type_name.contains("BLOB") {
        if let Ok(b) = row.try_get::<Vec<u8>, _>(idx) {
            return bytes_payload(&b);
        }
    }
    // Fallback path: try text → integer → float → bytes.
    if let Ok(s) = row.try_get::<String, _>(idx) {
        return Value::String(s);
    }
    if let Ok(v) = row.try_get::<i64, _>(idx) {
        return json_int(v);
    }
    if let Ok(v) = row.try_get::<f64, _>(idx) {
        return if v.is_finite() {
            json!(v)
        } else {
            Value::String(v.to_string())
        };
    }
    if let Ok(b) = row.try_get::<Vec<u8>, _>(idx) {
        return bytes_payload(&b);
    }
    Value::Null
}
