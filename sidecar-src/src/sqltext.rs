//! Reading SQL as TEXT: splitting a script into statements, classifying each
//! one, and deciding whether it is safe on a read-only connection.
//!
//! Kept apart from `query.rs` because none of it touches a database — it is
//! pure string analysis, which is exactly why it is the part that can be unit
//! tested. `is_read_only_safe` is a SECURITY boundary (it is what stops a
//! read-only connection from writing), so the tests at the bottom are the
//! point of this module, not an afterthought.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StatementKind {
    Read,
    Write,
    Ddl,
    Unknown,
}

/// Naive statement splitter. Respects single / double / backtick quotes,
/// `--` line comments, and `/* ... */` block comments. Good enough for
/// "user-typed query editor" semantics; not a full SQL parser.
pub fn split_statements(sql: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = sql.chars().peekable();
    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    let mut in_line_comment = false;
    let mut in_block_comment = false;

    while let Some(ch) = chars.next() {
        if in_line_comment {
            cur.push(ch);
            if ch == '\n' {
                in_line_comment = false;
            }
            continue;
        }
        if in_block_comment {
            cur.push(ch);
            if ch == '*' && chars.peek() == Some(&'/') {
                cur.push(chars.next().unwrap());
                in_block_comment = false;
            }
            continue;
        }
        if in_single {
            cur.push(ch);
            if ch == '\\' {
                if let Some(&n) = chars.peek() {
                    cur.push(n);
                    chars.next();
                }
                continue;
            }
            if ch == '\'' {
                in_single = false;
            }
            continue;
        }
        if in_double {
            cur.push(ch);
            if ch == '\\' {
                if let Some(&n) = chars.peek() {
                    cur.push(n);
                    chars.next();
                }
                continue;
            }
            if ch == '"' {
                in_double = false;
            }
            continue;
        }
        if in_backtick {
            cur.push(ch);
            if ch == '`' {
                in_backtick = false;
            }
            continue;
        }
        match ch {
            '\'' => {
                in_single = true;
                cur.push(ch);
            }
            '"' => {
                in_double = true;
                cur.push(ch);
            }
            '`' => {
                in_backtick = true;
                cur.push(ch);
            }
            '-' if chars.peek() == Some(&'-') => {
                cur.push(ch);
                cur.push(chars.next().unwrap());
                in_line_comment = true;
            }
            '/' if chars.peek() == Some(&'*') => {
                cur.push(ch);
                cur.push(chars.next().unwrap());
                in_block_comment = true;
            }
            ';' => {
                let trimmed = cur.trim();
                if !trimmed.is_empty() {
                    out.push(trimmed.to_string());
                }
                cur.clear();
            }
            _ => cur.push(ch),
        }
    }
    let trimmed = cur.trim();
    if !trimmed.is_empty() {
        out.push(trimmed.to_string());
    }
    out
}

/// Classify a single statement based on its first significant keyword.
pub fn classify(sql: &str) -> StatementKind {
    let cleaned = strip_leading_comments(sql);
    let mut first = String::new();
    for ch in cleaned.chars() {
        if ch.is_alphabetic() {
            first.push(ch.to_ascii_uppercase());
        } else if first.is_empty() {
            continue;
        } else {
            break;
        }
    }
    match first.as_str() {
        "SELECT" | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "PRAGMA" | "VALUES" => {
            StatementKind::Read
        }
        "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "MERGE" | "UPSERT" | "CALL" => {
            StatementKind::Write
        }
        "CREATE" | "DROP" | "ALTER" | "TRUNCATE" | "RENAME" | "GRANT" | "REVOKE" | "COMMENT" | "VACUUM" | "REINDEX" | "ANALYZE" => StatementKind::Ddl,
        "BEGIN" | "START" | "COMMIT" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "SET" | "USE" => {
            // Transaction control + session SETs don't violate `allow_writes`.
            StatementKind::Read
        }
        _ => StatementKind::Unknown,
    }
}

fn strip_leading_comments(sql: &str) -> &str {
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b' ' | b'\t' | b'\r' | b'\n' => i += 1,
            b'-' if i + 1 < bytes.len() && bytes[i + 1] == b'-' => {
                // line comment until newline
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if i + 1 < bytes.len() && bytes[i + 1] == b'*' => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 2;
            }
            _ => break,
        }
    }
    std::str::from_utf8(&bytes[i.min(bytes.len())..]).unwrap_or("")
}

/// True if every statement in `sql` is safe to run on a read-only connection
/// (see `is_read_only_safe`). Used by the export path, which would otherwise
/// run caller-supplied SQL with no statement-kind gate. Empty input is
/// rejected so a blank export errors cleanly rather than silently.
pub fn all_statements_read_only(sql: &str) -> bool {
    let statements = split_statements(sql);
    !statements.is_empty()
        && statements
            .iter()
            .all(|stmt| is_read_only_safe(stmt, classify(stmt)))
}

/// Conservative write-gate for read-only connections.
///
/// `classify()` keys only on a statement's first keyword, so on its own it
/// would wave through writes disguised as reads: a data-modifying CTE
/// (`WITH x AS (DELETE ... RETURNING *) SELECT ...`), `EXPLAIN ANALYZE
/// <write>` (which executes the inner statement on PostgreSQL), and anything
/// that lands in `Unknown` (`COPY ... FROM`, `LOAD DATA`, `REFRESH
/// MATERIALIZED VIEW`, ...). A statement is therefore allowed on a read-only
/// connection only when it is a recognised read that is neither a writing CTE
/// nor an `EXPLAIN ANALYZE`. `StatementKind` is left untouched, so the
/// rows-vs-exec execution path is unchanged on writable connections.
///
/// Still a heuristic: a `SELECT` of a volatile / writing function can mutate.
/// For a hard guarantee, connect with a database-level read-only role.
pub fn is_read_only_safe(sql: &str, kind: StatementKind) -> bool {
    if kind != StatementKind::Read {
        return false;
    }
    let head = strip_quotes_and_comments(sql)
        .trim_start()
        .to_ascii_uppercase();
    if let Some(rest) = head.strip_prefix("WITH") {
        return !word_present(rest, &["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE"]);
    }
    if let Some(rest) = head.strip_prefix("EXPLAIN") {
        return !word_present(rest, &["ANALYZE", "ANALYSE"]);
    }
    true
}

/// Blank out `--` / `/* */` comments and single / double / backtick-quoted
/// spans so a keyword scan only ever sees bare SQL (a `DELETE` inside a
/// string literal or a `"delete"` identifier must not trip the gate).
fn strip_quotes_and_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '-' if chars.peek() == Some(&'-') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
                out.push(' ');
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '*' && chars.peek() == Some(&'/') {
                        chars.next();
                        break;
                    }
                }
                out.push(' ');
            }
            '\'' | '"' | '`' => {
                while let Some(c) = chars.next() {
                    if c == '\\' {
                        chars.next();
                        continue;
                    }
                    if c == ch {
                        break;
                    }
                }
                out.push(' ');
            }
            _ => out.push(ch),
        }
    }
    out
}

/// True if `haystack` contains any `needle` as a whole word (ASCII
/// alphanumeric / underscore boundaries). Both are assumed uppercased.
fn word_present(haystack: &str, needles: &[&str]) -> bool {
    let bytes = haystack.as_bytes();
    let is_word = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
    needles.iter().any(|needle| {
        haystack.match_indices(needle).any(|(start, _)| {
            let end = start + needle.len();
            (start == 0 || !is_word(bytes[start - 1]))
                && (end == bytes.len() || !is_word(bytes[end]))
        })
    })
}

#[cfg(test)]
mod tests {
    use super::{StatementKind, all_statements_read_only, classify, is_read_only_safe, split_statements};

    fn split(sql: &str) -> Vec<String> {
        split_statements(sql)
    }

    #[test]
    fn splits_on_semicolons_outside_quotes_and_comments() {
        assert_eq!(split("SELECT 1; SELECT 2"), vec!["SELECT 1", "SELECT 2"]);
        // A trailing separator does not produce an empty statement.
        assert_eq!(split("SELECT 1;  "), vec!["SELECT 1"]);
        assert!(split("   ").is_empty());
        // A semicolon inside a literal is data, not a separator. Getting this
        // wrong would run half a statement.
        assert_eq!(split("SELECT ';' AS a"), vec!["SELECT ';' AS a"]);
        assert_eq!(split(r#"SELECT ";" AS a"#), vec![r#"SELECT ";" AS a"#]);
        assert_eq!(split("SELECT `a;b` FROM t"), vec!["SELECT `a;b` FROM t"]);
        // Escaped quote inside a literal must not end it early.
        assert_eq!(split(r"SELECT 'it\'s; fine'"), vec![r"SELECT 'it\'s; fine'"]);
        // Comments swallow their semicolons.
        assert_eq!(split("SELECT 1 -- ; not a split\n; SELECT 2").len(), 2);
        assert_eq!(split("SELECT /* ; */ 1").len(), 1);
    }

    #[test]
    fn classifies_by_first_significant_keyword() {
        use StatementKind::*;
        for (sql, want) in [
            ("SELECT 1", Read),
            ("  \n select 1", Read),
            ("-- lead\nSELECT 1", Read),
            ("/* lead */ WITH x AS (SELECT 1) SELECT * FROM x", Read),
            ("SHOW TABLES", Read),
            ("EXPLAIN SELECT 1", Read),
            ("INSERT INTO t VALUES (1)", Write),
            ("update t set a = 1", Write),
            ("DELETE FROM t", Write),
            ("CREATE TABLE t (a int)", Ddl),
            ("DROP TABLE t", Ddl),
            // Transaction and session control must not read as writes, or a
            // read-only connection could not even BEGIN.
            ("BEGIN", Read),
            ("COMMIT", Read),
            ("SET search_path TO x", Read),
            ("USE app", Read),
            ("COPY t FROM STDIN", Unknown),
        ] {
            assert_eq!(classify(sql), want, "classify({sql:?})");
        }
    }

    /// The security boundary: what a read-only connection is allowed to run.
    #[test]
    fn read_only_gate_allows_reads_and_blocks_disguised_writes() {
        let allowed = |sql: &str| is_read_only_safe(sql, classify(sql));
        assert!(allowed("SELECT * FROM users"));
        assert!(allowed("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(allowed("EXPLAIN SELECT 1"));
        assert!(allowed("SHOW TABLES"));
        assert!(allowed("BEGIN"));

        assert!(!allowed("DELETE FROM users"));
        assert!(!allowed("UPDATE users SET a = 1"));
        assert!(!allowed("DROP TABLE users"));
        // A data-modifying CTE opens with SELECT-ish syntax but writes.
        assert!(!allowed("WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"));
        assert!(!allowed("WITH u AS (UPDATE t SET a=1 RETURNING *) SELECT * FROM u"));
        // EXPLAIN ANALYZE actually EXECUTES the inner statement on PostgreSQL.
        assert!(!allowed("EXPLAIN ANALYZE DELETE FROM t"));
        assert!(!allowed("EXPLAIN ANALYSE UPDATE t SET a=1"));
        // Anything unrecognised is refused rather than waved through.
        assert!(!allowed("COPY t FROM '/etc/passwd'"));
    }

    #[test]
    fn read_only_gate_is_not_fooled_by_keywords_inside_literals() {
        let allowed = |sql: &str| is_read_only_safe(sql, classify(sql));
        // A write keyword inside a string or an identifier is not a write.
        assert!(allowed("WITH x AS (SELECT 'DELETE' AS s) SELECT * FROM x"));
        assert!(allowed(r#"WITH x AS (SELECT "delete" FROM t) SELECT * FROM x"#));
        assert!(allowed("EXPLAIN SELECT 'ANALYZE'"));
        // ...and a word merely CONTAINING one is not either.
        assert!(allowed("WITH x AS (SELECT deleted_at FROM t) SELECT * FROM x"));
        assert!(allowed("EXPLAIN SELECT * FROM analyzed_rows"));
    }

    #[test]
    fn export_gate_needs_every_statement_to_be_a_read() {
        assert!(all_statements_read_only("SELECT 1; SELECT 2"));
        assert!(!all_statements_read_only("SELECT 1; DELETE FROM t"));
        // Empty input is refused rather than silently passing the gate.
        assert!(!all_statements_read_only("   "));
    }
}
