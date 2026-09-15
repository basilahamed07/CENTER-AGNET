# Known Bugs & Open TODOs

Last updated: 2026-09-15 (post Phase-2 increment, commit `8dced6c`)

This file consolidates every known open bug, unfinished item, and TODO across the
project, gathered from the code, `TODO_STATUS.md`, `docs/PHASE_2_ARCHITECTURE.md`,
and `reports/PHASE_1_VALIDATION_REPORT.md`. Fixed bugs are **not** repeated here —
see the reports for those (BUG-1/2/3 in the Phase-1 report; the three Phase-2
extractor/attempt bugs fixed in commit `8dced6c`).

---

## Legend

| Priority | Meaning |
|---|---|
| **P0** | Do next; blocks trusting the product |
| **P1** | Important; do within the next 1–2 increments |
| **P2** | Nice to have; UX polish or future improvement |
| — | Deliberately deferred / by design, listed for completeness |

---

## A. Bugs — none currently open

No **open** bugs are known at this time.

- All 3 Phase-1 bugs (BUG-1 notification channel, BUG-2 worktree UNIQUE crash,
  BUG-3 wrong resume flags) are **fixed with regression tests**.
- All 3 Phase-2 bugs found during validation (attempts never incremented, example-plan
  echo approved as real plan, first-fence-wins extraction) are **fixed with regression
  tests** in commit `8dced6c`.
- Backend suite: 55 tests — 52 pass, 0 fail, 3 platform-gated skips.
- Frontend: `tsc --noEmit` + production build clean.
- Live E2E probe: 23/23 (goal → plan → approve → launch → classify → retry → dead →
  budget stop → cancel → delete), fake agents, real backend.

The items below are **not bugs** — they are unfinished features, unverified
platform behavior, or deferred work.

---

## B. P0 — Verification gaps (do these first)

These are unfinished *verifications*, not code. The code exists and passes on Linux,
but was never exercised on the target platform.

### B1. Windows manual acceptance pass (P0, blocking Phase-2 stages)
- **What:** Full manual run of `docs/WINDOWS_MANUAL_TEST_CHECKLIST.md` on a real
  Windows machine: real `cmd.exe` PTY launch, `.cmd` launcher with `gemini.cmd`,
  `.bat` launcher, reboot persistence.
- **Why open:** ConPTY named pipes can be blocked when the backend is started from a
  restricted tool context (`EPERM ... \\.\pipe\conpty-...`). The backend handles this
  as a clean `PTY_PERMISSION_BLOCKED` API error, but real interactive validation must
  be done from a normal user-started backend.
- **Where:** `docs/WINDOWS_MANUAL_TEST_CHECKLIST.md`; backend `PTY_PERMISSION_BLOCKED`
  handling; `TODO_STATUS.md` § Current Limitation.
- **Blocks:** Per the gate in `docs/PHASE_2_ARCHITECTURE.md`, further Phase-2 stages
  (P2-3 … P2-6) should not start until this is ✅.

### B2. Close Phase-1 report §20 leftovers (P0–P1)
- Graceful stop uses a fixed 2.5 s Ctrl+C wait before surfacing
  `GRACEFUL_STOP_FAILED` (409) — works, but a progress/poll UX would be better. *(P1)*
- 20-session stress test not exercised (only 12 verified flat). *(P1)*
- UI-level drag/drop and command-palette flows not E2E-automated. *(P2)*
- Browser notifications remain permission-gated; denied-permission UX explains
  remediation but desktop delivery is browser-controlled. *(— by design)*

---

## C. P1 — Unfinished Phase-2 stages (per `docs/PHASE_2_ARCHITECTURE.md` §13)

The Phase-2 increment shipped so far = P2-1 + planning portion of P2-2 + manual task
launch + exit classification. Everything below is **not yet implemented**. Work is
gated on B1 (Windows pass) per the status note at the top of the design doc.

### C1. P2-3 — Auto-execution scheduler (largest remaining stage)
- TaskQueue + AssignmentService + Supervisor + automatic retry.
- **Known related limitation (confirmed live in the E2E probe):** task sessions
  launched from bare commands run inside the Phase-1 interactive keep-open shell, so
  they never produce exit events and can't be classified done/failed. The probe
  worked around this by registering agents as direct-exec paths. The **headless
  task-launch strategy is the core P2-3 deliverable** and resolves this.
- Depends on: P2-2 (done).

### C2. P2-4 — Verification + review flow
- `.forge/verify.json` runner and review-task flow.
- Depends on: P2-3.

### C3. P2-5 — MergeGate + Gate 2 UI + autonomy dial
- Human gate before merges; autonomy dial to relax/tighten gates.
- Depends on: P2-4.

### C4. P2-6 — Polish
- Notifications grouping, goal archive/export, general polish.
- Depends on: P2-5.

---

## D. P1/P2 — Remaining work from `TODO_STATUS.md` (product/UX)

- [ ] Prove terminal launch from a normal Windows shell (part of B1). *(P0)*
- [ ] Verify `.cmd` launcher end-to-end with `gemini.cmd` (part of B1). *(P0)*
- [ ] Verify `.bat` launcher end-to-end (part of B1). *(P0)*
- [ ] Add a dedicated fullscreen terminal / focus mode. *(P1)*
- [ ] Replace prompt-dialog CRUD with proper forms (agent registry + workspace
      editing). *(P1)*
- [ ] Add workspace delete/archive UI. *(P1)*
- [ ] Add session detail drawer. *(P2)*
- [ ] Add command palette. *(P2)*
- [ ] Add better empty states and error panels. *(P2)*
- [ ] Add frontend tests (currently only backend has a suite). *(P1)*
- [ ] Worktree branch deletion is fully manual (by design). A SAFE "delete branch
      only if fully merged" helper is a candidate UX improvement. *(P2, deferred per
      Phase-1 report §10/§20)*

---

## E. Deferred / by design (not bugs, listed for honesty)

- **Session-discovery coverage:** agents `hermes`, `crush`, `openhands`, `plandex`,
  `mentat`, `continue` are reported as `unsupported` because no stable documented
  on-disk session format was verifiable (`BACKEND/src/sessionDiscovery.ts`,
  `UNSUPPORTED_AGENTS`). `crush`'s store layout at `~/.local/share/crush` is "not yet
  verified" — verifying it would unlock crush support.
- **Gemini session discovery** is best-effort: `~/.gemini/tmp/<project-hash>` hashes
  are not reversible, so gemini sessions never auto-match a workspace.
- **Kilo sessions** are listed but not resumable (`resumeSupported: false`).
- **Cloud/AWS hosting, remote terminals, public URLs** — Phase 3.
- **Multi-user auth / SaaS** — Phase 3.
- **Agent-to-agent free-form chat** — intentionally excluded (no proven value).
- **Persistent memory graph** — deferred; if a need emerges, design doc §12.2
  prescribes a plain `goal_notes` table, not a graph DB.
- **Auto conflict resolution during merge** — explicitly out of scope even in
  Phase 2 (design doc §7 area).

---

## F. Suggested order of attack

1. **B1** — Windows manual acceptance pass (unblocks the Phase-2 gate).
2. **C1 (P2-3)** — headless task launcher + supervisor; resolves the
   no-exit-events limitation and enables auto-retry.
3. **D** — frontend tests + form-based CRUD (quality-of-life, independent).
4. **C2 → C3 → C4** — verification, MergeGate, polish.
