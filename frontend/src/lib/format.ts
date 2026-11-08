/** Render an ISO timestamp in the local timezone as YYYY-MM-DD HH:MM. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Size units in 1024 steps, labelled the way users expect (not KiB). */
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/**
 * Render a byte count for display: whole bytes under 1 KB, otherwise
 * 1024-based units to one decimal place with a trailing ".0" dropped
 * ("812 KB", "1.2 MB"). A value that rounds to 1024 moves up a unit.
 *
 * @param bytes - non-negative size in bytes
 * @returns the human-readable size, e.g. "1.2 MB"
 */
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (unit < SIZE_UNITS.length - 1 && Math.round(value * 10) / 10 >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${SIZE_UNITS[unit]}`;
}
