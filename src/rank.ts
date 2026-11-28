// Fractional order keys: a card's place in its board's column, as a short
// string that sorts as text.
//
//   a0  <  a0V  <  a1  <  a2
//
// Putting a card between two others writes one key, and leaves every other
// card's key as it was, so two people's drags on one board merge record by
// record (`mergeBoards`, src/web/merge.ts).
//
// The layout is the well-known order key (Figma's, as David Greenspan
// published it, and the `fractional-indexing` package's): an INTEGER part
// whose first character says its own length, then an optional FRACTION.
// Text order is the sort order: no parsing, no floats, no ties to break.
//
//   head 'a'..'z'  positive, integer length 2..27  ('a0' is the first key)
//   head 'A'..'Z'  negative, integer length 2..27  (used when prepending)
//
// The iPhone ports it (ios/DoklinKit/Sources/DoklinKit/Markdown/Boards.swift),
// held to verify-harness/boards-fixture.json: change both.

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SMALLEST_INT = "A" + "0".repeat(26);

/** The first key in an empty column. */
export const FIRST_RANK = "a0";

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  throw new Error(`invalid order key head: ${head}`);
}

function integerPart(key: string): string {
  const len = integerLength(key.charAt(0));
  if (len > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, len);
}

function validateInteger(int: string): void {
  if (int.length !== integerLength(int.charAt(0))) {
    throw new Error(`invalid integer part of order key: ${int}`);
  }
}

/** Throws unless `key` is a well-formed order key. */
export function validateRank(key: string): void {
  if (key === SMALLEST_INT) throw new Error(`invalid order key: ${key}`);
  const int = integerPart(key);
  const frac = key.slice(int.length);
  validateInteger(int);
  for (const c of key.slice(1)) {
    if (!DIGITS.includes(c)) throw new Error(`invalid order key: ${key}`);
  }
  if (frac.endsWith("0")) throw new Error(`invalid order key (trailing zero): ${key}`);
}

function incrementInteger(x: string): string | null {
  validateInteger(x);
  const head = x.charAt(0);
  const digs = x.slice(1).split("");
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) + 1;
    if (d === DIGITS.length) digs[i] = DIGITS[0];
    else {
      digs[i] = DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digs.join("");
  if (head === "Z") return "a" + DIGITS[0];
  if (head === "z") return null; // the very top; callers fall back to a fraction
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > "a") digs.push(DIGITS[0]);
  else digs.pop();
  return next + digs.join("");
}

function decrementInteger(x: string): string | null {
  validateInteger(x);
  const head = x.charAt(0);
  const digs = x.slice(1).split("");
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]) - 1;
    if (d === -1) digs[i] = DIGITS[DIGITS.length - 1];
    else {
      digs[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join("");
  if (head === "a") return "Z" + DIGITS[DIGITS.length - 1];
  if (head === "A") return null; // the very bottom
  const prev = String.fromCharCode(head.charCodeAt(0) - 1);
  if (prev < "Z") digs.push(DIGITS[DIGITS.length - 1]);
  else digs.pop();
  return prev + digs.join("");
}

// A fraction strictly between `a` and `b` (both fractions, `b` may be null for
// "no upper bound"), never ending in a zero digit.
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.endsWith("0") || (b !== null && b.endsWith("0"))) {
    throw new Error("fraction with a trailing zero");
  }
  if (b !== null) {
    let n = 0;
    while ((a.charAt(n) || "0") === b.charAt(n)) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : DIGITS.indexOf(a.charAt(0));
  const digitB = b !== null ? DIGITS.indexOf(b.charAt(0)) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

/**
 * A key strictly between `a` and `b`. `null` on either side means "the end" —
 * `keyBetween(null, null)` is the first key on an empty list, and
 * `keyBetween(last, null)` appends.
 *
 * Throws on malformed input or `a >= b`; `rankBetween` is the tolerant
 * wrapper the UI uses.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validateRank(a);
  if (b !== null) validateRank(b);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return FIRST_RANK;
    const intB = integerPart(b);
    const fracB = b.slice(intB.length);
    if (intB === SMALLEST_INT) return intB + midpoint("", fracB);
    if (intB < b) return intB;
    const dec = decrementInteger(intB);
    if (dec === null) throw new Error("cannot decrement any further");
    return dec;
  }
  if (b === null) {
    const intA = integerPart(a);
    const fracA = a.slice(intA.length);
    const inc = incrementInteger(intA);
    return inc === null ? intA + midpoint(fracA, null) : inc;
  }
  const intA = integerPart(a);
  const fracA = a.slice(intA.length);
  const intB = integerPart(b);
  const fracB = b.slice(intB.length);
  if (intA === intB) return intA + midpoint(fracA, fracB);
  const inc = incrementInteger(intA);
  if (inc === null) throw new Error("cannot increment any further");
  if (inc < b) return inc;
  return intA + midpoint(fracA, null);
}

/**
 * The rank to give something dropped between `a` and `b`, whatever the file
 * holds. A rank edited by hand to `hello`, or a pair out of order, must not
 * stop a drag: the bad side counts as an open end, and if both are unusable
 * the result is a first key. `isRank` keeps unusable ranks out of the order.
 */
export function rankBetween(a: string | null, b: string | null): string {
  const clean = (v: string | null): string | null => {
    if (v === null) return null;
    try {
      validateRank(v);
      return v;
    } catch {
      return null;
    }
  };
  let lo = clean(a);
  let hi = clean(b);
  if (lo !== null && hi !== null && lo >= hi) hi = null;
  try {
    return keyBetween(lo, hi);
  } catch {
    try {
      return keyBetween(lo, null);
    } catch {
      return FIRST_RANK;
    }
  }
}

/** `n` keys in order, after `a` and before `b`. */
export function ranksBetween(a: string | null, b: string | null, n: number): string[] {
  if (n <= 0) return [];
  if (n === 1) return [rankBetween(a, b)];
  const mid = rankBetween(a, b);
  const half = n >> 1;
  return [
    ...ranksBetween(a, mid, half),
    mid,
    ...ranksBetween(mid, b, n - half - 1),
  ];
}

/** Whether `key` is a well-formed order key. */
export function isRank(key: string | null | undefined): key is string {
  if (typeof key !== "string" || key === "") return false;
  try {
    validateRank(key);
    return true;
  } catch {
    return false;
  }
}
