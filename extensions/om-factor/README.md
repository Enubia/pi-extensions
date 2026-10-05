# om-factor (deprecated)

`/om:factor` is now part of observational-memory. Enable `extensions/observational-memory/src/index.ts` and retire standalone om-factor installations or loose copies before reloading.

This retained entrypoint only warns at `session_start`. It registers no commands and does not automatically load OM. Existing settings are not migrated or deleted.

The integrated command saves a global ratio override for the exact currently selected provider, across codebases. Project compaction settings may override it. `/om:factor reset` removes only that provider's global override. See [OM configuration](../observational-memory/README.md#provider-compaction-factors).
