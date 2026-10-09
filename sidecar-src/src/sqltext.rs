//! Reading SQL as TEXT: splitting a script into statements, classifying each
//! one, tracking transaction control, and deciding whether a statement is safe
//! on a read-only connection.
//!
//! Kept apart from `query.rs` because none of it touches a database: it is
//! pure string analysis, which is exactly why it is the part that can be unit
//! tested. `is_read_only_safe` is a SECURITY boundary (it is what stops a
//! read-only connection from writing), so the tests at the bottom are the
//! point of this module, not an afterthought.
//!
//! Everything goes through one dialect-aware lexer, `code_mask`. Quoting rules
//! really differ per engine: PostgreSQL treats a backslash inside `'...'` as an
//! ordinary character and has `$tag$...$tag$` strings; MySQL escapes with a
//! backslash and has `#` comments. A lexer that guessed wrong split function
//! bodies in half and, worse, let the read-only gate read a real `DELETE` as
//! part of a string literal.

use crate::db::BackendKind;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum StatementKind {
    Read,
    Write,
    Ddl,
    Unknown,
}

/// How a statement moves the session's transaction state, as far as the text
/// can tell.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TxnEffect {
    Begin,
    End,
}

/// One flag per byte of `sql`: true when the byte is bare SQL, false when it
/// sits inside a string literal, a quoted identifier, or a comment.
pub fn code_mask(sql: &str, kind: BackendKind) -> Vec<bool> {
    let b = sql.as_bytes();
    let n = b.len();
    let mut mask = vec![true; n];
    let is_pg = kind == BackendKind::Postgres;
    let is_mysql = kind == BackendKind::Mysql;
    let mut i = 0;
    while i < n {
        let start = i;
        let next = b.get(i + 1).copied();
        i = match b[i] {
            // MySQL only treats `--` as a comment when whitespace follows it.
            b'-' if next == Some(b'-')
                && (!is_mysql || b.get(i + 2).is_none_or(|c| c.is_ascii_whitespace())) =>
            {
                line_end(b, i)
            }
            b'#' if is_mysql => line_end(b, i),
            b'/' if next == Some(b'*') => block_comment_end(b, i, is_pg),
            b'\'' => {
                // PostgreSQL only honours backslash escapes in E'...' strings.
                let e_string =
                    i > 0 && matches!(b[i - 1], b'E' | b'e') && (i < 2 || !is_ident_byte(b[i - 2]));
                quoted_end(b, i, is_mysql || (is_pg && e_string))
            }
            b'"' => quoted_end(b, i, is_mysql),
            b'`' if !is_pg => quoted_end(b, i, false),
            b'[' if kind == BackendKind::Sqlite => b[i..]
                .iter()
                .position(|&c| c == b']')
                .map_or(n, |p| i + p + 1),
            b'$' if is_pg => match dollar_tag(b, i) {
                Some(tag) => find(b, i + tag.len(), tag).map_or(n, |p| p + tag.len()),
                None => i + 1,
            },
            _ => {
                i += 1;
                continue;
            }
        };
        mask[start..i].fill(false);
    }
    mask
}

fn is_ident_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$'
}

/// Index of the newline ending a line comment (the newline itself stays code).
fn line_end(b: &[u8], i: usize) -> usize {
    b[i..]
        .iter()
        .position(|&c| c == b'\n')
        .map_or(b.len(), |p| i + p)
}

/// PostgreSQL block comments nest; MySQL and SQLite ones do not.
fn block_comment_end(b: &[u8], mut i: usize, nests: bool) -> usize {
    let mut depth = 0usize;
    while i + 1 < b.len() {
        if b[i] == b'/' && b[i + 1] == b'*' && (depth == 0 || nests) {
            depth += 1;
            i += 2;
        } else if b[i] == b'*' && b[i + 1] == b'/' {
            depth -= 1;
            i += 2;
            if depth == 0 {
                return i;
            }
        } else {
            i += 1;
        }
    }
    b.len()
}

/// End (exclusive) of the quoted run opening at `i`. A doubled quote is an
/// escaped quote in every dialect; a backslash escapes only where `backslash`.
fn quoted_end(b: &[u8], i: usize, backslash: bool) -> usize {
    let q = b[i];
    let mut j = i + 1;
    while j < b.len() {
        if backslash && b[j] == b'\\' {
            j += 2;
        } else if b[j] == q {
            if b.get(j + 1) == Some(&q) {
                j += 2;
            } else {
                return j + 1;
            }
        } else {
            j += 1;
        }
    }
    b.len()
}

/// The `$tag$` opening a PostgreSQL dollar-quoted string at `i`, if it is one.
/// `$1` (a parameter) and `a$b` (an identifier) are not.
fn dollar_tag(b: &[u8], i: usize) -> Option<&[u8]> {
    if i > 0 && is_ident_byte(b[i - 1]) {
        return None;
    }
    let mut j = i + 1;
    while j < b.len()
        && (b[j].is_ascii_alphabetic() || b[j] == b'_' || (j > i + 1 && b[j].is_ascii_digit()))
    {
        j += 1;
    }
    (b.get(j) == Some(&b'$')).then(|| &b[i..=j])
}

fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| from + p)
}

/// Split a script on `;` outside literals and comments. Statements keep their
/// original text (comments included), trimmed.
pub fn split_statements(sql: &str, kind: BackendKind) -> Vec<String> {
    let mask = code_mask(sql, kind);
    let mut out = Vec::new();
    let mut start = 0;
    for (i, &c) in sql.as_bytes().iter().enumerate() {
        if c == b';' && mask[i] {
            push_trimmed(&mut out, &sql[start..i]);
            start = i + 1;
        }
    }
    push_trimmed(&mut out, &sql[start..]);
    out
}

fn push_trimmed(out: &mut Vec<String>, s: &str) {
    let t = s.trim();
    if !t.is_empty() {
        out.push(t.to_string());
    }
}

/// `sql` with every literal, quoted identifier and comment blanked to spaces,
/// so a keyword scan only ever sees bare SQL.
fn bare_sql(sql: &str, kind: BackendKind) -> String {
    let mask = code_mask(sql, kind);
    sql.char_indices()
        .map(|(i, c)| if mask[i] { c } else { ' ' })
        .collect()
}

/// The first `n` bare keywords of a statement, uppercased.
fn leading_words(sql: &str, kind: BackendKind, n: usize) -> Vec<String> {
    bare_sql(sql, kind)
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .take(n)
        .map(|w| w.to_ascii_uppercase())
        .collect()
}

/// Classify a single statement by its first keyword.
pub fn classify(sql: &str, kind: BackendKind) -> StatementKind {
    let words = leading_words(sql, kind, 1);
    match words.first().map(String::as_str).unwrap_or("") {
        "SELECT" | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "PRAGMA" | "VALUES"
        | "TABLE" => StatementKind::Read,
        "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "MERGE" | "UPSERT" | "CALL" => {
            StatementKind::Write
        }
        "CREATE" | "DROP" | "ALTER" | "TRUNCATE" | "RENAME" | "GRANT" | "REVOKE" | "COMMENT"
        | "VACUUM" | "REINDEX" | "ANALYZE" => StatementKind::Ddl,
        // Transaction control + session SETs don't violate `allow_writes`.
        "BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "SAVEPOINT" | "RELEASE" | "SET"
        | "USE" => StatementKind::Read,
        _ => StatementKind::Unknown,
    }
}

/// Whether a statement produces a result set (run as a fetch) rather than only
/// a row count. Unrecognised statements are fetched so nothing is hidden.
pub fn returns_rows(sql: &str, kind: BackendKind) -> bool {
    let words = leading_words(sql, kind, 1);
    match words.first().map(String::as_str).unwrap_or("") {
        "SELECT" | "WITH" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" | "PRAGMA" | "VALUES"
        | "TABLE" => true,
        _ => classify(sql, kind) == StatementKind::Unknown,
    }
}

/// How a statement that SUCCEEDED moves the transaction state. Heuristic by
/// design (the server's own in-transaction flag is private to sqlx): it knows
/// explicit BEGIN / COMMIT / ROLLBACK, MySQL's `autocommit` switch, and that
/// MySQL DDL commits implicitly.
pub fn txn_effect(sql: &str, kind: BackendKind) -> Option<TxnEffect> {
    let words = leading_words(sql, kind, 4);
    let w = |i: usize| words.get(i).map(String::as_str).unwrap_or("");
    match w(0) {
        "BEGIN" => Some(TxnEffect::Begin),
        "START" if w(1) == "TRANSACTION" => Some(TxnEffect::Begin),
        "COMMIT" | "END" => Some(TxnEffect::End),
        // `ROLLBACK TO [SAVEPOINT] x` stays inside the transaction.
        "ROLLBACK" if w(1) != "TO" => Some(TxnEffect::End),
        "SET" if kind == BackendKind::Mysql && (w(1) == "AUTOCOMMIT" || w(2) == "AUTOCOMMIT") => {
            match bare_sql(sql, kind)
                .rsplit('=')
                .next()
                .map(|v| v.trim().to_ascii_uppercase())
            {
                Some(v) if v == "0" || v == "OFF" => Some(TxnEffect::Begin),
                Some(v) if v == "1" || v == "ON" => Some(TxnEffect::End),
                _ => None,
            }
        }
        _ if kind == BackendKind::Mysql && classify(sql, kind) == StatementKind::Ddl => {
            Some(TxnEffect::End)
        }
        _ => None,
    }
}

/// True when the statement changes session state this helper also sets
/// (`USE`, `SET search_path`), so a cached "context already applied" is stale.
pub fn changes_session_context(sql: &str, kind: BackendKind) -> bool {
    matches!(
        leading_words(sql, kind, 1).first().map(String::as_str),
        Some("USE" | "SET")
    )
}

/// True if every statement in `sql` is safe to run on a read-only connection
/// (see `is_read_only_safe`). Used by the export path, which would otherwise
/// run caller-supplied SQL with no statement-kind gate. Empty input is
/// rejected so a blank export errors cleanly rather than silently.
pub fn all_statements_read_only(sql: &str, kind: BackendKind) -> bool {
    let statements = split_statements(sql, kind);
    !statements.is_empty() && statements.iter().all(|stmt| is_read_only_safe(stmt, kind))
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
/// nor an `EXPLAIN ANALYZE`.
///
/// Still a heuristic: a `SELECT` of a volatile / writing function can mutate.
/// For a hard guarantee, connect with a database-level read-only role.
pub fn is_read_only_safe(sql: &str, kind: BackendKind) -> bool {
    if classify(sql, kind) != StatementKind::Read {
        return false;
    }
    let head = bare_sql(sql, kind).trim_start().to_ascii_uppercase();
    if let Some(rest) = head.strip_prefix("WITH") {
        return !word_present(rest, &["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE"]);
    }
    if let Some(rest) = head.strip_prefix("EXPLAIN") {
        return !word_present(rest, &["ANALYZE", "ANALYSE"]);
    }
    true
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
    use super::*;
    use BackendKind::{Mysql, Postgres, Sqlite};

    #[test]
    fn splits_on_semicolons_outside_quotes_and_comments() {
        for kind in [Mysql, Postgres, Sqlite] {
            let split = |sql: &str| split_statements(sql, kind);
            assert_eq!(split("SELECT 1; SELECT 2"), vec!["SELECT 1", "SELECT 2"]);
            // A trailing separator does not produce an empty statement.
            assert_eq!(split("SELECT 1;  "), vec!["SELECT 1"]);
            assert!(split("   ").is_empty());
            // A semicolon inside a literal is data, not a separator. Getting
            // this wrong would run half a statement.
            assert_eq!(split("SELECT ';' AS a"), vec!["SELECT ';' AS a"]);
            assert_eq!(split(r#"SELECT ";" AS a"#), vec![r#"SELECT ";" AS a"#]);
            assert_eq!(split("SELECT 'it''s; fine'").len(), 1);
            // Comments swallow their semicolons.
            assert_eq!(split("SELECT 1 -- ; not a split\n; SELECT 2").len(), 2);
            assert_eq!(split("SELECT /* ; */ 1").len(), 1);
        }
        assert_eq!(split_statements("SELECT `a;b` FROM t", Mysql).len(), 1);
        // MySQL escapes quotes with a backslash.
        assert_eq!(split_statements(r"SELECT 'it\'s; fine'", Mysql).len(), 1);
    }

    #[test]
    fn postgres_dollar_quotes_and_standard_strings() {
        // A function body is one statement, whatever it contains.
        let body = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql";
        assert_eq!(
            split_statements(&format!("{body}; SELECT 1"), Postgres).len(),
            2
        );
        let tagged = "DO $fn$ BEGIN PERFORM 1; $x$ inner; $x$ END $fn$";
        assert_eq!(split_statements(tagged, Postgres), vec![tagged]);
        // `$1` is a parameter, not a dollar quote.
        assert_eq!(split_statements("SELECT $1; SELECT 2", Postgres).len(), 2);
        // A backslash is an ordinary character in a PostgreSQL string...
        assert_eq!(
            split_statements(r"SELECT 'C:\'; SELECT 2", Postgres).len(),
            2
        );
        // ...except in an E'' string.
        assert_eq!(
            split_statements(r"SELECT E'a\'; b'; SELECT 2", Postgres).len(),
            2
        );
        // Block comments nest.
        assert_eq!(
            split_statements("SELECT /* a /* ; */ ; */ 1; SELECT 2", Postgres).len(),
            2
        );
    }

    #[test]
    fn mysql_hash_comments() {
        assert_eq!(
            split_statements("SELECT 1 # it's here;\n; SELECT 2", Mysql).len(),
            2
        );
        // `--` without whitespace after it is arithmetic in MySQL.
        assert_eq!(split_statements("SELECT 5--3; SELECT 2", Mysql).len(), 2);
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
            assert_eq!(classify(sql, Postgres), want, "classify({sql:?})");
        }
        // Transaction control is "read" for the gate but returns no rows, so
        // it runs as an exec (MySQL refuses START TRANSACTION when prepared).
        assert!(!returns_rows("START TRANSACTION", Mysql));
        assert!(!returns_rows("SET autocommit = 0", Mysql));
        assert!(returns_rows("SHOW TABLES", Mysql));
        assert!(returns_rows("COPY t TO STDOUT", Postgres));
        assert_eq!(classify("# note\nSELECT 1", Mysql), Read);
    }

    #[test]
    fn tracks_transaction_control() {
        use TxnEffect::*;
        for (kind, sql, want) in [
            (Postgres, "BEGIN", Some(Begin)),
            (Mysql, "start transaction read only", Some(Begin)),
            (Postgres, "COMMIT", Some(End)),
            (Postgres, "END", Some(End)),
            (Postgres, "ROLLBACK", Some(End)),
            (Postgres, "ROLLBACK TO SAVEPOINT a", None),
            (Postgres, "SAVEPOINT a", None),
            (Mysql, "SET autocommit = 0", Some(Begin)),
            (Mysql, "SET SESSION autocommit=ON", Some(End)),
            // MySQL DDL commits implicitly; PostgreSQL DDL is transactional.
            (Mysql, "CREATE TABLE t (a int)", Some(End)),
            (Postgres, "CREATE TABLE t (a int)", None),
            (Postgres, "SELECT 'BEGIN'", None),
        ] {
            assert_eq!(txn_effect(sql, kind), want, "txn_effect({sql:?})");
        }
    }

    /// The security boundary: what a read-only connection is allowed to run.
    #[test]
    fn read_only_gate_allows_reads_and_blocks_disguised_writes() {
        for kind in [Mysql, Postgres, Sqlite] {
            let allowed = |sql: &str| is_read_only_safe(sql, kind);
            assert!(allowed("SELECT * FROM users"));
            assert!(allowed("WITH x AS (SELECT 1) SELECT * FROM x"));
            assert!(allowed("EXPLAIN SELECT 1"));
            assert!(allowed("SHOW TABLES"));
            assert!(allowed("BEGIN"));

            assert!(!allowed("DELETE FROM users"));
            assert!(!allowed("UPDATE users SET a = 1"));
            assert!(!allowed("DROP TABLE users"));
            // A data-modifying CTE opens with SELECT-ish syntax but writes.
            assert!(!allowed(
                "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d"
            ));
            assert!(!allowed(
                "WITH u AS (UPDATE t SET a=1 RETURNING *) SELECT * FROM u"
            ));
            // EXPLAIN ANALYZE actually EXECUTES the inner statement on PostgreSQL.
            assert!(!allowed("EXPLAIN ANALYZE DELETE FROM t"));
            assert!(!allowed("EXPLAIN ANALYSE UPDATE t SET a=1"));
            // Anything unrecognised is refused rather than waved through.
            assert!(!allowed("COPY t FROM '/etc/passwd'"));
        }
    }

    #[test]
    fn read_only_gate_is_not_fooled_by_keywords_inside_literals() {
        let allowed = |sql: &str| is_read_only_safe(sql, Postgres);
        // A write keyword inside a string or an identifier is not a write.
        assert!(allowed("WITH x AS (SELECT 'DELETE' AS s) SELECT * FROM x"));
        assert!(allowed(
            r#"WITH x AS (SELECT "delete" FROM t) SELECT * FROM x"#
        ));
        assert!(allowed("EXPLAIN SELECT 'ANALYZE'"));
        assert!(allowed("WITH x AS (SELECT $$DELETE$$) SELECT * FROM x"));
        // ...and a word merely CONTAINING one is not either.
        assert!(allowed(
            "WITH x AS (SELECT deleted_at FROM t) SELECT * FROM x"
        ));
        assert!(allowed("EXPLAIN SELECT * FROM analyzed_rows"));
    }

    /// Quoting a lexer gets wrong for the engine must not hide a real write.
    #[test]
    fn read_only_gate_uses_the_engines_own_quoting() {
        // On PostgreSQL `'x\'` is a complete literal, so this DELETE is real.
        let backslash = r"WITH a AS (SELECT 'x\'), d AS (DELETE FROM t RETURNING 1) SELECT 'y'";
        assert!(!is_read_only_safe(backslash, Postgres));
        let dollar = "WITH a AS (SELECT $$'$$), d AS (DELETE FROM t RETURNING 1) SELECT $$'$$";
        assert!(!is_read_only_safe(dollar, Postgres));
    }

    #[test]
    fn export_gate_needs_every_statement_to_be_a_read() {
        assert!(all_statements_read_only("SELECT 1; SELECT 2", Postgres));
        assert!(!all_statements_read_only(
            "SELECT 1; DELETE FROM t",
            Postgres
        ));
        // Empty input is refused rather than silently passing the gate.
        assert!(!all_statements_read_only("   ", Postgres));
    }
}
