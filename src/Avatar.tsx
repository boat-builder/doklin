// A person as a face: their initials on a hue derived from their name, so
// the same person reads the same everywhere — a comment, an html pin, the
// title row's facepile, a sidebar row somebody is editing. A blank name is
// somebody nobody could name, drawn as "?" on grey.

export default function Avatar({ name, size = 18 }: { name: string; size?: 16 | 18 | 22 }) {
  const known = name.trim().length > 0;
  return (
    <span
      className={`avatar is-${size} ${known ? "" : "is-unknown"}`}
      style={known ? { background: `hsl(${hueOf(name)} 40% 52%)` } : undefined}
      aria-hidden
    >
      {known ? initialsOf(name) : "?"}
    </span>
  );
}

/** Up to three faces, then "+N" — who is in a note, with the names on hover.
 *  The same person on two Macs is one face. */
export function Facepile({
  names,
  size,
  max = 3,
  title,
  testid,
}: {
  names: string[];
  size: 16 | 22;
  max?: number;
  title: string;
  testid?: string;
}) {
  const people = [...new Set(names)];
  if (people.length === 0) return null;
  const shown = people.slice(0, people.length > max ? max - 1 : max);
  const more = people.length - shown.length;
  return (
    <span
      className={`facepile is-${size}`}
      title={title}
      aria-label={title}
      role="img"
      data-testid={testid}
    >
      {shown.map((n) => (
        <Avatar key={n} name={n} size={size} />
      ))}
      {more > 0 && <span className={`avatar is-${size} is-more`}>+{more}</span>}
    </span>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = [...parts[0]][0] ?? "";
  const last = parts.length > 1 ? [...parts[parts.length - 1]][0] ?? "" : "";
  return (first + last).toUpperCase();
}

function hueOf(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
}
