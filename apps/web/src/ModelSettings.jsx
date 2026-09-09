import { useEffect, useState } from 'react'
import { WORKFLOW_NODES } from './workflow.js'

const EFFORTS = ['medium', 'high', 'xhigh']
function editable(config) { return { declaration_context: config.declaration_context ? { ...config.declaration_context } : null, pool: config.pool.map(({ id, efforts }) => ({ id, efforts: [...efforts] })), mode: config.mode, bootstrap: { ...config.bootstrap }, role_models: { ...config.effective_models }, role_efforts: { ...config.effective_efforts } } }
export function ModelSettings({ config, busy, onSave, onAllocate }) {
  const [draft, setDraft] = useState(() => editable(config))
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (!dirty) setDraft(editable(config)) }, [config, dirty])
  const update = (next) => { setDirty(true); setDraft(next) }
  const effortsFor = (id) => draft.pool.find((entry) => entry.id === id)?.efforts || []
  const choices = (selected) => <>{!draft.pool.some(({ id }) => id === selected) && <option value={selected}>{selected || '请选择模型'} · 不在当前池中</option>}{draft.pool.map(({ id }, index) => <option key={index} value={id}>{id || '待填写 ID'}</option>)}</>
  const effortChoices = (model, selected) => <>{!effortsFor(model).includes(selected) && <option value={selected}>{selected || '请选择 effort'} · 需修正</option>}{effortsFor(model).map((effort) => <option key={effort}>{effort}</option>)}</>
  const save = async () => {
    const input = { ...(draft.declaration_context ? { declaration_context: draft.declaration_context.id } : {}), pool: draft.pool, mode: draft.mode, bootstrap: draft.bootstrap, ...(draft.mode === 'manual' ? { role_models: draft.role_models, role_efforts: draft.role_efforts } : {}) }
    const result = await onSave(input)
    if (result) { setDraft(editable(result)); setDirty(false) }
  }
  const targetChanged = dirty && draft.declaration_context?.id !== config.declaration_context?.id
  const targetLabel = (context) => context?.kind === 'unbound' ? '未连接' : `${context?.kind === 'pending_catalog' ? '待连接' : '已连接'} · ${context?.protocol || ''} · ${context?.endpoint || ''}`
  return <section className="model-settings"><div className="section-heading"><h2>模型分配</h2><span className="save-state">{dirty ? '未保存' : config.allocation_state === 'ready' ? '已就绪' : config.allocation_state === 'pending' ? '待分配' : '待修正'}</span></div>
    <dl className="connection-target"><dt>服务</dt><dd>{targetLabel(draft.declaration_context)}</dd></dl>
    {targetChanged && <div role="alert"><p className="form-error">连接已变化</p><div>{targetLabel(config.declaration_context)}</div><button type="button" className="quiet-action" disabled={busy || !config.declaration_context} onClick={() => update({ ...draft, declaration_context: { ...config.declaration_context } })}>确认连接</button></div>}

    <details><summary>Anthropic 模型</summary><dl>{(config.protocol_models || []).map(({ id, efforts }) => <div key={id}><dt>{id}</dt><dd>{efforts.join(' · ')}</dd></div>)}</dl></details>
    <label>分配模式<select value={draft.mode} disabled={busy} onChange={(event) => update({ ...draft, mode: event.target.value })}><option value="auto">自动</option><option value="manual">手动</option></select></label>
    <fieldset><legend>可用模型池</legend>{draft.pool.map((entry, index) => <div className="pool-entry" key={index}><label>模型 ID<input value={entry.id} maxLength={96} disabled={busy} spellCheck="false" list="known-models" onChange={(event) => update({ ...draft, pool: draft.pool.map((item, at) => at === index ? { ...item, id: event.target.value } : item) })} /></label><div className="effort-options">{EFFORTS.map((effort) => <label key={effort}><input type="checkbox" checked={entry.efforts.includes(effort)} disabled={busy} onChange={(event) => update({ ...draft, pool: draft.pool.map((item, at) => at === index ? { ...item, efforts: event.target.checked ? [...item.efforts, effort] : item.efforts.filter((value) => value !== effort) } : item) })} />{effort}</label>)}</div><button className="quiet-action" type="button" disabled={busy || draft.pool.length === 1} onClick={() => update({ ...draft, pool: draft.pool.filter((_, at) => at !== index) })}>移除模型</button></div>)}<button type="button" className="quiet-action" disabled={busy || draft.pool.length >= 12} onClick={() => update({ ...draft, pool: [...draft.pool, { id: '', efforts: [] }] })}>添加模型</button><datalist id="known-models">{config.known_models.map((id) => <option key={id} value={id} />)}</datalist></fieldset>
    <fieldset><legend>默认模型</legend><label>主模型<select value={draft.bootstrap.model} disabled={busy} onChange={(event) => update({ ...draft, bootstrap: { model: event.target.value, effort: effortsFor(event.target.value).includes(draft.bootstrap.effort) ? draft.bootstrap.effort : '' } })}>{choices(draft.bootstrap.model)}</select></label><label>effort<select value={draft.bootstrap.effort} disabled={busy} onChange={(event) => update({ ...draft, bootstrap: { ...draft.bootstrap, effort: event.target.value } })}>{effortChoices(draft.bootstrap.model, draft.bootstrap.effort)}</select></label></fieldset>
    {draft.mode === 'manual' && <fieldset><legend>手动角色选择</legend>{WORKFLOW_NODES.map(({ role, name }) => <div className="manual-role" key={role}><strong>{name}</strong><label>模型<select value={draft.role_models[role]} disabled={busy} onChange={(event) => update({ ...draft, role_models: { ...draft.role_models, [role]: event.target.value }, role_efforts: { ...draft.role_efforts, [role]: effortsFor(event.target.value).includes(draft.role_efforts[role]) ? draft.role_efforts[role] : '' } })}>{choices(draft.role_models[role])}</select></label><label>effort<select value={draft.role_efforts[role]} disabled={busy} onChange={(event) => update({ ...draft, role_efforts: { ...draft.role_efforts, [role]: event.target.value } })}>{effortChoices(draft.role_models[role], draft.role_efforts[role])}</select></label></div>)}</fieldset>}
    <div className="action-row"><button type="button" className="primary-action" disabled={busy || !dirty} onClick={save}>保存模型配置</button><button type="button" className="quiet-action" disabled={busy || dirty || config.mode !== 'auto'} onClick={onAllocate}>自动分配</button></div>

    <details className="saved-models"><summary>当前分配</summary><dl>{WORKFLOW_NODES.map(({ role, name }) => <div key={role}><dt>{name}</dt><dd>{config.effective_models[role]} · {config.effective_efforts[role]}</dd></div>)}</dl></details>
  </section>
}
