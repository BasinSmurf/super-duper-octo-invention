# SPaaS workspace boundaries

This is an independent copy of Claudius for customer-specific buildouts.
Read FORK.md before changing application or deployment configuration.

- Make changes in this repository. Do not edit the original Claudius checkout.
- Keep credentials, customer data, and runtime environment files out of Git.
- Treat inherited deployment, sync, import, CI, integration, and database settings
  as source-customer configuration until explicitly isolated for this repository.
- Do not run inherited production operations as part of local setup or validation.
- Prefer reusable configuration for customer differences over hardcoded identity.
- Preserve fork-baseline/manifest.json as the original copy record.
