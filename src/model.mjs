const asking = (row) => row.agents.some((agent) => agent.state === 'waiting' || agent.state === 'blocked')

export function buildModel(focused, workspaces, turn, now) {
  return {
    focused: focused ? workspaces.find((row) => row.path === focused.path) ?? null : null,
    others: workspaces
      .filter((row) => {
        const { agents, steps } = row
        const hasPendingTasks = steps.source === 'tasks' && steps.done < steps.total
        return row.path !== focused?.path && (asking(row) || (steps.total > 0 && (agents.length > 0 || hasPendingTasks)))
      })
      .sort((a, b) => Number(asking(b)) - Number(asking(a)) || Number(Boolean(b.next)) - Number(Boolean(a.next))),
    turn,
    now
  }
}
