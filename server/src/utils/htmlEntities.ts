/**
 * Decode HTML entities in text imported from QuickBooks.
 *
 * The QB item export encodes punctuation as HTML entities, so descriptions
 * arrive as "Breathing Air System Inspection &#151; Primary" and
 * "PEC Safeland &amp; H2S". Stored raw, those render literally in the parts
 * picker and ride onto invoices, the QB push and Enverus payloads.
 *
 * The numeric refs need care: QB emits WINDOWS-1252 code points, not Unicode
 * ones. `&#151;` is CP1252 0x97 = an em dash, but Unicode U+0097 is an
 * invisible control character — so `String.fromCharCode(151)` would replace a
 * visible entity with an invisible control char, which is worse than leaving it
 * alone. The 128–159 range is remapped through the CP1252 table below; every
 * other code point is already Unicode (e.g. `&#174;` = ® at U+00AE) and passes
 * through untouched.
 *
 * Decoding is a SINGLE pass over the string, so an escaped entity like
 * "&amp;#151;" decodes once to "&#151;" and is not then mistaken for an em
 * dash — which is what a naive sequence of string replacements would do.
 */

/** CP1252 0x80–0x9F → the Unicode characters QuickBooks actually meant. */
const CP1252_TO_UNICODE: Record<number, string> = {
  128: '€', // €
  130: '‚', // ‚
  131: 'ƒ', // ƒ
  132: '„', // „
  133: '…', // …
  134: '†', // †
  135: '‡', // ‡
  136: 'ˆ', // ˆ
  137: '‰', // ‰
  138: 'Š', // Š
  139: '‹', // ‹
  140: 'Œ', // Œ
  142: 'Ž', // Ž
  145: '‘', // ‘
  146: '’', // ’
  147: '“', // “
  148: '”', // ”
  149: '•', // •
  150: '–', // – en dash
  151: '—', // — em dash
  152: '˜', // ˜
  153: '™', // ™
  154: 'š', // š
  155: '›', // ›
  156: 'œ', // œ
  158: 'ž', // ž
  159: 'Ÿ', // Ÿ
};

/** The named entities QuickBooks actually emits, plus the XML standard five. */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const ENTITY_RE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g;

/**
 * Decode HTML entities, or return the input unchanged when there are none.
 * Unrecognized entities are left as-is rather than dropped — better to show
 * "&pound;" than to silently lose a character we didn't have a mapping for.
 */
export function decodeHtmlEntities(input: string): string {
  if (!input || input.indexOf('&') === -1) return input;

  return input.replace(ENTITY_RE, (match, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) {
      const mapped = NAMED[name.toLowerCase()];
      return mapped !== undefined ? mapped : match;
    }

    const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex as string, 16);
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;

    // CP1252 punctuation masquerading as Unicode control characters.
    const remapped = CP1252_TO_UNICODE[code];
    if (remapped) return remapped;
    // The unassigned CP1252 slots — nothing sensible to show, so keep the
    // entity visible rather than emit a control character.
    if (code >= 128 && code <= 159) return match;

    // Lone surrogates would produce invalid UTF-8 on the way to Postgres.
    if (code >= 0xd800 && code <= 0xdfff) return match;

    return String.fromCodePoint(code);
  });
}

/** Nullable convenience for optional import columns. */
export function decodeHtmlEntitiesOrNull(input: string | null | undefined): string | null {
  if (input == null) return null;
  return decodeHtmlEntities(input);
}
