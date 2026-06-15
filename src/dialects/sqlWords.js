// SQL Explorer — shared SQL vocabulary for the editor autocomplete.
// Engine-neutral keywords / functions / types live here; the engine-specific
// additions live on each dialect descriptor (see ./mysql.js etc.). Bundled
// into extension.js by build.mjs.
//
// Labels are uppercase by convention; CodeMirror's prefix matcher is
// case-insensitive against the user-typed word, so typing "se" still resolves
// to "SELECT". The inserted text is the uppercase form (house style).

export const COMMON_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "INSERT", "INTO", "VALUES", "UPDATE", "SET",
  "DELETE", "JOIN", "INNER", "LEFT", "RIGHT", "OUTER", "FULL", "CROSS",
  "ON", "USING", "AS", "AND", "OR", "NOT", "NULL", "IS", "IN", "BETWEEN",
  "LIKE", "ORDER", "BY", "GROUP", "HAVING", "LIMIT", "OFFSET", "DISTINCT",
  "UNION", "ALL", "EXCEPT", "INTERSECT", "EXISTS", "CREATE", "TABLE",
  "INDEX", "VIEW", "SCHEMA", "DATABASE", "DROP", "ALTER", "ADD", "COLUMN",
  "RENAME", "TO", "PRIMARY", "KEY", "FOREIGN", "REFERENCES", "UNIQUE",
  "DEFAULT", "CONSTRAINT", "CHECK", "IF", "ELSE", "ELSIF", "CASE", "WHEN",
  "THEN", "END", "BEGIN", "COMMIT", "ROLLBACK", "TRANSACTION", "SAVEPOINT",
  "WITH", "RECURSIVE", "RETURNING", "NATURAL", "TRUE", "FALSE", "ASC",
  "DESC", "CASCADE", "RESTRICT", "GRANT", "REVOKE", "EXPLAIN", "ANALYZE",
  "SHOW", "DESCRIBE", "TRUNCATE", "REPLACE", "MERGE",
];

export const COMMON_FUNCTIONS = [
  "COUNT", "SUM", "AVG", "MIN", "MAX", "COALESCE", "NULLIF", "CAST",
  "CONVERT", "NOW", "CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME",
  "DATE", "DATETIME", "TIME", "EXTRACT", "CONCAT", "SUBSTRING", "SUBSTR",
  "LENGTH", "CHAR_LENGTH", "TRIM", "LTRIM", "RTRIM", "UPPER", "LOWER",
  "REPLACE", "ROUND", "FLOOR", "CEIL", "CEILING", "ABS", "MOD", "POWER",
  "SQRT", "RANDOM", "RAND", "GREATEST", "LEAST", "ROW_NUMBER", "RANK",
  "DENSE_RANK", "LAG", "LEAD", "FIRST_VALUE", "LAST_VALUE", "OVER",
  "PARTITION",
];

export const COMMON_TYPES = [
  "INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "FLOAT", "DOUBLE",
  "DECIMAL", "NUMERIC", "REAL", "VARCHAR", "CHAR", "TEXT", "LONGTEXT",
  "MEDIUMTEXT", "BLOB", "BINARY", "VARBINARY", "DATE", "DATETIME",
  "TIMESTAMP", "TIME", "YEAR", "BOOLEAN", "BOOL", "JSON",
];
