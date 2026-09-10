import { useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { Modal, ConfirmModal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/utils'
import { MODEL_TYPE_LABELS } from '../../api/types'
import type { ModelType, Provider } from '../../api/types'

const MODEL_TYPES: ModelType[] = ['', 'chat', 'embedding', 'rerank']

export function ProvidersSection() {
  const settings = useSettingsStore(s => s.settings)!
  const createProvider = useSettingsStore(s => s.createProvider)
  const updateProvider = useSettingsStore(s => s.updateProvider)
  const deleteProvider = useSettingsStore(s => s.deleteProvider)
  const fetchModels = useSettingsStore(s => s.fetchModels)
  const setCheckedModels = useSettingsStore(s => s.setCheckedModels)
  const [addOpen, setAddOpen] = useState(false)
  const [draft, setDraft] = useState({ name: '', baseUrl: '', apiKey: '' })
  const [fetchingId, setFetchingId] = useState<string | null>(null)
  const [delId, setDelId] = useState<string | null>(null)
  const [showKey, setShowKey] = useState<Record<string, boolean>>({})

  const doAdd = async () => {
    if (!draft.name.trim()) return
    try {
      await createProvider(draft.name.trim(), draft.baseUrl.trim(), draft.apiKey.trim())
      toast(`已添加服务商「${draft.name.trim()}」`)
    } catch (e: any) {
      toast(`添加失败：${e?.message ?? e}`, 'error')
    }
    setDraft({ name: '', baseUrl: '', apiKey: '' })
    setAddOpen(false)
  }

  const doFetch = async (p: Provider) => {
    setFetchingId(p.id)
    try {
      const models = await fetchModels(p.id)
      toast(`已拉取 ${models.length} 个模型，请勾选启用`)
    } catch (e: any) {
      toast(`拉取失败：${e?.message ?? e}`, 'error')
    } finally {
      setFetchingId(null)
    }
  }

  const toggleModel = async (p: Provider, modelId: string) => {
    const checked = p.models.filter(m => m.checked && m.modelId !== modelId).map(m => m.modelId)
    if (!p.models.find(m => m.modelId === modelId)?.checked) checked.push(modelId)
    try {
      await setCheckedModels(p.id, checked)
    } catch (e: any) {
      toast(`保存失败：${e?.message ?? e}`, 'error')
    }
  }

  // 模型属性（步骤12）：类型下拉/图片输入勾选，随现有勾选接口保存（attrs 部分更新）
  const saveAttrs = async (p: Provider, modelId: string, attrs: { modelType?: ModelType; imageInput?: boolean }) => {
    const checked = p.models.filter(m => m.checked).map(m => m.modelId)
    try {
      await setCheckedModels(p.id, checked, { [modelId]: attrs })
    } catch (e: any) {
      toast(`保存失败：${e?.message ?? e}`, 'error')
    }
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-[15px] font-semibold t1">模型服务</div>
          <div className="mt-0.5 text-[12px] t3">添加 OpenAI 兼容服务商，拉取并勾选可用模型</div>
        </div>
        <button className="btn btn-primary" onClick={() => setAddOpen(true)}>
          <Icon name="plus" size={14} /> 添加 OpenAI 兼容服务商
        </button>
      </div>

      <div className="space-y-4">
        {settings.providers.map(p => (
          <div key={p.id} className="card p-4">
            <div className="mb-3 flex items-center gap-2">
              <Icon name="server" size={15} style={{ color: 'var(--primary)' }} />
              <input
                className="w-[170px] border-none bg-transparent px-1 py-0.5 text-[14px] font-semibold t1 outline-none focus:border-b focus:border-[var(--primary)]"
                defaultValue={p.name}
                onBlur={e => {
                  if (e.target.value.trim() && e.target.value !== p.name)
                    updateProvider(p.id, { name: e.target.value.trim() })
                }}
              />
              <span className="badge" style={{ fontSize: 10.5 }}>
                {p.models.filter(m => m.checked).length}/{p.models.length} 已启用
              </span>
              <div className="flex-1" />
              <button className="btn btn-ghost btn-icon" title="删除服务商" onClick={() => setDelId(p.id)}>
                <Icon name="trash" size={14} />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="label mb-1">API 地址</div>
                <input
                  className="input" placeholder="https://api.example.com/v1" defaultValue={p.baseUrl}
                  onBlur={e => { if (e.target.value !== p.baseUrl) updateProvider(p.id, { baseUrl: e.target.value.trim() }) }}
                />
              </div>
              <div>
                <div className="label mb-1">API 密钥</div>
                <div className="relative">
                  <input
                    className="input pr-9" type={showKey[p.id] ? 'text' : 'password'}
                    placeholder="sk-..." defaultValue={p.apiKey}
                    onBlur={e => { if (e.target.value !== p.apiKey) updateProvider(p.id, { apiKey: e.target.value }) }}
                  />
                  <button
                    className="absolute right-2 top-1/2 -translate-y-1/2 opacity-60 hover:opacity-100"
                    onClick={() => setShowKey(s => ({ ...s, [p.id]: !s[p.id] }))}
                    title={showKey[p.id] ? '隐藏' : '显示'}
                  >
                    <Icon name="eye" size={14} />
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button className="btn btn-sm" disabled={fetchingId === p.id} onClick={() => doFetch(p)}>
                <Icon name={fetchingId === p.id ? 'loader' : 'refresh'} size={13} className={fetchingId === p.id ? 'spin' : ''} />
                {fetchingId === p.id ? '拉取中…' : '获取模型列表'}
              </button>
              {p.models.length === 0 && <span className="text-[11.5px] t3">尚未拉取模型列表</span>}
            </div>

            {p.models.length > 0 && (
              <>
                <div className="mt-3 max-h-[300px] divide-y divide-[var(--line)] overflow-y-auto scroll-thin rounded-lg border border-line">
                  {p.models.map(m => {
                    const imageOk = m.modelType === '' || m.modelType === 'chat'
                    return (
                      <div key={m.modelId} className="flex items-center gap-2.5 px-2.5 py-1.5">
                        <label className="flex min-w-0 flex-1 cursor-pointer select-none items-center gap-2"
                          title={m.checked ? '点击取消启用' : '点击启用该模型'}>
                          <input
                            type="checkbox"
                            checked={m.checked}
                            onChange={() => toggleModel(p, m.modelId)}
                          />
                          <span className={cx('truncate text-[12.5px]', !m.checked && 't3')}>{m.modelId}</span>
                        </label>
                        <select
                          className="select shrink-0"
                          style={{ width: 84, fontSize: 12, paddingTop: 2, paddingBottom: 2 }}
                          value={m.modelType}
                          onChange={e => saveAttrs(p, m.modelId, { modelType: e.target.value as ModelType })}
                          title="模型类型：拉取列表时按服务商返回自动分类（未返回时按名称推断），可手动修改"
                        >
                          {MODEL_TYPES.map(t => (
                            <option key={t} value={t}>{MODEL_TYPE_LABELS[t]}</option>
                          ))}
                        </select>
                        <label
                          className={cx('flex shrink-0 cursor-pointer select-none items-center gap-1 text-[11.5px] t2', !imageOk && 'pointer-events-none opacity-40')}
                          title={imageOk ? '图片输入能力标记（多模态预留，当前不影响调用）' : '仅未分类/聊天模型可勾选'}
                        >
                          <input
                            type="checkbox"
                            disabled={!imageOk}
                            checked={!!m.imageInput}
                            onChange={() => saveAttrs(p, m.modelId, { imageInput: !m.imageInput })}
                          />
                          图片输入
                        </label>
                      </div>
                    )
                  })}
                </div>
                <div className="mt-1.5 text-[11px] t3">
                  模型类型在拉取列表时按服务商返回的 supported_endpoint_types 自动分类
                  （服务商未返回时按名称推断，可手动修改）；「图片输入」为能力标记，供后续多模态使用。
                </div>
              </>
            )}
          </div>
        ))}

        {settings.providers.length === 0 && (
          <div className="card flex flex-col items-center gap-2 py-12">
            <Icon name="server" size={32} className="t3" />
            <div className="text-[13px] t3">还没有服务商，点击右上角添加</div>
          </div>
        )}
      </div>

      {addOpen && (
        <Modal title="添加 OpenAI 兼容服务商" width={460} onClose={() => setAddOpen(false)} footer={
          <>
            <button className="btn" onClick={() => setAddOpen(false)}>取消</button>
            <button className="btn btn-primary" disabled={!draft.name.trim()} onClick={doAdd}>添加</button>
          </>
        }>
          <div className="space-y-3">
            <div>
              <div className="label mb-1">服务商名称</div>
              <input className="input" autoFocus placeholder="例如：OpenAI / DeepSeek / 硅基流动"
                value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <div>
              <div className="label mb-1">API 地址</div>
              <input className="input" placeholder="https://api.example.com/v1"
                value={draft.baseUrl} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} />
            </div>
            <div>
              <div className="label mb-1">API 密钥</div>
              <input className="input" type="password" placeholder="sk-..."
                value={draft.apiKey} onChange={e => setDraft({ ...draft, apiKey: e.target.value })} />
            </div>
            <div className="rounded-lg px-3 py-2.5 text-[12px] t3" style={{ background: 'var(--panel-2)' }}>
              添加后可在服务商卡片中点击「获取模型列表」拉取模型并勾选启用。
            </div>
          </div>
        </Modal>
      )}

      {delId && (
        <ConfirmModal
          title="删除服务商"
          message={<>确定删除服务商「<b>{settings.providers.find(p => p.id === delId)?.name}</b>」？已启用的模型将不可用。</>}
          onConfirm={() => deleteProvider(delId!).then(() => toast('已删除服务商'))}
          onClose={() => setDelId(null)}
        />
      )}
    </div>
  )
}
