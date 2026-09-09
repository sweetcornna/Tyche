import test from 'node:test'
import assert from 'node:assert/strict'
import { createComposerState, composeMessage, draftError, groupConversations, MESSAGE_LIMIT } from '../src/composer-state.js'
const file = { id: 'file-1', name: 'notes.md', text: '附件正文' }

test('drafts retain text and attachments per conversation and do not alias caller data', () => {
  const s = createComposerState(), attachments = [file]
  s.update('one', { text: '草稿一', attachments }); s.update('two', { text: '草稿二' })
  attachments[0] = { ...file, text: 'mutated' }
  assert.equal(s.draft('one').attachments[0].text, '附件正文')
  const taken = s.take('one'); assert.equal(composeMessage(s.draft('one')), '')
  s.update('one', { text: '正在写下一条' }); s.restoreIfEmpty('one', taken)
  assert.equal(s.draft('one').text, '正在写下一条')
  assert.equal(s.draft('two').text, '草稿二')
})

test('failed attachments and Enter submissions use the complete serialized size', () => {
  const draft = { text: 'a'.repeat(MESSAGE_LIMIT - 4), attachments: [file] }
  assert.ok(draftError(draft))
  assert.equal(draftError({ text: 'a'.repeat(MESSAGE_LIMIT), attachments: [] }), '')
  const s = createComposerState()
  assert.throws(() => s.enqueue('one', draft), /8000/)
  assert.equal(s.items('one').length, 0)
  assert.ok(draftError({ text: '', attachments: Array(5).fill(file) }))
})

test('explicitly queued messages drain in order only in their own conversation', () => {
  const s = createComposerState()
  s.enqueue('one', { text: 'first', attachments: [file] }); s.enqueue('one', { text: 'second', attachments: [] })
  s.enqueue('two', { text: 'different', attachments: [] })
  assert.equal(s.next('missing'), null)
  assert.match(s.next('one').message, /^first\n\n附件：notes.md/)
  assert.equal(s.next('one').message, 'second')
  assert.equal(s.items('two')[0].message, 'different')
  assert.equal(s.next('one'), null)
})

test('stopping or failing pauses the queue until explicitly resumed; removals and session clearing cannot replay', () => {
  const s = createComposerState()
  const first = s.enqueue('one', { text: 'one', attachments: [] })
  s.enqueue('one', { text: 'two', attachments: [] }); s.pause('one')
  assert.equal(s.next('one'), null)
  s.remove('one', first.id); s.resume('one')
  assert.equal(s.next('one').message, 'two')
  s.enqueue('one', { text: 'three', attachments: [] })
  s.update('one', { text: '未发送草稿' }); s.clearQueue()
  assert.equal(s.next('one'), null); assert.equal(s.draft('one').text, '未发送草稿')
  s.clear(); assert.equal(s.draft('one').text, '')
})

test('queue cap does not consume or overwrite the draft the user is editing', () => {
  const s = createComposerState()
  for (let i = 0; i < 3; i++) s.enqueue('one', { text: `item-${i}`, attachments: [] })
  s.update('one', { text: '保留此条' })
  assert.throws(() => s.enqueue('one', s.draft('one')), /3/)
  assert.equal(s.draft('one').text, '保留此条')
})

test('history groups pins and local calendar dates, excluding archives from active lists', () => {
  const date = new Date(2030, 0, 10, 12)
  const rows = [{ id: 'old-pin', pinned: true, archived: false, updated_at: new Date(2029, 0, 1).getTime() }, { id: 'today', pinned: false, archived: false, updated_at: date.getTime() }, { id: 'week', pinned: false, archived: false, updated_at: new Date(2030, 0, 5).getTime() }, { id: 'old', pinned: false, archived: false, updated_at: new Date(2029, 0, 1).getTime() }, { id: 'archived', archived: true, updated_at: date.getTime() }]
  assert.deepEqual(groupConversations(rows, false, date).map((g) => [g.label, g.items[0].id]), [['置顶', 'old-pin'], ['今天', 'today'], ['最近 7 天', 'week'], ['更早', 'old']])
  assert.equal(groupConversations(rows, true, date)[0].items[0].id, 'archived')
})

test('reauthentication retains drafts and pauses queued sends; explicit logout invalidates late attachment work', () => {
  const s = createComposerState(), epoch = s.epoch
  s.update('one', { text: 'draft', attachments: [file] }); s.enqueue('one', s.draft('one'))
  s.pauseAll()
  assert.equal(s.next('one'), null); assert.equal(s.items('one').length, 1)
  assert.equal(s.draft('one').attachments.length, 1)
  s.clear(); assert.notEqual(s.epoch, epoch); assert.equal(s.items('one').length, 0)
})
