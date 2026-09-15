'use client'

import { useCallback, useEffect, useState } from 'react'
import { Check, ListChecks, Play, Plus, RefreshCw, RotateCcw, Square, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import type { AgentDefinition, Goal, GoalDetail, GoalStatus, GoalTask, Workspace } from '@/lib/types'

const STATUS_COLORS: Record<string, string> = {
  draft: '#6c7a8d', planning: '#efad68', awaiting_plan_approval: '#efad68',
  ready: '#6faaff', running: '#50d79d', awaiting_review: '#b391ff',
  merging: '#b391ff', complete: '#4dd4a4', failed: '#ed777d', cancelled: '#6c7a8d',
}

const TASK_STATUS_COLORS: Record<string, string> = {
  blocked: '#536173', ready: '#6faaff', assigned: '#efad68', running: '#50d79d',
  done: '#4dd4a4', failed: '#ed777d', dead: '#ed777d', cancelled: '#536173',
}

interface PlanTaskDraft {
  key: string; title: string; description: string;
  kind: 'code' | 'test' | 'docs' | 'review' | 'chore';
  dependsOn: string[]; risk: 'low' | 'medium' | 'high';
}

export function GoalsView({ workspaces, agents, onFlash, onOpenTerminal }: {
  workspaces: Workspace[]
  agents: AgentDefinition[]
  onFlash: (message: string, tone?: 'success' | 'error') => void
  onOpenTerminal: (sessionId: string) => void
}) {
  const [goals, setGoals] = useState<Goal[]>([])
  const [selectedGoalId, setSelectedGoalId] = useState<string>('')
  const [detail, setDetail] = useState<GoalDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newWorkspaceId, setNewWorkspaceId] = useState('')
  const [newPlannerId, setNewPlannerId] = useState('')
  const [planDraft, setPlanDraft] = useState<PlanTaskDraft[] | null>(null)
  const [busy, setBusy] = useState(false)

  const plannerCandidates = agents.filter((agent) => agent.enabled)
  const enabledAgents = agents.filter((agent) => agent.enabled)

  const refreshGoals = useCallback(async () => {
    try { setGoals(await api<Goal[]>('/api/orchestrator/goals')) } catch { /* manager unreachable */ }
  }, [])

  const refreshDetail = useCallback(async (goalId: string) => {
    try { setDetail(await api<GoalDetail>(`/api/orchestrator/goals/${goalId}`)) } catch { /* deleted? */ }
  }, [])

  useEffect(() => { void refreshGoals() }, [refreshGoals])
  useEffect(() => {
    if (selectedGoalId) void refreshDetail(selectedGoalId)
    else setDetail(null)
  }, [selectedGoalId, refreshDetail])
  // Keep the open goal's task statuses fresh (cheap poll; P1 uses 30s for state).
  useEffect(() => {
    if (!selectedGoalId) return
    const timer = window.setInterval(() => void refreshDetail(selectedGoalId), 5000)
    return () => window.clearInterval(timer)
  }, [selectedGoalId, refreshDetail])

  async function createGoal() {
    if (!newWorkspaceId) { onFlash('Choose a workspace for the goal', 'error'); return }
    setBusy(true)
    try {
      const goal = await api<Goal>('/api/orchestrator/goals', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: newWorkspaceId,
          title: newTitle,
          description: newDescription,
          plannerDefinitionId: newPlannerId || undefined,
        }),
      })
      onFlash('Goal created')
      setCreating(false)
      setNewTitle(''); setNewDescription(''); setNewPlannerId('')
      await refreshGoals()
      setSelectedGoalId(goal.id)
    } catch (error) {
      onFlash(error instanceof Error ? error.message : 'Create failed', 'error')
    } finally { setBusy(false) }
  }

  async function runPlanner() {
    if (!detail) return
    const plannerId = detail.goal.planner_definition_id ?? newPlannerId ?? plannerCandidates[0]?.id
    if (!plannerId) { onFlash('No planner agent available', 'error'); return }
    setBusy(true)
    try {
      await api(`/api/orchestrator/goals/${detail.goal.id}/plan`, {
        method: 'POST', body: JSON.stringify({ plannerDefinitionId: plannerId }),
      })
      onFlash('Planner launched — watch its terminal, then Extract plan')
      await refreshDetail(detail.goal.id)
      await refreshGoals()
    } catch (error) {
      onFlash(error instanceof Error ? error.message : 'Plan failed', 'error')
    } finally { setBusy(false) }
  }

  async function extractPlan() {
    if (!detail) return
    setBusy(true)
    try {
      const result = await api<{ status: 'extracted' | 'pending'; goal: Goal }>(`/api/orchestrator/goals/${detail.goal.id}/plan/extract`, { method: 'POST' })
      if (result.status === 'extracted') {
        const plan = JSON.parse(result.goal.plan_json ?? '{}') as { tasks?: PlanTaskDraft[] }
        setPlanDraft(plan.tasks ?? [])
        onFlash('Plan extracted — review and approve')
      } else {
        onFlash('No forge-plan block found yet — give the planner more time', 'error')
      }
      await refreshDetail(detail.goal.id)
    } catch (error) {
      onFlash(error instanceof Error ? error.message : 'Extract failed', 'error')
    } finally { setBusy(false) }
  }

  async function approvePlan() {
    if (!detail || !planDraft) return
    setBusy(true)
    try {
      await api(`/api/orchestrator/goals/${detail.goal.id}/plan/approve`, {
        method: 'POST', body: JSON.stringify({ plan: { summary: 'approved', tasks: planDraft } }),
      })
      onFlash('Plan approved — tasks created (Gate 1 passed)')
      setPlanDraft(null)
      await refreshDetail(detail.goal.id)
      await refreshGoals()
    } catch (error) {
      onFlash(error instanceof Error ? error.message : 'Approve failed', 'error')
    } finally { setBusy(false) }
  }

  async function launchTask(task: GoalTask) {
    if (!detail) return
    const agentId = task.assigned_definition_id ?? enabledAgents[0]?.id
    if (!agentId) { onFlash('No agent available to run this task', 'error'); return }
    setBusy(true)
    try {
      const updated = await api<GoalTask>(`/api/orchestrator/goals/${detail.goal.id}/tasks/${task.id}/launch`, {
        method: 'POST', body: JSON.stringify({ agentDefinitionId: agentId }),
      })
      onFlash(`Task launched on ${updated.branch ?? 'worktree'}`)
      if (updated.session_id) onOpenTerminal(updated.session_id)
      await refreshDetail(detail.goal.id)
      await refreshGoals()
    } catch (error) {
      onFlash(error instanceof Error ? error.message : 'Launch failed', 'error')
    } finally { setBusy(false) }
  }

  async function retryTask(task: GoalTask) {
    if (!detail) return
    setBusy(true)
    try {
      await api(`/api/orchestrator/goals/${detail.goal.id}/tasks/${task.id}/retry`, {
        method: 'POST', body: JSON.stringify({}),
      })
      onFlash('Task retry launched')
      await refreshDetail(detail.goal.id)
    } catch (error) {
      onFlash(error instanceof Error ? error.message : 'Retry failed', 'error')
    } finally { setBusy(false) }
  }

  async function cancelGoal() {
    if (!detail || !window.confirm('Cancel this goal? Running task agents will be stopped.')) return
    setBusy(true)
    try {
      await api(`/api/orchestrator/goals/${detail.goal.id}/cancel`, { method: 'POST' })
      onFlash('Goal cancelled')
      await refreshDetail(detail.goal.id)
      await refreshGoals()
    } catch (error) {
      onFlash(error instanceof Error ? error.message : 'Cancel failed', 'error')
    } finally { setBusy(false) }
  }

  async function deleteGoal() {
    if (!detail || !window.confirm('Delete this goal and its task history?')) return
    setBusy(true)
    try {
      await api(`/api/orchestrator/goals/${detail.goal.id}`, { method: 'DELETE' })
      setSelectedGoalId('')
      await refreshGoals()
      onFlash('Goal deleted')
    } catch (error) {
      onFlash(error instanceof Error ? error.message : 'Delete failed', 'error')
    } finally { setBusy(false) }
  }

  function editPlanTask(index: number, patch: Partial<PlanTaskDraft>) {
    setPlanDraft((current) => (current ?? []).map((task, i) => (i === index ? { ...task, ...patch } : task)))
  }

  const goalStatusColor = (status: GoalStatus) => STATUS_COLORS[status] ?? '#6c7a8d'

  return (
    <div className="goals-layout">
      <aside className="goals-list">
        <div className="section-label"><span>GOALS</span><span>{goals.length}</span></div>
        {goals.length === 0 && <div className="empty-state small">No goals yet. Create one to plan work with agents.</div>}
        {goals.map((goal) => (
          <button key={goal.id} className={`goal-item ${goal.id === selectedGoalId ? 'active' : ''}`} onClick={() => setSelectedGoalId(goal.id)}>
            <span className="goal-status-dot" style={{ background: goalStatusColor(goal.status) }} />
            <span className="goal-copy"><b>{goal.title}</b><small>{goal.status.replace(/_/g, ' ')} · {goal.failed_attempts}/{goal.attempt_budget} fails</small></span>
          </button>
        ))}
        <button className="new-workspace" onClick={() => setCreating((value) => !value)}><Plus /> New goal</button>
        {creating && (
          <div className="goal-create-form">
            <input className="form-input" placeholder="Goal title" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} />
            <textarea className="form-input" rows={4} placeholder="Describe the goal for the planner…" value={newDescription} onChange={(event) => setNewDescription(event.target.value)} />
            <select className="form-input" value={newWorkspaceId} onChange={(event) => setNewWorkspaceId(event.target.value)}>
              <option value="">Choose workspace…</option>
              {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
            <select className="form-input" value={newPlannerId} onChange={(event) => setNewPlannerId(event.target.value)}>
              <option value="">Planner (choose per goal)…</option>
              {plannerCandidates.map((agent) => <option key={agent.id} value={agent.id}>{agent.display_name}</option>)}
            </select>
            <button className="primary-button" disabled={busy || !newTitle} onClick={() => void createGoal()}><Check /> Create goal</button>
          </div>
        )}
      </aside>

      <section className="goal-detail">
        {!detail ? (
          <div className="empty-state">Select or create a goal. Goals are planned by an agent you choose, approved by you (Gate 1), then executed task-by-task in isolated worktrees.</div>
        ) : (
          <>
            <div className="mission-banner">
              <div>
                <div className="eyebrow"><span className="eyebrow-line" /> ADVANCED CODING · GOAL</div>
                <h1>{detail.goal.title}</h1>
                <p>{detail.goal.description || 'No description.'}</p>
              </div>
              <div className="banner-actions">
                <span className="status-pill" style={{ color: goalStatusColor(detail.goal.status), borderColor: goalStatusColor(detail.goal.status) }}>{detail.goal.status.replace(/_/g, ' ')}</span>
                {(detail.goal.status === 'draft' || detail.goal.status === 'awaiting_plan_approval' || detail.goal.status === 'failed') && (
                  <button className="secondary-button" disabled={busy} onClick={() => void runPlanner()}><RefreshCw /> {detail.goal.status === 'failed' ? 'Re-plan' : 'Run planner'}</button>
                )}
                {detail.goal.status === 'planning' && (
                  <button className="secondary-button" disabled={busy} onClick={() => void extractPlan()}><ListChecks /> Extract plan</button>
                )}
                {['ready', 'running', 'awaiting_review', 'failed'].includes(detail.goal.status) && (
                  <button className="secondary-button" disabled={busy} onClick={() => void cancelGoal()}><Square /> Cancel goal</button>
                )}
                {['cancelled', 'complete', 'failed'].includes(detail.goal.status) && (
                  <button className="danger-button" disabled={busy} onClick={() => void deleteGoal()}><Trash2 /> Delete</button>
                )}
              </div>
            </div>

            <section className="panel">
              <div className="panel-heading"><div><div className="panel-kicker">TASKS</div><h2>{detail.tasks.length} task{detail.tasks.length === 1 ? '' : 's'}</h2><p>Each task runs in its own git worktree + branch. Launch is manual in this phase.</p></div></div>
              <div className="goal-tasks">
                {detail.tasks.length === 0 && <div className="empty-state small">No tasks yet — run the planner, then extract and approve its plan.</div>}
                {detail.tasks.map((task) => {
                  const color = TASK_STATUS_COLORS[task.status] ?? '#6c7a8d'
                  const live = ['running', 'assigned'].includes(task.status)
                  return (
                    <div className="goal-task-row" key={task.id}>
                      <span className="goal-status-dot" style={{ background: color }} />
                      <div className="goal-task-copy">
                        <b>{task.title}</b>
                        <small>{task.plan_key} · {task.kind} · risk {task.risk}{task.branch ? ` · ${task.branch}` : ''}{task.status === 'blocked' ? ` · waits for ${task.depends_on_json}` : ''}</small>
                      </div>
                      <span className="status-pill" style={{ color, borderColor: color }}>{task.status}</span>
                      {task.status === 'ready' && <button className="secondary-button" disabled={busy} onClick={() => void launchTask(task)}><Play /> Launch</button>}
                      {['failed', 'dead'].includes(task.status) && <button className="secondary-button" disabled={busy} onClick={() => void retryTask(task)}><RotateCcw /> Retry</button>}
                      {live && task.session_id && <button className="secondary-button" onClick={() => onOpenTerminal(task.session_id!)}>Terminal</button>}
                    </div>
                  )
                })}
              </div>
            </section>

            {planDraft && (
              <section className="panel">
                <div className="panel-heading"><div><div className="panel-kicker">GATE 1 — PLAN REVIEW</div><h2>Edit the plan before approval</h2><p>Adjust titles/risks, remove tasks. Dependencies are preserved from the plan.</p></div>
                  <div className="heading-actions">
                    <button className="secondary-button" onClick={() => setPlanDraft(null)}>Discard</button>
                    <button className="primary-button" disabled={busy} onClick={() => void approvePlan()}><Check /> Approve plan</button>
                  </div>
                </div>
                <div className="goal-tasks">
                  {planDraft.map((task, index) => (
                    <div className="goal-task-row" key={task.key}>
                      <span className="goal-status-dot" style={{ background: '#efad68' }} />
                      <div className="goal-task-copy">
                        <input className="form-input" value={task.title} onChange={(event) => editPlanTask(index, { title: event.target.value })} />
                        <small>{task.key} · depends on {task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'nothing'}</small>
                      </div>
                      <select className="form-input" value={task.risk} onChange={(event) => editPlanTask(index, { risk: event.target.value as PlanTaskDraft['risk'] })}>
                        <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
                      </select>
                      <button className="agent-delete-button" aria-label={`Remove task ${task.key}`} onClick={() => setPlanDraft((current) => (current ?? []).filter((_, i) => i !== index))}><Trash2 /></button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="panel">
              <div className="panel-heading"><div><div className="panel-kicker">TIMELINE</div><h2>Activity</h2></div></div>
              <div className="goal-timeline">
                {detail.events.length === 0 && <div className="empty-state small">No activity yet.</div>}
                {detail.events.map((event) => (
                  <div className="goal-event-row" key={event.id}>
                    <code>{event.type}</code>
                    <span>{new Date(event.created_at).toLocaleTimeString()}</span>
                    <small>{event.payload_json !== '{}' ? event.payload_json : ''}</small>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </section>
    </div>
  )
}
