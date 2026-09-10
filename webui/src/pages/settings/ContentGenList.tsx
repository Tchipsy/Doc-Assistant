import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { ConfirmModal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { Icon } from '../../lib/icons'
import type { Preset } from '../../api/types'

/**
 * 「内容生成」分区：拆成两个子区。
 * - 生成位置（kind='where'）：描述 @@ 块生成在哪些位置，相同位置的预设合并为
 *   一次 pass2 LLM 调用；删除前由后端校验无内容生成预设引用。
 * - 生成预设（kind='plugin'）：内容要求（## requirements），通过 whereId 引用
 *   一个生成位置；内部名 name 是 @@ 块类型 / 产物文件名，只读展示。
 */
const WHERE_TEMPLATE = `## where
（描述何处需要生成内容块；与其它生成位置文本语义不同即可分开调用）

## meta
（可选）coverage: leaf = 按最小编号节全覆盖校验
`

const PLUGIN_TEMPLATE = `## requirements
（描述该内容组件的要求：内容、风格、结构…；生成位置在上方下拉中选择）
`

function WhereCard({ item, onRemove }: {
  item: Preset
  onRemove: (id: string) => void
}) {
  const updatePreset = useSettingsStore(s => s.updatePreset)
  const [displayName, setDisplayName] = useState(item.displayName)
  const [content, setContent] = useState(item.content)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDisplayName(item.displayName); setContent(item.content)
  }, [item.id, item.displayName, item.content])

  const save = async () => {
    setSaving(true)
    try {
      await updatePreset(item.id, { displayName: displayName.trim() || item.displayName, content })
      toast('已保存')
    } catch (e: any) {
      toast(`保存失败：${e?.message ?? e}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <Icon name="zap" size={15} style={{ color: 'var(--primary)' }} />
        <input
          className="w-[190px] border-none bg-transparent px-1 py-0.5 text-[14px] font-semibold t1 outline-none focus:border-b focus:border-[var(--primary)]"
          value={displayName} onChange={e => setDisplayName(e.target.value)}
          placeholder="生成位置名"
        />
        <span className="text-[11px] t3" title="内部名（不可修改）">内部名：{item.name}</span>
        <div className="flex-1" />
      </div>
      <textarea
        className="textarea scroll-thin" rows={5}
        placeholder={WHERE_TEMPLATE}
        value={content} onChange={e => setContent(e.target.value)}
        style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5 }}
      />
      <div className="mt-2.5 flex items-center justify-end">
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>
          <Icon name={saving ? 'loader' : 'check'} size={13} className={saving ? 'spin' : ''} /> 保存
        </button>
      </div>
    </div>
  )
}

function PluginCard({ item, wheres, onRemove }: {
  item: Preset
  wheres: Preset[]
  onRemove: (id: string) => void
}) {
  const updatePreset = useSettingsStore(s => s.updatePreset)
  const [displayName, setDisplayName] = useState(item.displayName)
  const [whereId, setWhereId] = useState(item.whereId ?? '')
  const [content, setContent] = useState(item.content)
  const [confirmDel, setConfirmDel] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDisplayName(item.displayName)
    setWhereId(item.whereId ?? '')
    setContent(item.content)
  }, [item.id, item.displayName, item.whereId, item.content])

  const save = async () => {
    setSaving(true)
    try {
      await updatePreset(item.id, {
        displayName: displayName.trim() || item.displayName,
        content,
        whereId: whereId || null,
      })
      toast('已保存')
    } catch (e: any) {
      toast(`保存失败：${e?.message ?? e}`, 'error')
    } finally {
      setSaving(false)
    }
  }

  const bound = wheres.find(w => w.id === (whereId || item.whereId))

  return (
    <div className="card p-4">
      <div className="mb-2.5 flex items-center gap-2">
        <Icon name="plug" size={15} style={{ color: 'var(--primary)' }} />
        <input
          className="w-[190px] border-none bg-transparent px-1 py-0.5 text-[14px] font-semibold t1 outline-none focus:border-b focus:border-[var(--primary)]"
          value={displayName} onChange={e => setDisplayName(e.target.value)}
          placeholder="内容生成预设名"
        />
        <span className="text-[11px] t3" title="内部名（@@ 块类型 / 产物文件名，不可修改）">
          内部名：{item.name}
        </span>
        <div className="flex-1" />
        <button className="btn btn-ghost btn-icon" title="删除" onClick={() => setConfirmDel(true)}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-[12.5px] t2">生成位置</span>
        <select className="select w-[240px]" value={whereId}
          onChange={e => setWhereId(e.target.value)}>
          <option value="">（未绑定）</option>
          {wheres.map(w => (
            <option key={w.id} value={w.id}>{w.displayName}</option>
          ))}
        </select>
        {bound && <span className="text-[11px] t3 truncate flex-1" title={bound.content}>
          {bound.content.split('\n').find(l => l.trim().startsWith('-'))?.trim().slice(0, 46) ?? ''}
        </span>}
      </div>
      <textarea
        className="textarea scroll-thin" rows={6}
        placeholder={PLUGIN_TEMPLATE}
        value={content} onChange={e => setContent(e.target.value)}
        style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5 }}
      />
      <div className="mt-2.5 flex items-center justify-between">
        <span className="text-[11px] t3">
          {bound ? '同一生成位置的预设会合并为一次生成调用' : '未绑定生成位置的预设将单独调用（无位置要求）'}
        </span>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>
          <Icon name={saving ? 'loader' : 'check'} size={13} className={saving ? 'spin' : ''} /> 保存
        </button>
      </div>

      {confirmDel && (
        <ConfirmModal
          title="删除内容生成预设"
          message={<>确定删除「<b>{displayName}</b>」？使用它的文档生成配置不受影响（已生成的产物保留）。</>}
          onConfirm={() => onRemove(item.id)}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </div>
  )
}

export function ContentGenList() {
  const presets = useSettingsStore(s => s.presets)
  const createPreset = useSettingsStore(s => s.createPreset)
  const deletePreset = useSettingsStore(s => s.deletePreset)

  const wheres = presets.filter(p => p.kind === 'where')
  const plugins = presets.filter(p => p.kind === 'plugin')

  const addWhere = async () => {
    try {
      await createPreset('where', `生成位置 ${wheres.length + 1}`, WHERE_TEMPLATE)
      toast('已新增生成位置')
    } catch (e: any) {
      toast(`新增失败：${e?.message ?? e}`, 'error')
    }
  }

  const addPlugin = async () => {
    try {
      await createPreset('plugin', `内容预设 ${plugins.length + 1}`, PLUGIN_TEMPLATE,
        { whereId: wheres[0]?.id })
      toast('已新增内容生成预设')
    } catch (e: any) {
      toast(`新增失败：${e?.message ?? e}`, 'error')
    }
  }

  const remove = (id: string, what: string) =>
    deletePreset(id)
      .then(() => toast(`已删除${what}`))
      .catch((e: any) => toast(`删除失败：${e?.message ?? e}`, 'error'))

  return (
    <div>
      <div className="mb-5">
        <div className="text-[15px] font-semibold t1">内容生成</div>
        <div className="mt-0.5 text-[12px] t3">
          pass2 按生成位置把内容生成预设分组，同位置合并为一次 LLM 调用；
          在文档生成配置中按序启用
        </div>
      </div>

      {/* 生成位置 */}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold t1">生成位置</span>
            <span className="badge text-[10.5px]">{wheres.length} 个位置</span>
          </div>
          <div className="mt-0.5 text-[11.5px] t3">
            内容块生成在文档的哪些位置（如最小编号节 / 题目处）；可被多个生成预设复用
          </div>
        </div>
        <button className="btn btn-soft btn-sm" onClick={addWhere}>
          <Icon name="plus" size={13} /> 新增位置
        </button>
      </div>
      <div className="mb-7 space-y-3">
        {wheres.map(w => <WhereCard key={`where-${w.id}`} item={w}
          onRemove={id => remove(id, '生成位置')} />)}
        {wheres.length === 0 && (
          <div className="card flex flex-col items-center gap-2 py-8">
            <Icon name="zap" size={26} className="t3" />
            <div className="text-[12.5px] t3">暂无生成位置，点击右上角新增</div>
          </div>
        )}
      </div>

      {/* 生成预设 */}
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold t1">生成预设</span>
            <span className="badge text-[10.5px]">{plugins.length} 个预设</span>
          </div>
          <div className="mt-0.5 text-[11.5px] t3">
            每个预设定义一种内容组件（## requirements 内容要求），并绑定一个生成位置
          </div>
        </div>
        <button className="btn btn-soft btn-sm" onClick={addPlugin}>
          <Icon name="plus" size={13} /> 新增预设
        </button>
      </div>
      <div className="space-y-3">
        {plugins.map(p => <PluginCard key={`plugin-${p.id}`} item={p} wheres={wheres}
          onRemove={id => remove(id, '内容生成预设')} />)}
        {plugins.length === 0 && (
          <div className="card flex flex-col items-center gap-2 py-8">
            <Icon name="plug" size={26} className="t3" />
            <div className="text-[12.5px] t3">暂无内容生成预设，点击右上角新增</div>
          </div>
        )}
      </div>
    </div>
  )
}
