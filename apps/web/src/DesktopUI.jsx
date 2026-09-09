import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Icon } from './Icon.jsx'
import { composeMessage, draftError, groupConversations, MESSAGE_LIMIT } from './composer-state.js'

export function useNarrowLayout() {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 900px)').matches)
  useEffect(() => { const query = window.matchMedia('(max-width: 900px)'); const update = () => setNarrow(query.matches); query.addEventListener('change', update); return () => query.removeEventListener('change', update) }, [])
  return narrow
}
function usePanelFocus(ref, active) {
  useEffect(() => {
    if (!active || !ref.current) return
    const opener = document.activeElement, root = ref.current
    root.querySelector('button:not(:disabled)')?.focus()
    const trap = (e) => {
      if (e.key !== 'Tab' || document.querySelector('dialog[open]')) return
      const controls = [...root.querySelectorAll('button:not(:disabled),summary,input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter((el) => el.getClientRects().length && !el.closest('[inert]'))
      const first = controls[0], last = controls.at(-1)
      if (!first) { e.preventDefault(); return }
      if (!root.contains(document.activeElement) || (e.shiftKey && document.activeElement === first)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', trap)
    return () => { window.removeEventListener('keydown', trap); if (opener?.isConnected && root.contains(document.activeElement) && !document.querySelector('dialog[open]')) opener.focus() }
  }, [active, ref])
}

export function IconButton({ icon, label, ...props }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} {...props}><Icon name={icon} /></button>
}

export function Dialog({ open, onClose, onAfterClose, title, className = '', children }) {
  const ref = useRef(null)
  const returnFocus = useRef(null)
  const lastChildren = useRef(children)
  const afterClose = useRef(onAfterClose)
  afterClose.current = onAfterClose
  if (open) lastChildren.current = children
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (open) { setMounted(true); return }
    setVisible(false)
    const timeout = setTimeout(() => { ref.current?.close(); setMounted(false); if (returnFocus.current?.isConnected) returnFocus.current.focus(); afterClose.current?.() }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160)
    return () => clearTimeout(timeout)
  }, [open])
  useLayoutEffect(() => {
    if (!mounted || !open) return
    returnFocus.current = document.activeElement
    ref.current?.showModal()
    const frame = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(frame)
  }, [mounted, open])
  return mounted ? <dialog ref={ref} aria-label={title} className={`desktop-dialog ${visible ? 'is-visible' : ''} ${className}`} onCancel={(e) => { e.preventDefault(); onClose() }} onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>{open ? children : lastChildren.current}</dialog> : null
}

export function ResizeHandle({ side, value, onChange, min, max }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(null)
  return <div role="separator" aria-label={side === 'left' ? '侧栏宽度' : '详情宽度'} aria-orientation="vertical" aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max} tabIndex={0} className={`resize-handle ${side} ${dragging ? 'is-dragging' : ''}`} onPointerDown={(e) => { origin.current = { x: e.clientX, value }; e.currentTarget.setPointerCapture(e.pointerId); setDragging(true) }} onPointerMove={(e) => { if (origin.current) onChange(Math.min(max, Math.max(min, origin.current.value + (e.clientX - origin.current.x) * (side === 'left' ? 1 : -1)))) }} onPointerUp={() => { origin.current = null; setDragging(false) }} onLostPointerCapture={() => { origin.current = null; setDragging(false) }} onKeyDown={(e) => { if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return; e.preventDefault(); onChange(Math.min(max, Math.max(min, value + (e.key === 'ArrowLeft' ? -16 : 16) * (side === 'left' ? 1 : -1)))) }} />
}

export function DetailPanel({ open, narrow, children }) {
  const [mounted, setMounted] = useState(open)
  const lastChildren = useRef(children), opener = useRef(null), ref = useRef(null)
  if (open) lastChildren.current = children
  usePanelFocus(ref, open && mounted && narrow)
  useEffect(() => {
    if (open) { opener.current = document.activeElement; setMounted(true); return }
    if (opener.current?.isConnected && ref.current?.contains(document.activeElement)) opener.current.focus()
    const timer = setTimeout(() => setMounted(false), 300)
    return () => clearTimeout(timer)
  }, [open])
  return mounted ? <aside ref={ref} className={`desktop-detail ${open ? '' : 'is-closing'}`} aria-label="运行与场景" inert={open ? undefined : ''} aria-hidden={!open}>{open ? children : lastChildren.current}</aside> : null
}

export function DesktopSidebar({ collapsed, narrow, rows, current, archived, onArchived, onNew, onSearch, onSelect, onUpdate, onRename, onSettings, onScene, connected, busy, onClose }) {
  const groups = groupConversations(rows, archived)
  const ref = useRef(null)
  usePanelFocus(ref, narrow && !collapsed)
  return <aside ref={ref} className="desktop-sidebar" aria-label="侧栏" inert={collapsed ? '' : undefined} aria-hidden={collapsed}>
    <div className="sidebar-brand"><span className="tyche-logo">τ</span><strong>Tyche</strong><IconButton icon="sidebar" label="收起侧栏" onClick={onClose} /></div>
    <nav className="primary-navigation" aria-label="工作台导航">
      <button onClick={onNew} disabled={busy}><Icon name="plus" /><span>新对话</span><kbd>⌘N</kbd></button>
      <button onClick={onSearch}><Icon name="search" /><span>搜索</span><kbd>⌘K</kbd></button>
      <button onClick={() => onScene('workflow')}><Icon name="workflow" /><span>工作流</span></button>
      <button onClick={() => onScene('trading')}><Icon name="positions" /><span>持仓</span></button>
    </nav>
    <div className="history-heading"><span>{archived ? '归档' : '对话'}</span><IconButton icon={archived ? 'chat' : 'archive'} label={archived ? '返回对话' : '查看归档'} onClick={() => onArchived(!archived)} /></div>
    <nav className="conversation-list" aria-label="对话历史">
      {groups.length === 0 && <span className="muted-empty">{archived ? '暂无归档' : '暂无对话'}</span>}
      {groups.map((group) => <div className="history-group" key={group.label}><div className="history-group-label">{group.label}</div>{group.items.map((row) => <div key={row.id} className={`conversation-row ${current === row.id ? 'selected' : ''}`}>
        <button className="conversation-link" disabled={busy} title={row.title} aria-current={current === row.id ? 'page' : undefined} onClick={() => onSelect(row.id)}>{row.pinned && <Icon name="pin" />}<span>{row.title}</span></button>
        <ConversationMenu row={row} busy={busy} onRename={onRename} onUpdate={onUpdate} />
      </div>)}</div>)}
    </nav>
    <div className="sidebar-footer"><button onClick={() => onSettings('settings')}><span className={`connection-dot ${connected ? 'connected' : ''}`} /><span>{connected ? '已连接' : '连接 API'}</span><Icon name="settings" /></button></div>
  </aside>
}

function ConversationMenu({ row, busy, onRename, onUpdate }) {
  const ref = useRef(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const close = (focus = false) => { if (ref.current) { ref.current.open = false; if (focus) ref.current.querySelector('summary').focus() } }
  useEffect(() => {
    const outside = (e) => { if (!ref.current?.contains(e.target)) close() }
    const scroll = (e) => { if (e.target === ref.current?.closest('.conversation-list')) close() }
    const resize = () => close()
    document.addEventListener('pointerdown', outside); document.addEventListener('scroll', scroll, true); window.addEventListener('resize', resize)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', resize) }
  }, [])
  const action = (fn) => { close(true); fn() }
  return <details ref={ref} className="row-menu" onToggle={(e) => {
    if (!e.currentTarget.open) return
    document.querySelectorAll('.row-menu[open]').forEach((el) => { if (el !== ref.current) el.open = false })
    const rect = e.currentTarget.querySelector('summary').getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(window.innerWidth - 178, rect.right - 170)), top: Math.min(window.innerHeight - 133, rect.bottom + 5) })
  }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) close() }} onKeyDown={(e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(true) }
    if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) { e.preventDefault(); const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')]; if (!buttons.length) return; const index = buttons.indexOf(document.activeElement); buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length].focus() }
  }}><summary aria-label={`对话操作：${row.title}`}><Icon name="more" /></summary><div className="menu-surface" style={position}>
    <button disabled={busy} onClick={() => action(() => onRename(row))}><Icon name="edit" />重命名</button>
    <button disabled={busy} onClick={() => action(() => onUpdate(row.id, { pinned: !row.pinned }))}><Icon name="pin" />{row.pinned ? '取消置顶' : '置顶'}</button>
    <button disabled={busy} onClick={() => action(() => onUpdate(row.id, { archived: !row.archived }))}><Icon name="archive" />{row.archived ? '恢复对话' : '归档'}</button>
  </div></details>
}

export function SearchDialog({ open, onClose, results, onQuery, onSelect, commands }) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const chosen = useRef(null)
  useEffect(() => { if (open) { setQuery(''); setIndex(0) } }, [open])
  useEffect(() => { if (!open) return; setIndex(0); const timer = setTimeout(() => onQuery(query), 180); return () => clearTimeout(timer) }, [query, open])
  const matches = results.query === query
  const items = matches && results.status === 'ready' ? results.items : []
  const options = [...commands.filter((row) => row.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map((c) => ({ ...c, id: c.name })), ...items.map((row) => ({ id: row.id, name: row.title, icon: row.archived ? 'archive' : row.pinned ? 'pin' : 'chat', run: () => onSelect(row.id) }))]
  useEffect(() => { setIndex((current) => Math.min(current, Math.max(0, options.length - 1))) }, [options.length])
  useEffect(() => { if (open) document.getElementById(`search-option-${index}`)?.scrollIntoView({ block: 'nearest' }) }, [index, open])
  const choose = (option) => { if (!option) return; chosen.current = option; onClose() }
  return <Dialog open={open} onClose={onClose} onAfterClose={() => { const option = chosen.current; chosen.current = null; option?.run() }} title="搜索与命令" className="search-dialog">
    <div className="search-input-row"><Icon name="search" /><input autoFocus maxLength={200} placeholder="搜索对话或操作…" aria-label="搜索对话或操作" value={query} onChange={(e) => setQuery(e.target.value)} role="combobox" aria-expanded="true" aria-controls="search-results" aria-activedescendant={options[index] ? `search-option-${index}` : undefined} onKeyDown={(e) => {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setIndex((v) => (v + (e.key === 'ArrowDown' ? 1 : -1) + Math.max(1, options.length)) % Math.max(1, options.length)) }
      if (e.key === 'Enter') { e.preventDefault(); choose(options[index]) }
    }} /><kbd>Esc</kbd></div>
    <div className="search-results" role="listbox" id="search-results">{options.map((row, i) => <button id={`search-option-${i}`} role="option" aria-selected={i === index} key={row.id} onMouseMove={() => setIndex(i)} onClick={() => choose(row)}><Icon name={row.icon} /><span>{row.name}</span><Icon name="arrow" /></button>)}</div>
    {(!matches || results.status === 'loading') && <div className="search-feedback" role="status">搜索中…</div>}
    {matches && results.status === 'error' && <div className="search-feedback" role="alert">{results.error}<button onClick={() => onQuery(query)}>重试</button></div>}
    {matches && results.status === 'ready' && !options.length && <p className="muted-empty">没有匹配的对话</p>}
  </Dialog>
}

function CopyButton({ text, label = '复制' }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => { if (!copied) return; const id = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(id) }, [copied])
  return <IconButton icon={copied ? 'check' : 'copy'} label={copied ? '已复制' : failed ? '复制失败，点击重试' : label} onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setFailed(false) } catch { setCopied(false); setFailed(true) } }} />
}
function CodeBlock({ children }) {
  const content = children?.props?.children || ''
  const language = children?.props?.className?.replace('language-', '') || '代码'
  return <div className="code-block"><header><span>{language}</span><CopyButton text={String(content)} label="复制代码" /></header><pre>{children}</pre></div>
}
export function MessageBody({ content }) {
  return <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock, a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />, img: ({ alt }) => <span className="image-label">{alt || '图片'}</span> }}>{content}</Markdown></div>
}
export function ConversationView({ conversationId, messages, pending, onQuote, onEdit, onRetry, busy, error, onDismissError }) {
  const scroll = useRef(null)
  const atBottom = useRef(true)
  const [jump, setJump] = useState(false)
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    if (!pending) { setSeconds(0); return }
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - pending.startedAt) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [pending?.startedAt])
  useLayoutEffect(() => { atBottom.current = true; setJump(false) }, [conversationId])
  useLayoutEffect(() => { if (atBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight }, [messages, pending, error])
  return <div className="thread-viewport"><section className="thread-scroll" ref={scroll} aria-label="对话内容" onScroll={() => { const el = scroll.current; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; setJump(!atBottom.current) }}>
    <div className="message-column">{messages.map((item, index) => <article className={`thread-message ${item.role}`} key={item.id || index}>
      <MessageBody content={item.content} />
      <div className="message-actions"><CopyButton text={item.content} /><IconButton icon="quote" label="引用消息" onClick={() => onQuote(item.content)} />{item.role === 'user' ? <IconButton icon="edit" label="编辑并重发" disabled={busy} onClick={() => onEdit(item.content)} /> : <IconButton icon="retry" label="重新生成" disabled={busy} onClick={() => onRetry(index)} />}</div>
    </article>)}
      {pending && <><article className="thread-message user pending-message"><MessageBody content={pending.message} /></article><div className="response-pending" role="status"><span className="thinking-mark">τ</span><span className="thinking-label">{({ connecting: '连接模型', generating: '正在生成', validating: '整理回复', stopping: '正在停止' })[pending.phase] || '正在生成'}</span><span className="elapsed">{seconds}s</span></div></>}
      {error && <div className="message-error" role="alert"><span>{error.message}</span>{error.retry && <p className="retry-preview">{error.retry.slice(0, 160)}</p>}<div><button onClick={() => onRetry(-1)} disabled={busy}>重试</button><button onClick={onDismissError}>关闭</button></div></div>}
    </div>
    </section>{jump && <button className="jump-bottom" aria-label="跳到最新消息" onClick={() => { scroll.current.scrollTo({ top: scroll.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); atBottom.current = true }}><Icon name="arrowDown" /></button>}
  </div>
}

export function Composer({ draft, onChange, onAddAttachments, onSend, pending, onStop, disabled, model, effort, pool, onModel, connected, onConnect, onWorkflow, archived, onRestore, queue, queuePaused, onResumeQueue, onRemoveQueued }) {
  const input = useRef(null), picker = useRef(null), reading = useRef(false)
  const [fileBusy, setFileBusy] = useState(false), [fileError, setFileError] = useState(''), [dragging, setDragging] = useState(false)
  const { text: value, attachments } = draft
  useLayoutEffect(() => { if (!input.current) return; input.current.style.height = 'auto'; input.current.style.height = `${Math.min(190, Math.max(44, input.current.scrollHeight))}px` }, [value])
  useEffect(() => { if (pending?.requestId && !document.querySelector('dialog[open]')) input.current?.focus() }, [pending?.requestId])
  const combined = composeMessage(draft), validation = draftError(draft)
  const queuing = Boolean(pending) || queue.length > 0
  const addFiles = async (files) => {
    if (reading.current) return
    reading.current = true; setFileBusy(true); setFileError('')
    try {
      const incoming = Array.from(files)
      if (incoming.length + attachments.length > 4) throw new Error('最多添加 4 个文本文件。')
      const rows = await Promise.all(incoming.map(async (file) => { if (!/\.(txt|md|csv|json)$/i.test(file.name) || file.size > 32000) throw new Error('支持 32 KB 内的 TXT、Markdown、CSV、JSON。'); return { id: crypto.randomUUID(), name: file.name.slice(0, 100), text: await file.text() } }))
      const error = onAddAttachments(rows)
      if (error) throw new Error(error)
    } catch (e) { setFileError(e.message) } finally { reading.current = false; setFileBusy(false) }
  }
  const send = () => { if (!combined || disabled || archived || fileBusy) return; if (validation) { setFileError(validation); return }; onSend() }
  const efforts = pool.find((row) => row.id === model)?.efforts || []
  return <div className="desktop-composer-wrap">
    {queue.length > 0 && <div className="message-queue" aria-label="待发送消息"><header><span>待发送 · {queue.length}{queuePaused ? ' · 已暂停' : ''}</span>{queuePaused && <button disabled={Boolean(pending) || disabled} onClick={onResumeQueue}>继续发送</button>}</header>{queue.map((item) => <div key={item.id}><Icon name="chat" /><span title={item.message}>{item.message}</span><IconButton icon="close" label={`移除待发送：${item.message.slice(0, 30)}`} onClick={() => onRemoveQueued(item.id)} /></div>)}</div>}
    {archived ? <div className="archived-state"><Icon name="archive" />已归档<button onClick={onRestore}>恢复对话</button></div> : <form className={`desktop-composer ${dragging ? 'is-dragging' : ''}`} onSubmit={(e) => { e.preventDefault(); send() }} onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragging(true) }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false) }} onDrop={(e) => { e.preventDefault(); setDragging(false); if (!disabled) addFiles(e.dataTransfer.files) }}>
      {attachments.length > 0 && <div className="attachment-list">{attachments.map((file) => <span key={file.id}><Icon name="file" />{file.name}<IconButton icon="close" label={`移除 ${file.name}`} onClick={() => onChange({ attachments: attachments.filter((f) => f.id !== file.id) })} /></span>)}</div>}
      <textarea id="discussion-input" ref={input} aria-label="消息" placeholder={pending ? '继续输入，发送后排队' : connected ? '发送消息，或描述你的策略' : '输入消息…'} value={value} onChange={(e) => { onChange({ text: e.target.value }); setFileError('') }} disabled={disabled} maxLength={MESSAGE_LIMIT} rows={2} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) { e.preventDefault(); if (!e.repeat) send() } }} />
      <div className="composer-action-bar"><div className="composer-tools">
        <IconButton icon="plus" label={fileBusy ? '读取文件中' : '添加文本文件'} disabled={disabled || fileBusy} onClick={() => picker.current?.click()} /><input ref={picker} hidden aria-label="文本文件" tabIndex={-1} type="file" multiple accept=".txt,.md,.csv,.json" onChange={(e) => { addFiles(e.target.files); e.target.value = '' }} />
        {connected ? <><label className="composer-select"><select aria-label="对话模型" value={model} disabled={disabled || Boolean(pending)} onChange={(e) => { const next = pool.find((p) => p.id === e.target.value); onModel(next.id, next.efforts.includes(effort) ? effort : next.efforts[0]) }}>{!pool.some((p) => p.id === model) && <option value={model}>{model} · 不可用</option>}{pool.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}</select><Icon name="chevron" /></label><label className="composer-select effort-select"><select aria-label="推理强度" value={effort} disabled={disabled || Boolean(pending)} onChange={(e) => onModel(model, e.target.value)}>{!efforts.includes(effort) && <option value={effort}>请选择</option>}{efforts.map((v) => <option key={v} value={v}>{({ medium: '中', high: '高', xhigh: '极高' })[v]}</option>)}</select><Icon name="chevron" /></label></> : <button className="connect-inline" type="button" onClick={onConnect}>连接模型<Icon name="chevron" /></button>}
      </div><div className="composer-submit-actions">{pending && <button className="composer-send stop" type="button" aria-label="停止生成" title="停止生成" onClick={onStop} disabled={pending.phase === 'stopping'}><Icon name="stop" /></button>}{(!pending || combined) && <button className={`composer-send ${queuing ? 'enqueue' : ''}`} type="submit" aria-label={queuing ? '加入发送队列' : '发送消息'} title={queuing ? '加入发送队列' : '发送消息'} disabled={disabled || fileBusy || !combined || Boolean(validation)}><Icon name={queuing ? 'plus' : 'send'} /></button>}</div></div>
      {(fileError || validation) && <p className="form-error" role="alert">{fileError || validation}</p>}
    </form>}
    <div className="composer-footer"><button type="button" onClick={onWorkflow}><span className="environment-dot" />Paper<Icon name="chevron" /></button>{combined.length > 7200 && <span className={validation ? 'over-limit' : ''}>{combined.length.toLocaleString()} / 8,000</span>}</div>
  </div>
}
