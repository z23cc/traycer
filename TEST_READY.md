# Test Readiness Report: 7 Optional Analog Unaries

## Test Execution Command

```bash
# Targeted test suite for all 7 analog unaries
bunx nx run @traycer/host:test analog-unaries.test.ts

# Full host test suite
bunx nx run @traycer/host:test --skip-nx-cache

# Compilation & lint checks
bun run compile
bun run lint
```

## Test Counts Across Tiers

| Tier | Test Group | Tests Count | Status | Notes |
|---|---|---|---|---|
| **Tier 1** | Schema Contract Tests | 7 | 7 / 7 PASSED | Validates wire responses of all 7 unaries using `@traycer/protocol` Zod schemas via `.safeParse(res.result).success === true` |
| **Tier 2** | Invalid Parameter Tests | 6 | 6 / 6 PASSED | Asserts `ok: false`, `code: "RPC_ERROR"`, error message does NOT contain `"is not implemented by this OSS host"` |
| **Tier 3** | Pre-set Epic Tests | 2 | 2 / 2 PASSED | Validates `epic.create` and `phase.migrateToEpic` context projection (`epicLight`, `repos`, `workspaces`, `workspaceFolders`) |
| **Tier 4** | State Persistence Tests | 2 | 2 / 2 PASSED | Validates read/write roundtrip and disk persistence for `log-levels.json` and `host-name.json` |
| **Tier 5** | Maintenance & Installation Info Tests | 5 | 5 / 5 PASSED | Tests `cli-unavailable`, `externally-managed`, `unmanaged` fallback, and `managed` install record parsing |
| **Total** | `analog-unaries.test.ts` | **22** | **22 / 22 PASSED** | 100% pass rate in 213ms |
| **Full Host** | `@traycer/host` Test Suite | **95** across **20** files | **95 / 95 PASSED** | Zero regressions |

---

## Feature Checklist

- [x] **`epic.getWorkspaceContext@1.0`**
  - [x] Request parameter `{ epicId }` validated via `getWorkspaceContextRequestSchema`.
  - [x] Non-existent `epicId` returns `RPC_ERROR` (does not return empty context).
  - [x] Pre-set epic via `epic.create` populates `epicLight`, `permissionRole: "owner"`, `repos`, `workspaces`, `workspaceFolders`, `repoMapping: []`, `unresolvedRepos: []`.
  - [x] Pre-set epic via `phase.migrateToEpic` populates context with `permissionRole: "owner"`.
  - [x] Wire response validated with `getWorkspaceContextResponseSchema.safeParse(res.result).success === true`.

- [x] **`browser.savedLoginSites@1.0`**
  - [x] Returns `{ kind: "sites", sites: [] }` (not sealed, avoiding unnecessary keychain prompts).
  - [x] Rejects extra unrecognized properties with `RPC_ERROR` due to `.strict()` request schema.
  - [x] Wire response validated with `browserSavedLoginSitesResponseSchema.safeParse(res.result).success === true`.

- [x] **`config.logLevels.get@1.0` & `config.logLevels.set@1.0`**
  - [x] Default log levels are `{ cliLogLevel: "info", hostLogLevel: "info" }`.
  - [x] `config.logLevels.set` updates CLI or host log level and persists atomically to `<host-data-dir>/log-levels.json`.
  - [x] Rejects invalid scope (e.g., `"desktop"`) with `RPC_ERROR`.
  - [x] Rejects invalid log level (e.g., `"verbose"`) with `RPC_ERROR`.
  - [x] Wire responses validated with `configLogLevelsResponseSchema.safeParse(res.result).success === true`.

- [x] **`host.identity.get@1.0` & `host.identity.set@1.0`**
  - [x] Returns `{ systemName, customName, effectiveName }`.
  - [x] `host.identity.set` trims whitespace and collapses internal multiple spaces into single spaces.
  - [x] Empty or whitespace-only custom names normalize to `null`, causing `effectiveName` to revert to `systemName`.
  - [x] Custom names exceeding 80 characters rejected with `RPC_ERROR` (no silent truncation).
  - [x] Persisted atomically to `<host-data-dir>/host-name.json`.
  - [x] Wire responses validated with `hostIdentitySchema.safeParse(res.result).success === true`.

- [x] **`host.update.check@1.1`**
  - [x] Responds with `{ outcome: "cli-unavailable" }` for both default and `{ includePreReleases: true }` requests.
  - [x] Wire response validated with `hostUpdateCheckResponseSchemaV11.safeParse(res.result).success === true`.

- [x] **`host.getInstallationInfo@1.1`**
  - [x] Missing `<host-data-dir>/install/install.json` returns `{ status: "unmanaged" }`.
  - [x] Corrupt or unparseable `install.json` safely returns `{ status: "unmanaged" }` without crashing.
  - [x] Valid `install.json` adhering to `hostInstallRecordSchema` returns `{ status: "managed", installRecord, stagedRecord: null, cliManifest: null }`.
  - [x] Wire responses validated with `hostGetInstallationInfoResponseV11Schema.safeParse(res.result).success === true`.

- [x] **`host.service.status@1.0`**
  - [x] Responds with `{ outcome: "externally-managed" }`.
  - [x] Wire response validated with `hostServiceStatusResponseSchema.safeParse(res.result).success === true`.

---

## Code Quality & Engineering Compliance

- [x] **ESLint / Oxlint Rules**:
  - No `x?: T` (used `x: T | undefined`).
  - No default parameter values `fn(x = 1)`.
  - No `as any` or `as unknown` or chained type assertions.
  - No `ReturnType<typeof fn>`.
- [x] **Formatting**: Formatted with `bunx oxfmt`.
- [x] **Type Checking**: Full repository `bun run compile` succeeds with zero errors.
