type AgentDebugEvent = {
  hypothesisId: string
  location: string
  message: string
  data: Record<string, unknown>
}

const clientRunId = crypto.randomUUID().slice(0, 8)

export function agentDebugLog(event: AgentDebugEvent) {
  // #region agent log
  void fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({
      action: 'debug_log',
      event: {
        ...event,
        data: { clientRunId, ...event.data },
        timestamp: Date.now(),
      },
    }),
  }).catch(() => {})
  // #endregion
}
