// Small text helpers shared by the backends.

/** Collapse whitespace and cut to `max` characters. */
export function oneLine(text, max = 200) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Keep the start of a long text. */
export function clipHead(text, maxChars = 2000) {
  const value = String(text ?? "").trim();
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n[... ${value.length - maxChars} more characters]` : value;
}

/** Remove ANSI colour codes, so that text is readable in a log. */
export const stripAnsi = (text) => String(text ?? "").replace(/\u001b\[[0-9;]*m/g, "");

/** Keep the end of command output: the last lines are usually the ones that matter. */
export function clipTail(text, maxLines = 12, maxChars = 1200) {
  const value = stripAnsi(text).trimEnd();
  if (!value) return "";
  const lines = value.split("\n");
  let kept = lines.slice(-maxLines).join("\n");
  if (kept.length > maxChars) kept = kept.slice(-maxChars);
  const dropped = lines.length - Math.min(lines.length, maxLines);
  return dropped > 0 ? `[... ${dropped} earlier lines]\n${kept}` : kept;
}
