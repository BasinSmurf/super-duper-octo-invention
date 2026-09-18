# SPaaS customer-buildout repository

SPaaS is an independent source copy of Claudius intended to become a reusable
base for customer-specific buildouts. Genericization has not yet been applied.

## Baseline

- Source: `C:\turdhurdles\Claudius`
- Source HEAD: `45b3d4446e5c08147119f0b3550a07916c2e9f0d`
- Source branch: `codex/vendor-receive-billing`
- Includes the current working files, including uncommitted changes and new files.
- All 740 copied files were verified against the source using SHA-256.
- `fork-baseline/manifest.json` records file hashes and the original Git status.

This repository has its own Git metadata and initial history. No source remote,
Git hooks, or nested worktrees were copied. The original checkout is untouched.

The copy includes Git-tracked and non-ignored new files. It excludes ignored local
material: credentials, server environment files, customer/import data, certificates,
dependencies, build products, local-only docs/deployment notes, and untracked agent state.
The tracked `.env.example`, public `client/.env.production`, and
`.claude/launch.json` are retained.

## Customer buildouts

Keep reusable application work in this repository. Use separate `customer/<slug>`
branches or separate customer repositories for buildouts; do not modify Claudius
as part of work here. Supply each customer's credentials and runtime data outside Git.

Existing branding, URLs, integration defaults, CI workflows, deployment scripts,
database seeds, and sync/import utilities still describe the original application.
Review and isolate these settings before running the application or enabling CI
or deployment. Each customer needs independent databases, storage, integration
credentials, domains, and deployment targets. A source copy does not create those
resources. No services, migrations, data syncs, or deployments were run for this copy.

Start genericization by making customer identity and integration configuration
explicit, then separating reusable behavior from customer-specific defaults.
The existing README and runbooks remain source-application references until updated.
