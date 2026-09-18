# ADR-0004 — Frontend build tool: Vite vs esbuild / Rspack / Bun / rolldown-vite

- **Status:** Proposed
- **Date:** 2026-06-27
- **Principle flags:** None.

## Current state (file evidence)
- **Vite 7.3.1** + `@vitejs/plugin-react` 5.1.1 + Tailwind v4 via `@tailwindcss/vite` + `vite-plugin-pwa` 1.2.0 (`client/vite.config.ts`).
- Build = `tsc -b && vite build` (`client/package.json`).
- **Measured (this machine):** client build **39s total**; `vite build` itself **11.4s**; `tsc -b` is the rest.
- **Output:** main chunk **2,532 KB / 656 KB gzip**, single file. Only `html2canvas-pro` (231 KB) is split (it self-imports). Vite *prints the fix in the build log* — "Use dynamic import()" / "manualChunks" — and it is being ignored.
- `vite.config.ts` has **no `build.rollupOptions` / `manualChunks`**, and `App.tsx` has **zero `React.lazy`**.

## Why it was likely chosen
Vite is the modern React default — fast HMR, zero-config, the Tailwind-v4 and PWA plugins are first-party. Correct call.

## The case to replace
- **rolldown-vite** (Rust bundler, drop-in) and **Rspack** promise faster cold builds. **Bun** could replace the toolchain wholesale.
- But: the client `vite build` is **11.4s**. That is not slow. There is nothing here to fix by changing bundlers.

## The case to keep
- The build-tool is **not** where any lumbering lives. The 39s client build is dominated by `tsc -b`, not Vite; and the *runtime* lumbering (2.5 MB chunk) is a **config omission**, not a Vite limitation — Vite supports lazy + manualChunks today and is literally telling you so in the log.
- Swapping bundlers to "go faster" while ignoring the free, in-product code-splitting Vite already offers would be effort spent in the wrong place.

## Migration cost / risk / effort
- **Change bundler: Low effort, near-zero benefit, refuse.**
- **Use Vite's existing splitting (lazy routes + `manualChunks` for tesseract/recharts/qrcode/dnd-kit/stripe): Low effort, high benefit.** This is the actual fix and it stays on Vite.
- **rolldown-vite when stable: Replace-later, trivial** (it's a drop-in `vite` alias) — revisit only if `tsc`-free build time becomes a complaint after splitting.

## Verdict: **KEEP** (Vite).
> Vite is correct and fast (11.4s). The 2.5 MB chunk is an un-configured `manualChunks` + missing `React.lazy`, not a bundler problem. Fix the config; don't change the tool. Revisit rolldown-vite later as a free drop-in if desired.
