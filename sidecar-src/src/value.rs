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
        "SMALLINT" | "SMALLINT UNSIGNED" | "MEDIUMINT" | "MEDIUMINT UNSIGNED" | "INT" | "INT UNSIGNED" | "YEAR" => {
            row.try_get::<i64, _>(idx)
                .map(Value::from)
                .unwrap_or(Value::Null)
        }
        "BIGINT" => row
            .try_get::<i64, _>(idx)
            .map(Value::from)
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
            .map(Value::from)
            .unwrap_or(Value::Null),
        "OID" => row
            .try_get::<i64, _>(idx)
            .map(Value::from)
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
            return Value::from(v);
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
        return Value::from(v);
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
