export function csvEscape(value: unknown): string {
  let s = value == null ? '' : String(value);
  // Formula-injection guard: user text starting with = + - @ or a tab/CR
  // executes as a formula when the CSV is opened in Excel/Sheets. Prefix
  // with ' so spreadsheet apps treat the cell as text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
