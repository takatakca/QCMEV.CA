/**
 * MEV-WEB requests are ASCII text (PROVEN: SW-76 2025-06 §4.2, « votre SEV doit toujours présenter au MEV-WEB une
 * requête en format texte en utilisant la table ASCII »).
 *
 * French menus and user names are full of accents (« Poutine régulière », « Hélène »). JSON.stringify keeps them as
 * UTF-8 bytes, so every character above 0x7E is written as a JSON \uXXXX escape instead: the text sent (and signed in
 * SIGNATRANSM) is pure ASCII, and a JSON parser reads back exactly the original string, so the printed invoice and the
 * transmitted description stay identical. Characters outside the BMP become two escapes (a surrogate pair), as JSON
 * requires. SPEC (SPEC_GAPS #29): whether MEV-WEB wants these escapes or an ASCII transliteration, and which
 * characters it accepts in each field, waits for SW-73 / SW-73.A.
 */

const NON_ASCII = /[\u007f-￿]/g;

/** JSON text of `value` containing only ASCII characters (0x00–0x7E). */
export function toAsciiJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('value cannot be serialized as JSON');
  return json.replace(NON_ASCII, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** true when every character of `s` is ASCII (0x00–0x7F). */
export function isAscii(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /^[\u0000-\u007f]*$/.test(s);
}
