# Private Pi extensions

Private `@enubia/pi-extensions` bundle for `Enubia/pi-extensions`. Not an npm release; do not publish or redistribute this bundle.

## Install and update

With authorized SSH access to the private repository:

```sh
pi install git:git@github.com:Enubia/pi-extensions.git
pi update git:git@github.com:Enubia/pi-extensions.git
pi update --extensions
```

The source is deliberately unpinned and follows the default branch, `main`. The root manifest loads exactly eleven factories, never tests or helpers. Retire loose copies before loading the package; different physical paths do not deduplicate the same extension.

Personal settings stay outside this checkout in the Pi agent directory or project configuration: `settings.json`, `subagent-models.json`, optional `lsp.json`, credentials, sessions, model stores and memory runtime data. Installing this bundle does not provision or migrate them. No automatic updater or policy changes are included.

Pi installs the root runtime dependency (`shell-quote`). Canonical Pi packages and `typebox` are host peers, not production dependencies. No nested npm installs or lifecycle installation scripts are needed.

## Development

Requires Node.js 22.19+ and npm; the Node test runner requires module-mock support. Install all development dependencies at the root:

```sh
npm ci
npm test
npm run test:node
npm run test:memory
npm run typecheck
npm run typecheck:memory
```

All tests, fixtures and test-only helpers live under `test/`. The Node runner includes package-contract tests and excludes the five observational-memory Vitest suites. Test commands automatically use disposable HOME/agent directories, clear inherited credentials and disable automatic Pi network activity. Default tests resolve local development dependencies; global Pi is not required. Canonical `pi-ai/compat` imports preserve the extension API semantics. `tsconfig.json` provides editor module resolution; both root and memory typechecks must pass.

The Pi-owned, development-only `brace-expansion` 5.0.9 dependency has known denial-of-service advisories (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p). Its remediation is explicitly deferred until Pi/upstream updates it; a full `npm audit` is not clean. No dependency override or release-age bypass is applied. Runtime `shell-quote` remains patched at 1.12.0, and the production-only audit must remain clean.

To verify a clean root-only production installation and package loading against an installed Pi host:

```sh
PI_TEST_HOST_ROOT=/path/to/installed/@earendil-works/pi-coding-agent npm run test:install
```

This integration command installs only root production dependencies in a disposable copy, checks registration order/duplicates, and never starts a model request or reads live credentials. npm may download `shell-quote`; subsequent runtime checks are offline.

Optional external tools: `cmux` for notifications, `ccusage` for host usage reporting, and language-server binaries for LSP features. They are not bundled or started merely by package registration. See extension READMEs for configuration.

## Provenance and licensing

This repository starts with independent history: a fresh tracked-file snapshot of selected custom extensions and their tests from pi-config, not its Git history or personal configuration. Production cross-extension layout is preserved.

Observational memory derives from `elpapi42/pi-observational-memory` tag `3.1.3` and `amosblomqvist/pi-observational-memory` commit `78a1efc`. Its `LICENSE` retains both verified copyright notices and full MIT terms; `NOTICE` describes the contributions. Other bundled code remains private and receives no new external redistribution license. There is no blanket root license grant.

Usage fixtures contain synthetic workspaces, `.invalid` addresses, identifiers, reset schedules and quota/spend/profile data. Boundary cases and distinct account scenarios remain covered. Publication requires separate outgoing confidentiality and branch review approval.
