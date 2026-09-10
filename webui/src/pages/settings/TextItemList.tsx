import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settings'
import { ConfirmModal } from '../../components/Modal'
import { toast } from '../../components/Toast'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/utils'
import type { Preset } from '../../api/types'

/**
 * 「文档整理」分区：整理预设按源类型分组显示（文档 / 网页）。
 * 名称输入框编辑的是 display_name（仅 UI 显示）；内部名 name 只读展示，
 * 是产物文件名 / 入库 artifact 的稳定依据，不再可编辑。
 */
const GROUPS: Array<{ id: 'doc' | 'web'; label: string; desc: string }> = [
  { id: 'doc', label: '文档', desc: '本地文档类源：PDF / 教材 / 课件 / 试卷 / 书籍（带页码标记）' },
  { id: 'web', label: '网页', desc: '网页类源：爬取的网页正文（无页码标记）' },
]

function ItemCard({ item, onRemove }: {
  item: Preset
  onRemove: (id: string) => void
}) {
  const updatePreset = useSettingsStore(s => s.updatePreset)
  const [displayName, setDisplayName] = useState(item.displayName)
  const [content, setContent] = useState(item.content)
  const [confirmDel, setConfirmDel] = useState(false)
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
        <Icon name="sliders" size={15} style={{ color: 'var(--primary)' }} />
        <input
          className="w-[190px] border-none bg-transparent px-1 py-0.5 text-[14px] font-semibold t1 outline-none focus:border-b focus:border-[var(--primary)]"
          value={displayName} onChange={e => setDisplayName(e.target.value)}
          placeholder="预设显示名"
        />
        <span className="text-[11px] t3" title="内部名（产物文件名 / 入库依据，不可修改）">
          内部名：{item.name}
        </span>
        <div className="flex-1" />
        <button className="btn btn-ghost btn-icon" title="删除" onClick={() => setConfirmDel(true)}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      <textarea
        className="textarea scroll-thin" rows={6}
        placeholder="输入整理预设提示词（首行为人设，正文为该源类型的专属整理规则；通用规则见公共要求，不必重复）…"
        value={content} onChange={e => setContent(e.target.value)}
        style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12.5 }}
      />
      <div className="mt-2.5 flex items-center justify-between">
        <span className="text-[11px] t3">内容 sha 参与生成指纹，修改后按新内容重新生成</span>
        <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>
          <Icon name={saving ? 'loader' : 'check'} size={13} className={saving ? 'spin' : ''} /> 保存
        </button>
      </div>

      {confirmDel && (
        <ConfirmModal
          title="删除整理预设"
          message={<>确定删除「<b>{displayName}</b>」？使用它的文档生成配置不受影响（已生成的产物保留）。</>}
          onConfirm={() => onRemove(item.id)}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </div>
  )
}

function GroupSection({ group, items, onRemove, onAdd }: {
  group: 'doc' | 'web'
  items: Preset[]
  onRemove: (id: string) => void
  onAdd: (group: 'doc' | 'web') => void
}) {
  const g = GROUPS.find(x => x.id === group)!
  return (
    <div className="mb-6">
      <div className="mb-2.5 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[13.5px] font-semibold t1">{g.label}</span>
            <span className="badge text-[10.5px]">{items.length} 个预设</span>
          </div>
          <div className="mt-0.5 text-[11.5px] t3">{g.desc}</div>
        </div>
        <button className="btn btn-soft btn-sm" onClick={() => onAdd(group)}>
          <Icon name="plus" size={13} /> 新增
        </button>
      </div>
      <div className="space-y-3">
        {items.map(item => (
          <ItemCard key={`${group}-${item.id}`} item={item} onRemove={onRemove} />
        ))}
        {items.length === 0 && (
          <div className={cx('card flex flex-col items-center gap-2 py-8')}>
            <Icon name="sliders" size={26} className="t3" />
            <div className="text-[12.5px] t3">暂无{g.label}类整理预设</div>
          </div>
        )}
      </div>
    </div>
  )
}

export function TextItemList() {
  const presets = useSettingsStore(s => s.presets)
  const createPreset = useSettingsStore(s => s.createPreset)
  const deletePreset = useSettingsStore(s => s.deletePreset)

  const docItems = presets.filter(p => p.kind === 'organization' && (p.group ?? 'doc') === 'doc')
  const webItems = presets.filter(p => p.kind === 'organization' && p.group === 'web')
  const n = docItems.length + webItems.length

  const add = async (group: 'doc' | 'web') => {
    try {
      await createPreset('organization', `${group === 'doc' ? '文档' : '网页'}预设 ${n + 1}`, '', { group })
      toast('已新增预设')
    } catch (e: any) {
      toast(`新增失败：${e?.message ?? e}`, 'error')
    }
  }

  const remove = (id: string) =>
    deletePreset(id).then(() => toast('已删除预设'))

  return (
    <div>
      <div className="mb-5">
        <div className="text-[15px] font-semibold t1">文档整理</div>
        <div className="mt-0.5 text-[12px] t3">
          整理预设是 pass1 整理文档时使用的提示词，在文档生成配置中选用；
          公共规则（翻译纠错 / 排版 / 页码标记等）按源类型自动附加，预设里只写专属规则
        </div>
      </div>
      <GroupSection group="doc" items={docItems} onRemove={remove} onAdd={add} />
      <GroupSection group="web" items={webItems} onRemove={remove} onAdd={add} />
    </div>
  )
}
