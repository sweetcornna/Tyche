export const MESSAGE_LIMIT = 8000
export const ATTACHMENT_LIMIT = 4
export const QUEUE_LIMIT = 3
export const emptyDraft = () => ({ text: '', attachments: [] })
export const composeMessage = (draft) => [draft.text.trim(), ...draft.attachments.map((file) => `附件：${file.name}\n\n${file.text}`)].filter(Boolean).join('\n\n')
export function draftError(draft) {
  if (draft.attachments.length > ATTACHMENT_LIMIT) return '最多添加 4 个文本文件。'
  if (composeMessage(draft).length > MESSAGE_LIMIT) return '消息与附件合计不能超过 8000 字符。'
  return ''
}

// Drafts and explicitly submitted follow-ups stay in this page's memory.
// Each queue item is bound to its conversation; failures pause only that queue.
export function createComposerState() {
  const drafts = new Map(), queues = new Map(), paused = new Set()
  let epoch = 0
  return {
    get epoch() { return epoch },
    draft: (id) => structuredClone(drafts.get(id) || emptyDraft()),
    update(id, patch) { const next = { ...(drafts.get(id) || emptyDraft()), ...patch }; drafts.set(id, structuredClone(next)); return this.draft(id) },
    take(id) { const value = this.draft(id); drafts.delete(id); return value },
    restoreIfEmpty(id, draft) { if (!composeMessage(this.draft(id))) this.update(id, draft) },
    enqueue(id, draft) {
      const message = composeMessage(draft), error = draftError(draft)
      if (!id || !message) throw new Error('消息不能为空。')
      if (error) throw new Error(error)
      const rows = queues.get(id) || []
      if (rows.length >= QUEUE_LIMIT) throw new Error('最多排队 3 条消息。')
      const item = { id: crypto.randomUUID(), conversationId: id, message, draft: structuredClone(draft) }
      queues.set(id, [...rows, item]); return item
    },
    items: (id) => structuredClone(queues.get(id) || []),
    pause: (id) => paused.add(id),
    resume: (id) => paused.delete(id),
    paused: (id) => paused.has(id),
    next(id) { if (paused.has(id)) return null; return queues.get(id)?.shift() || null },
    remove(id, itemId) { queues.set(id, (queues.get(id) || []).filter((item) => item.id !== itemId)) },
    pauseAll() { for (const id of queues.keys()) paused.add(id) },
    clearQueue() { queues.clear(); paused.clear() },
    clear() { epoch++; drafts.clear(); this.clearQueue() }
  }
}

export function groupConversations(rows, archived, now = new Date()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0)
  const week = new Date(today); week.setDate(week.getDate() - 6)
  const groups = new Map(['置顶', '今天', '最近 7 天', '更早'].map((label) => [label, []]))
  for (const row of rows.filter((r) => r.archived === archived).sort((a, b) => b.updated_at - a.updated_at)) {
    const label = row.pinned && !archived ? '置顶' : row.updated_at >= today.getTime() ? '今天' : row.updated_at >= week.getTime() ? '最近 7 天' : '更早'
    groups.get(label).push(row)
  }
  return [...groups].filter(([, items]) => items.length).map(([label, items]) => ({ label, items }))
}
