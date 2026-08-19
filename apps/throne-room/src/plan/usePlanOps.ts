import { ref } from 'vue'

type PlanOpType = 'approve' | 'plan-done'

interface PlanOp {
  type: PlanOpType
  title: string
}

// Module-level so all components share the same list
const ops = ref<PlanOp[]>([])

export function usePlanOps() {
  function record(type: PlanOpType, title: string) {
    ops.value.push({ type, title })
  }

  function buildSummary(): string {
    if (ops.value.length === 0) return ''
    const approvals = ops.value.filter(o => o.type === 'approve').map(o => o.title)
    const planDone  = ops.value.filter(o => o.type === 'plan-done').map(o => o.title)
    const parts: string[] = []
    if (approvals.length) parts.push(`approve: ${approvals.join(', ')}`)
    if (planDone.length)  parts.push(`plan-done: ${planDone.join(', ')}`)
    return parts.join('; ')
  }

  function clear() {
    ops.value = []
  }

  return { ops, record, buildSummary, clear }
}
