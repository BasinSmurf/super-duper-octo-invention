import { useState, useEffect } from 'react'

interface QuantityInputProps {
  value: number
  onChange: (value: number) => void
  /** Minimum allowed value, applied on blur. Defaults to 0. */
  min?: number
  className?: string
  placeholder?: string
  id?: string
  'aria-label'?: string
  title?: string
  autoFocus?: boolean
}

// Allows: empty, "12", "12.", "12.5", "12.55", ".5" — but rejects a 3rd decimal.
const QTY_RE = /^\d*\.?\d{0,2}$/

/**
 * Quantity field used across line-item / parts / rental editors.
 *
 * Fixes two long-standing field complaints:
 *  1. Tapping the box selects the current value, so the first keystroke
 *     REPLACES it instead of appending (no more "10" becoming "101"/"110",
 *     no need to manually clear the default "1" first).
 *  2. Accepts decimals up to 2 places (e.g. mileage like 12.75) — the box
 *     can be fully emptied while typing and only snaps to `min` on blur.
 *
 * Uses type="text" + inputMode="decimal" rather than type="number": it gives
 * a decimal keypad on tablets/phones and avoids the native number-input quirks
 * that caused the append behaviour in the first place.
 */
export function QuantityInput({
  value,
  onChange,
  min = 0,
  className,
  placeholder,
  id,
  title,
  autoFocus,
  'aria-label': ariaLabel,
}: QuantityInputProps) {
  const [text, setText] = useState(() => String(value ?? ''))
  const [focused, setFocused] = useState(false)

  // Re-sync from the canonical value when not actively editing.
  useEffect(() => {
    if (!focused) setText(value == null ? '' : String(value))
  }, [value, focused])

  return (
    <input
      type="text"
      inputMode="decimal"
      id={id}
      title={title}
      aria-label={ariaLabel}
      autoFocus={autoFocus}
      placeholder={placeholder}
      className={className}
      value={text}
      onFocus={e => {
        setFocused(true)
        e.target.select()
      }}
      onChange={e => {
        const raw = e.target.value
        if (raw !== '' && !QTY_RE.test(raw)) return // reject 3rd decimal / non-numeric
        setText(raw)
        const n = parseFloat(raw)
        if (!Number.isNaN(n)) onChange(Math.round(n * 100) / 100)
      }}
      onBlur={() => {
        setFocused(false)
        let n = parseFloat(text)
        if (Number.isNaN(n) || n < min) n = min
        n = Math.round(n * 100) / 100
        setText(String(n))
        onChange(n)
      }}
    />
  )
}
