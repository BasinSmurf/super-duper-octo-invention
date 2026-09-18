import type { CSSProperties } from 'react'

/**
 * Shop board column theming.
 *
 * Built-in defaults live HERE and nowhere else — the server only stores the
 * admin's per-column overrides and echoes them back in the board response's
 * `theme.columnColors`. The board and the settings page both merge those
 * overrides over these defaults, so this file is the single source of truth
 * for "what color is a column when nobody's touched it".
 *
 * A value of `null` (default or override) means "no tint" — the column keeps
 * the neutral glassy-dark styling. A "#rrggbb" hex tints the whole column:
 * solid header, translucent body wash + border of the same hue.
 */

export type ColumnColors = Record<string, string | null>

export const DEFAULT_STAGE_COLORS: ColumnColors = {
  incoming:     null,
  in_service:   '#caa10a', // gold
  on_hold:      null,
  ready_pickup: '#2f7d32', // green
  departing:    null,
}

// Columns exposed in Board Settings, in display order. Transit columns
// (incoming/departing) are omitted — they only flash up briefly in transit and
// the boss's mockup left them neutral.
// Two keys have since left the wall board and are no longer themeable: Re-Test
// (WI-01, folded into In Service) and Received (the board split — intake folds
// into In Service too). A colour already stored under either dead key is inert:
// resolveColumnColors merges overrides over these defaults and nothing looks
// the dead key up.
export const THEMEABLE_COLUMNS: Array<{ key: string; title: string }> = [
  { key: 'in_service',   title: 'In Service' },
  { key: 'on_hold',      title: 'On Hold' },
  { key: 'ready_pickup', title: 'Ready for Pickup' },
]

// Opacity of the body wash / border derived from a column's base hue.
export const COLUMN_TINT_ALPHA = 0.09
export const COLUMN_BORDER_ALPHA = 0.28

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export interface StageStyle {
  /** Solid fill for the header strip. */
  header: CSSProperties
  /** Translucent wash + border for the column shell. */
  column: CSSProperties
}

/** Merge stored overrides over the built-in defaults. */
export function resolveColumnColors(overrides?: ColumnColors | null): ColumnColors {
  return { ...DEFAULT_STAGE_COLORS, ...(overrides ?? {}) }
}

/** Derived inline styles for a column, or null to keep the dark default. */
export function stageStyle(key: string, colors: ColumnColors): StageStyle | null {
  const base = colors[key]
  if (!base) return null
  return {
    header: { backgroundColor: base },
    column: {
      backgroundColor: hexToRgba(base, COLUMN_TINT_ALPHA),
      borderColor: hexToRgba(base, COLUMN_BORDER_ALPHA),
    },
  }
}
