// SQL Explorer — dom/dateParts: the date/time <-> string conversions behind the
// picker. Bundled into extension.js by build.mjs.
//
// Pure: no DOM, no state. Split from `datePicker.js` because getting these
// wrong writes a WRONG DATE to the database, and a pure function is the part
// that can actually be checked (see scripts/sql-explorer-verify.ts).

export const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Parse an input-format value ("YYYY-MM-DD", "HH:MM:SS",
 *  "YYYY-MM-DDTHH:MM:SS") into a working state. Missing parts fall back to
 *  today / zero; `hasDate` / `hasTime` record what the value actually carried
 *  so an untouched empty cell stays NULL instead of committing "now". */
export function parseState(type, value) {
  const now = new Date();
  const st = {
    y: now.getFullYear(),
    mo: now.getMonth(),
    d: now.getDate(),
    hh: 0,
    mi: 0,
    ss: 0,
    hasDate: false,
    hasTime: false,
  };
  const s = value == null ? "" : String(value);
  if (s && type !== "time") {
    const dm = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (dm) {
      st.y = +dm[1];
      st.mo = Math.min(11, Math.max(0, +dm[2] - 1));
      st.d = Math.min(31, Math.max(1, +dm[3]));
      st.hasDate = true;
    }
  }
  if (s && type !== "date") {
    const tm = s.match(/(?:^|[T ])(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (tm) {
      st.hh = Math.min(23, Math.max(0, +tm[1]));
      st.mi = Math.min(59, Math.max(0, +tm[2]));
      st.ss = tm[3] != null ? Math.min(59, Math.max(0, +tm[3])) : 0;
      st.hasTime = true;
    }
  }
  return st;
}

/** Format the working state back to the input-format string the SQL backend
 *  expects (matching isoToInputValue / inputValueToIso in columns.js). */
export function formatState(type, st) {
  if (type === "time") return `${pad2(st.hh)}:${pad2(st.mi)}:${pad2(st.ss)}`;
  const date = `${st.y}-${pad2(st.mo + 1)}-${pad2(st.d)}`;
  if (type === "date") return date;
  return `${date}T${pad2(st.hh)}:${pad2(st.mi)}:${pad2(st.ss)}`;
}

/**
 * Create a date / time / datetime picker.
 *
 * @param {object} opts
 * @param {"date"|"time"|"datetime"} opts.type
 * @param {string} opts.value           initial input-format value ("" = empty)
 * @param {(value:string)=>void} [opts.onCommit]  confirm (Apply / day-click for
 *        date / Enter / Today-Now / Clear). Receives the input-format string
 *        ("" when cleared). Present for the inline cell editor; omitted for the
 *        insert dialog (which reads getValue() on submit).
 * @param {()=>void} [opts.onCancel]     Escape with the popup closed.
 * @returns {{ wrap, getValue, setValue, focus, openPopup, closePopup, contains }}
 */
