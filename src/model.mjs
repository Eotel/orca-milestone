const asking = (row) => row.agents.some((agent) => agent.state === 'waiting' || agent.state === 'blocked')

export function buildModel(focused, workspaces, turn, now) {
  return {
    focused: focused ? workspaces.find((row) => row.path === focused.path) ?? null : null,
    others: workspaces
      .filter((row) => row.path !== focused?.path && (asking(row) || row.steps.total > 0 && (row.agents.length > 0 || row.steps.done < row.steps.total)))
      .sort((a, b) => Number(asking(b)) - Number(asking(a)) || Number(Boolean(b.next)) - Number(Boolean(a.next))),
    turn,
    now
  }
}
