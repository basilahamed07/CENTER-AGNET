# FORGE Phase 2 — Agentic Orchestration Architecture (DESIGN ONLY)

> **STATUS: DESIGN DOCUMENT — PARTIALLY IMPLEMENTED.**
>
> Implemented so far (2026-09-15, validated by unit suite + live fake-agent E2E probe):
> **P2-1** (tables, goal CRUD, timeline, Goals panel) and the **planning portion of P2-2**
> (per-goal planner, deterministic plan extraction + validation, Gate 1) plus manual task
> launch with Phase-1 worktree isolation and exit classification with the hard budget stop.
> NOT yet implemented: auto-execution scheduler/TaskQueue/AssignmentService/Supervisor (P2-3),
> verification + review flow (P2-4), MergeGate + Gate 2 + autonomy dial (P2-5), polish (P2-6).
> Per `reports/PHASE_1_VALIDATION_REPORT.md` (§24 + Phase-2 gate), implementation is **gated** on:
>
> 1. ✅ Phase-1 validation passed on Linux — 8/10, PERSONAL DAILY-USE READY
> 2. ⬜ Windows manual acceptance pass (`docs/WINDOWS_MANUAL_TEST_CHECKLIST.md`)
> 3. ⬜ Phase-1 remaining items closed (see report §20)
>
> Do not start implementing any section of this document until 2 and 3 are ✅.

---

## 0. What Phase 2 Is (and Is Not)

**Phase 2 = the system starts *driving* the agents, not just *hosting* them.**

Phase 1 (built, validated): you manually launch agents into workspaces/worktrees, watch
terminals, get notifications. FORGE is a **control center**.

Phase 2 (this document): you give FORGE a **goal**, it produces a **plan**, breaks it into
**tasks**, assigns **agents**, runs them **in isolation**, watches progress, and assembles the
results — with human gates at every dangerous decision. FORGE becomes a **supervisor**.

**Explicitly OUT of scope for Phase 2 (Phase 3 candidates):**
- Cloud/AWS hosting, remote terminals, public URLs (Phase 3)
- Multi-user auth, SaaS anything (Phase 3)
- Agent-to-agent chat / free-form debate (no proven value for coding tasks)
- Long-term persistent memory graphs across projects (deferred — see §12.2 for the honest rationale)

**Hard safety rule inherited from Phase 1 (§20/§23 of the original spec):**
FORGE never silently destroys work. Every destructive action (merge, discard, force-kill of a
planning run) requires either an explicit human gate or a fully-verified, revertible path.

---

## 1. Design Principles

1. **Phase 1 is the substrate.** Orchestrations are just *sessions with a boss*. Everything
   Phase 2 does goes through the existing `ProcessManager.launch()`, `EventBus`, worktree
   manager, and SQLite repository. No parallel execution stack.
2. **The agents are the LLM.** No new AI API keys, no SDK. Planning and code review are done
   by the *same installed CLI agents* (Claude Code, Codex, …) invoked in non-interactive /
   plan mode. The orchestrator is a **state machine**, not a brain.
3. **Determinism where possible.** Task states, assignment rules, and retries are plain code.
   Only *content generation* (plans, code, reviews) touches an LLM.
4. **Human gates are the default.** Autonomy is a dial (§10), default position: "propose,
   wait for me."
5. **One task = one worktree = one branch.** Reuses Phase-1 isolation verbatim; the merge
   problem is converted into a *review problem* (§8).
6. **Everything observable.** Every orchestration decision is an event on the existing
   `EventBus`, visible in the same UI and notification layer.

---

## 2. System Overview

```
                         ┌────────────────────────────────────────────────┐
                         │                  FORGE MANAGER                 │
   ┌───────────┐         │  ┌──────────────┐      ┌────────────────────┐  │
   │ Next.js UI│◄──WS───►│  │  ProcessManager (P1) │  │  Orchestrator (P2) │  │
   └───────────┘         │  └──────┬───────┘      └─────────┬──────────┘  │
        REST             │         │  launches               │  launches   │
   ┌───────────┐         │         ▼                         ▼             │
   │  SQLite   │◄───────►│  real PTY sessions  ◄────  worker sessions      │
   └───────────┘         │  (workspaces/worktrees)    (one worktree each)  │
                         │         ▲                         │             │
                         │         └────── EventBus ◄───────┘             │
                         └────────────────────────────────────────────────┘
```

New components (all inside the existing BACKEND service — **not** a new process):

| Component | Phase-1 base it extends | Responsibility |
|---|---|---|
| `Orchestrator` | `EventBus`, `repository` | Owns `Goal → Plan → Tasks` lifecycle; the state machine |
| `PlannerService` | `ProcessManager`, `launcher` | Runs a planner-capable CLI agent in *plan mode* to produce a structured plan |
| `TaskQueue` | SQLite | Priority-ordered ready-tasks; dependency-aware scheduling |
| `AssignmentService` | agent registry | Picks agent per task type (code vs. test vs. docs); capacity-aware |
| `Supervisor` | `computeStuckSignals`, event stream | Per-task watchdog: progress classification, retry policy, escalation |
| `VerifierService` | worktree diff/status APIs | Machine checks (tests/lint/build) + optional agent review pass |
| `MergeGate` | `worktreeManager` | Rebase-check → CI-style checks → **human approval** → merge |
| `OrchestratorRepo` | `repository` | New tables (§5) |

---

## 3. The Core Lifecycle

```
GOAL (human writes it)
   │
   ▼
[PLANNING]      planner agent → Plan (task graph, JSON)
   │            ◄── HUMAN GATE 1: review/edit/approve plan
   ▼
[READY]         task graph stored; roots become ready
   │
   ▼
[RUNNING]       for each ready task (topological, ≤ concurrency limit):
   │              1. create worktree branch agent/<task-slug>   (Phase-1 API)
   │              2. launch assigned agent with task prompt      (Phase-1 API)
   │              3. Supervisor watches events                  (Phase-1 events)
   │              4. on exit: classify → done / failed / stuck
   │                    ├── failed → retry ≤ N with failure context, then DEAD
   │                    └── done  → verify (§9) → PASS: children ready
   ▼
[VERIFYING]     all leaf tasks done → whole-plan verification
   │            ◄── machine checks auto; agent review optional
   ▼
[REVIEW]        ◄── HUMAN GATE 2: review diffs per task (Phase-1 diff UI!)
   │
   ▼
[MERGING]       MergeGate: merge approved branches, in dependency order
   │            conflicts → task is re-opened with conflict context (no auto-resolve)
   ▼
[COMPLETE]      goal closed; worktrees cleaned (dirty-safe, Phase-1 rules)
```

Every arrow is also a notification event (Phase-1 settings UI gains an "Orchestration" group).

---

## 4. Planning: How a Plan Is Produced

**Key decision: the planner is a CLI agent, not a service.**

1. User submits a goal (title + description + workspace).
2. **The planner agent is chosen PER GOAL** (owner decision, 2026-09-15): the goal-creation
   form has a planner dropdown (enabled planner-capable agents from the registry), with a
   configurable default in settings. No silent default agent.
3. `PlannerService` launches the chosen planner via Phase-1 `launch()` in
   the workspace root with a **planner system prompt** that demands output in a strict JSON
   schema (`PlanSchema`) — streamed into the session as usual (user can watch it live).
3. A small **plan extractor** tails the session ring buffer for the fenced
   ```forge-plan … ``` block (bounded, regex-parsed — *not* LLM-inferred; satisfies the
   "no LLM status inference" caution for plans: extraction is deterministic).
4. `PlanSchema` (Zod) validates. On failure: one bounded re-ask round with the validation
   error appended. Still failing → plan marked NEEDS_ATTENTION, human edits it in the UI.
5. **Human Gate 1**: plan renders as an editable task graph. Human can rename, re-order,
   re-assign, delete, or add tasks before approval.

```ts
interface Plan {
  goalId: string;
  summary: string;
  tasks: PlanTask[];
}
interface PlanTask {
  key: string;                      // stable slug, e.g. "implement-auth"
  title: string;
  description: string;              // the actual prompt seed for the worker
  kind: 'code' | 'test' | 'docs' | 'review' | 'chore';
  dependsOn: string[];              // keys; must be acyclic
  suggestedAgentKey?: string;       // 'claude' | 'codex' | … (advisory)
  acceptance: string[];             // machine-checkable criteria seeds
  risk: 'low' | 'medium' | 'high';  // high ⇒ extra review gate
}
```

Cycles, missing deps, >50 tasks, or >3-level depth are rejected at validation with the
offending path shown.

---

## 5. Data Model (new SQLite tables)

All created by the Phase-2 migration; follows Phase-1 conventions (text UUIDs,
`created_at`, soft-delete where history matters).

```sql
goals (
  id, workspace_id, title, description,
  status TEXT CHECK(status IN ('draft','planning','awaiting_plan_approval',
             'running','verifying','awaiting_review','merging','complete',
             'failed','cancelled')),
  planner_session_id,          -- links to the agent_sessions row of the planner run
  planner_definition_id,       -- agent_definitions.id — chosen PER GOAL in the UI
  plan_json,                   -- approved plan snapshot
  concurrency_limit INTEGER DEFAULT 3,
  attempt_budget INTEGER DEFAULT 10,   -- failed attempts → hard stop + notify
  reviews_enabled INTEGER DEFAULT 1,   -- second-agent review per code task
  autonomy TEXT DEFAULT 'gated',     -- §10
  created_at, updated_at
)

goal_tasks (
  id, goal_id, plan_key,
  title, description, kind, risk,
  depends_on_json,             -- array of goal_task ids
  status TEXT CHECK(status IN ('blocked','ready','assigned','running',
             'verifying','done','failed','dead','cancelled')),
  attempts INTEGER DEFAULT 0,
  assigned_definition_id,      -- agent_definitions.id
  session_id,                  -- agent_sessions.id of the CURRENT attempt
  worktree_id,                 -- agent_worktrees.id (Phase-1 table!)
  branch,                      -- agent/<slug>
  verification_json,           -- results of checks (§9)
  failure_json,                -- last failure classification
  created_at, updated_at,
  UNIQUE(goal_id, plan_key)
)

goal_events (            -- orchestration decisions, for the UI timeline + audit
  id, goal_id, task_id NULLABLE, type, payload_json, created_at
)
```

`goal_tasks` deliberately **reuses** `agent_sessions` and `agent_worktrees`: a task *is* a
Phase-1 session running in a Phase-1 worktree, plus bookkeeping. Nothing about PTY/terminal
handling changes.

---

## 6. Assignment Service

Deterministic first, advisory-LLM second:

```
pickAgent(task):
  1. if human pinned an agent on the task → that agent (must be enabled)
  2. else per-kind preference table (user-configurable):
       code  → [claude, codex, gemini, …]
       test  → [codex, claude, …]
       docs  → [gemini, …]
       review→ [different from the author agent, if possible]
  3. filter: enabled (Phase-1 registry), not over capacity
     (capacity = maxSessionsPerAgent setting, default 2)
  4. tie-break: fewest currently-assigned tasks, then registry order
```

The planner's `suggestedAgentKey` is shown in the UI as a hint, never silently obeyed —
avoiding "automatic agent selection" as a black box while still automating the boring case.

---

## 7. Execution & Supervision

### 7.1 Scheduling loop
- In-process `setInterval` tick (1 s) inside the Orchestrator — same process as
  `ProcessManager` (single source of truth; no jobs queue, per §36 of the original spec).
- Each tick: move `blocked → ready` when all deps `done`; assign + launch ready tasks while
  `running < goal.concurrency_limit` (global default 3, per-goal override ≤ 6).
- Launch = Phase-1 `launch(workspaceId, agentId, worktreeId)` + task prompt written to the
  PTY as stdin (a `task.brief` message type), or appended args for CLIs with headless modes
  (`claude -p`, `codex exec`) — launcher abstraction gains a `headless` strategy per agent.

### 7.2 Progress classification (deterministic, not LLM)
Reuses Phase-1 signals only:
- `terminal.activity` beacons → liveness
- `computeStuckSignals()` score ≥ medium for 10 min → candidate-stuck
- process exit code (Phase-1 already classifies STOPPED vs CRASHED)
- *work-based* signal (optional, opt-in): `git status --porcelain` in the task worktree is
  unchanged for N minutes while status=running → "no file progress" hint shown to the human

### 7.3 Failure & retry (with hard budget stop)
```
onExit(task):
  CRASHED or non-zero →
    goal.failedAttempts++                      // goal-level counter
    if goal.failedAttempts ≥ goal.attemptBudget (default 10):
      PAUSE the goal: no new task launches; running tasks finish or are stopped;
      status='failed'; HIGH-severity notification with the failure summary.
      (Owner decision 2026-09-15: HARD STOP — runaway cost is unacceptable.)
      Human resumes via /goals/:id/start after reviewing (budget resets on resume).
    attempts++
    if attempts ≤ maxRetries (default 2):
      relaunch in SAME worktree (work is kept!), prompt gets:
        "Previous attempt failed: <exit code, last 80 lines of ring buffer>. "
        "Diagnose and continue. Do not discard prior work."
    else → status=dead, goal-level notification (HIGH severity)
  STOPPED (user stopped it) → status stays assigned/paused, no retry
```

### 7.4 Cancellation
`cancel goal` → graceful-stop all running task sessions (Phase-1 `stop()`), tasks →
`cancelled`, worktrees kept (dirty-safe). Human decides what to keep. No auto-cleanup.

---

## 8. The Merge Problem (the heart of Phase 2)

Phase-1 guarantee: every task edits its own worktree/branch. Phase 2 must combine N branches.

**Policy: rebase-style linearization with machine checks, human gate before anything lands.**

1. **Order**: topological order of the task graph; within a level, lowest-risk first.
2. **Preflight** per branch (machine, in the worktree — cheap):
   - `git merge-tree` (or throwaway temp index) base→branch vs already-merged set
   - run the task's `acceptance` checks: tests/lint/build commands configured per workspace
     (`.forge/verify.json`, see §9)
3. **Human Gate 2 (default)**: UI shows, per branch: the Phase-1 diff view, verification
   results, conflicts (if any). Approve → merge. Reject → task reopens with the reviewer's
   note appended to the prompt.
4. **Autonomous mode (opt-in only)**: branches with `risk=low` AND green checks AND no
   conflicts may auto-merge, each merge creating a revert-point commit (`--no-ff`), and a
   notification per merge. `high`-risk tasks always require the human gate, regardless of
   mode.
5. **Conflicts are never auto-resolved.** A conflicting task gets a new child task
   "resolve conflict of X after Y merged" — assigned to the same agent that wrote X, with
   both diffs in context. (Auto conflict resolution is explicitly out of scope even in
   Phase 2 — the failure modes are too expensive.)

---

## 9. Verification

Two layers, both stored in `goal_tasks.verification_json`:

1. **Machine checks** — `.forge/verify.json` in the workspace:
```json
{
  "checks": [
    { "name": "unit", "cmd": "npm test", "when": ["code", "test"] },
    { "name": "lint", "cmd": "npm run lint", "when": ["code"] },
    { "name": "build", "cmd": "npm run build", "when": ["code"] }
  ]
}
```
   Run **inside the task worktree** via the existing `execFile` patterns, 10-min timeout,
   output truncated to 50 KB into verification_json. Deterministic, cheap, replayable.
2. **Agent review — ON by default** (owner decision, 2026-09-15): every `code` task
   automatically gets a `review` task inserted after it; a *different* agent is launched in
   the same worktree with the diff (via Phase-1 `getWorktreeDiff`) and a review prompt; its
   exit + a structured verdict fence are recorded. Goals may opt OUT via a per-goal toggle.
   Review agents never edit files (prompt-level constraint + post-hoc
   `git status` check that the worktree is unchanged — violation → review discarded,
   event emitted).

---

## 10. The Autonomy Dial

| Mode | Plan | Assign | Retry | Merge low-risk | Merge high-risk |
|---|---|---|---|---|---|
| `gated` (default) | human approves | human may override | auto ≤ 2 | human | human |
| `semi` | human approves | auto | auto ≤ 2 | auto (green checks) | human |
| `auto` | human approves once | auto | auto ≤ 3 | auto | auto + notification |

Even in `auto`, these ALWAYS require a human: plan approval, conflicts, dirty-worktree
removal, and anything touching the main working tree. This is the codification of "never
silently destroy work."

---

## 11. API & UI Extensions

### REST (under `/api/orchestrator`)
```
POST /goals                      { workspaceId, title, description, plannerDefinitionId }
GET  /goals/:id                  goal + tasks + timeline
POST /goals/:id/plan             run planner
POST /goals/:id/plan/approve     { editedPlan? }      ← Gate 1
POST /goals/:id/start
POST /goals/:id/cancel
POST /goals/:id/tasks/:taskId/retry | reassign { agentId } | pin { agentId }
GET  /goals/:id/tasks/:taskId/verification
POST /goals/:id/merge/:taskId    { approve: true }    ← Gate 2
GET  /goals/:id/timeline
```

### WebSocket
- New event types on the existing `manager.event` channel:
  `goal.created / goal.plan_ready / goal.awaiting_approval / goal.task_started /
   goal.task_failed / goal.task_done / goal.needs_review / goal.merged / goal.completed`
- Reuse of the unread-dot + notification layer verbatim (Phase-1 §14/§15/§16 wiring —
  including the fixed dedicated channels).

### UI
- **Goals panel** (new sidebar section above Agent Registry): goal cards with progress
  (tasks done / total), current activity, per-task status chips (reusing `status-pill`).
- **Goal detail view**: task graph (left, simple list first — no graph library), task detail
  = the existing `SessionDetail` + verification + worktree diff (all existing components).
- **Plan editor**: editable task list at Gate 1 (form-based, Phase-1 modal patterns).
- Terminal watching of any task = the existing TerminalModal, zero changes.

---

## 12. Explicit Non-Goals & Honest Rationale

### 12.1 Not in Phase 2
- **Automated conflict resolution** — error-prone; a mis-merge costs hours. Human/rescue-task instead.
- **Cross-goal global scheduler** — one active goal per workspace at a time in v1; parallel goals on different workspaces work naturally (separate worktree trees).
- **Agent-to-agent chat** — no measurable coding benefit; adds nondeterminism.
- **Custom model hosting / new AI SDKs** — violates "the agents are the LLM" principle.

### 12.2 Memory graph — deferred, with reasoning
The original spec lists a "memory graph" as Phase-2-able. This design defers it because:
(a) the CLI agents already persist their own session history and FORGE can resume it
(Phase-1 §23 resume matrix); (b) cross-project memory showed no validated need yet;
(c) SQLite + goal_events already provides the auditable "what happened" record. If a need
emerges (e.g. recurring goals on the same repo), the right v1 shape is a plain
`goal_notes` table queried by the planner prompt — not a graph database.

---

## 13. Implementation Plan (when the gate opens)

Ordered, each independently shippable behind the Phase-1 UI:

| Stage | Deliverable | Rough size | Depends on |
|---|---|---|---|
| P2-1 | Tables + goal CRUD + timeline events + Goals panel (no planning) | M | — |
| P2-2 | PlannerService + PlanSchema + plan extractor + plan editor + Gate 1 | M-L | P2-1 |
| P2-3 | TaskQueue + AssignmentService + Supervisor + retry; worktree-per-task via P1 APIs | L | P2-2 |
| P2-4 | Verification (`.forge/verify.json` runner) + review-task flow | M | P2-3 |
| P2-5 | MergeGate + Gate 2 UI + autonomy dial | M | P2-4 |
| P2-6 | Notifications grouping, goal archive/export, polish | S | P2-5 |

Testing strategy mirrors Phase-1 validation: deterministic fake agents (headless `echo`
plan / scripted workers), temp git repos, the 45-test suite + probe harness extended with
goal-lifecycle scenarios; the full Phase-1 regression suite must stay green at every stage.

---

## 14. Risks & Open Questions

| Risk | Mitigation |
|---|---|
| Planner output too vague → tasks fail | Strict schema + human Gate 1; goal can be edited & re-planned |
| Worker "completes" without doing work | Machine verification is the arbiter, not agent claims (§9) |
| Runaway cost (many agents) | Global concurrency cap, per-agent capacity, per-goal budget field (v1.1) |
| Headless CLI flags drift between versions | Launcher `headless` strategy versioned per agent; probe test on boot (pattern: Phase-1 seed verification) |
| Windows ConPTY still unverified | **Gate item** — P2 starts only after the manual pass |
| Prompt-injection via repo content into planner | Planner runs read-only conceptually; Gate 1 review; never auto-merge on its output |

Open questions — **RESOLVED by owner, 2026-09-15:**
1. Planner agent? → **Chosen per goal** via dropdown at goal creation (default configurable in settings)
2. Review tasks? → **ON by default** for every code task; per-goal opt-out toggle
3. Budget guardrail? → **Hard stop**: goal-level failed-attempt budget (default 10) pauses the goal and notifies; human resumes
```
