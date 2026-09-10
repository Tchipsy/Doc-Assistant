import { useMemo, useState } from 'react'
import type { CheckedModel, DocType, GenConfig, IndexConfig, Preset } from '../api/types'
import { useSettingsStore, modelsOfType } from '../store/settings'
import { Dropdown } from './Dropdown'
import { Icon } from '../lib/icons'

// 步骤11：默认配置与继承解析函数的真身在 store/kb.ts（避免循环依赖），此处再导出
// 供既有调用点（ConfigModal/BottomBar/PreviewMain）继续从本文件导入
export { defaultGenConfig, defaultIndexConfig, resolveDocConfigs } from '../store/kb'

const EMPTY_MODELS: CheckedModel[] = []

/** 生成配置表单（底边栏展开态 / 统一配置窗口共用）。
 *  docType（步骤11）：给定时整理预设下拉只列该类型分组（group）的预设——
 *  文档类只见文档预设、网页类只见网页预设；缺省=不过滤（旧行为）。 */
export function GenConfigFields({ value, onChange, docType }: {
  value: GenConfig
  onChange: (v: GenConfig) => void
  docType?: DocType
}) {
  // 注意：不能写 useSettingsStore(s => s.orgPresets()) —— getter 每次返回新数组，
  // zustand v5 会无限重渲染；先取稳定引用再 useMemo 派生
  const presets = useSettingsStore(s => s.presets)
  const settings = useSettingsStore(s => s.settings)
  const orgPresets = useMemo(
    () => presets.filter(p => p.kind === 'organization'
      && (!docType || (p.group ?? 'doc') === docType)),
    [presets, docType],
  )
  const pluginPresets = useMemo(() => presets.filter(p => p.kind === 'plugin'), [presets])
  const wherePresets = useMemo(() => presets.filter(p => p.kind === 'where'), [presets])
  const modelList = useMemo(
    // 步骤12：整理/内容生成模型只列聊天类型（未分类旧模型附注在末尾）
    () => modelsOfType(settings?.checkedModels ?? EMPTY_MODELS, 'chat'),
    [settings],
  )
  // 插件行内提示：显示其绑定的生成位置显示名
  const whereHint = (p: Preset) =>
    wherePresets.find(w => w.id === p.whereId)?.displayName ?? '（未绑定生成位置）'

  const modelOptions = modelList.map(m => ({ value: m.value, label: m.modelId, group: m.providerName }))

  // 模型下拉：未显式选择时直接选中设置里的默认模型（不再显示"默认（设置→…）"占位项）；
  // 用户点选默认模型本身 = 存 null（继续跟随设置默认）
  const defaults = settings?.defaults
  const defOrganize = defaults?.organize ?? null
  const defContent = defaults?.contentGen ?? null
  const hasDefOrganize = !!defOrganize && modelOptions.some(m => m.value === defOrganize)
  const hasDefContent = !!defContent && modelOptions.some(m => m.value === defContent)
  const organizeOptions = hasDefOrganize
    ? modelOptions
    : [{ value: '', label: '默认（设置 → 文档整理模型）' }, ...modelOptions]
  const contentOptions = hasDefContent
    ? modelOptions
    : [{ value: '', label: '默认（设置 → 内容生成模型）' }, ...modelOptions]
  const comps = value.components ?? { toc: true, summary: true, images: true }

  const toggleComp = (k: keyof typeof comps) =>
    onChange({ ...value, components: { ...comps, [k]: !comps[k] } })

  // 生成工具（步骤3）：跨文档查询（webSearch 由步骤4 启用，此处仅占位结构）
  const tools = value.tools ?? { crossDocSearch: false, webSearch: false }
  const toggleTool = (k: keyof typeof tools) =>
    onChange({ ...value, tools: { ...tools, [k]: !tools[k] } })

  // 插件拖拽排序
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const enabledPlugins: Preset[] = (value.plugins ?? [])
    .map(id => pluginPresets.find(p => p.id === id))
    .filter((p): p is Preset => !!p)

  const movePlugin = (from: number, to: number) => {
    const ids = [...(value.plugins ?? [])]
    const all = ids.filter(id => pluginPresets.some(p => p.id === id))
    if (from < 0 || to < 0 || from >= all.length || to >= all.length) return
    const [it] = all.splice(from, 1)
    all.splice(to, 0, it)
    onChange({ ...value, plugins: all })
  }

  const [showPluginPicker, setShowPluginPicker] = useState(false)

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <div>
          <div className="label mb-1.5">文档整理预设</div>
          <Dropdown
            options={orgPresets.map(p => ({ value: p.id, label: p.displayName }))}
            value={value.presetId}
            onChange={v => onChange({ ...value, presetId: v })}
            emptyText="暂无预设，可在设置中新增"
          />
        </div>
        <div>
          <div className="label mb-1.5">文档整理模型</div>
          <Dropdown
            options={organizeOptions}
            value={value.organizeModel ?? (hasDefOrganize ? defOrganize! : '')}
            onChange={v => onChange({ ...value, organizeModel: v && v !== defOrganize ? v : null })}
            emptyText="未勾选模型，请前往设置 → 模型服务"
            placeholder="默认"
          />
        </div>
        <div>
          <div className="label mb-1.5">内容生成模型</div>
          <Dropdown
            options={contentOptions}
            value={value.contentModel ?? (hasDefContent ? defContent! : '')}
            onChange={v => onChange({ ...value, contentModel: v && v !== defContent ? v : null })}
            emptyText="未勾选模型，请前往设置 → 模型服务"
            placeholder="默认"
          />
        </div>
        <div>
          <div className="label mb-1.5">显示组件</div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1.5">
            {([['toc', '目录'], ['summary', 'Summary'], ['images', '图片']] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={comps[k]}
                  onChange={() => toggleComp(k)}
                />
                <span className="text-[13px]">{label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* 生成工具（步骤3/4：位于文档显示配置区、插件列表上方；两项可同时启用） */}
      <div>
        <div className="label mb-1.5">生成工具</div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <label
            className="flex items-center gap-1.5 cursor-pointer select-none"
            title="生成内容时，模型可以主动查询本知识库的其他文档"
          >
            <input
              type="checkbox"
              checked={!!tools.crossDocSearch}
              onChange={() => toggleTool('crossDocSearch')}
            />
            <span className="text-[13px]">跨文档查询</span>
          </label>
          <label
            className="flex items-center gap-1.5 cursor-pointer select-none"
            title="联网以丰富生成内容"
          >
            <input
              type="checkbox"
              checked={!!tools.webSearch}
              onChange={() => toggleTool('webSearch')}
            />
            <span className="text-[13px]">网络搜索</span>
          </label>
        </div>
      </div>

      {/* 内容生成插件：启用列表（拖拽排序）+ 从插件库勾选 */}
      <div>
        <div className="label mb-1.5">内容生成插件</div>
        {enabledPlugins.length === 0 && (
          <div className="t3 text-[12.5px] py-1">未启用插件，点击 ＋ 从插件库勾选</div>
        )}
        <div className="space-y-1.5">
          {enabledPlugins.map((p, i) => (
            <div
              key={p.id}
              draggable
              onDragStart={() => setDragIdx(i)}
              onDragEnter={() => setOverIdx(i)}
              onDragEnd={() => {
                if (dragIdx !== null && overIdx !== null && dragIdx !== overIdx) movePlugin(dragIdx, overIdx)
                setDragIdx(null); setOverIdx(null)
              }}
              onDragOver={e => e.preventDefault()}
              className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${dragIdx === i ? 'opacity-40' : 'border-line'} ${overIdx === i && dragIdx !== null && dragIdx !== i ? 'ring-1 ring-primary' : ''}`}
              style={{ cursor: 'grab' }}
            >
              <Icon name="grip" size={14} className="t3 shrink-0" />
              <span className="text-[13px] font-medium truncate">{p.displayName}</span>
              <span className="t3 text-[11px] truncate flex-1">{whereHint(p)}</span>
              <button
                className="btn btn-icon"
                title="移除"
                onClick={() => onChange({ ...value, plugins: value.plugins.filter(x => x !== p.id) })}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="relative mt-1.5">
          <button className="btn btn-soft btn-sm" onClick={() => setShowPluginPicker(v => !v)}>
            <Icon name="plus" size={13} /> 从插件库勾选
          </button>
          {showPluginPicker && (
            <div className="absolute left-0 top-9 z-30 w-[320px] card p-2 anim-pop max-h-[260px] overflow-auto scroll-thin">
              {pluginPresets.map(p => {
                const enabled = value.plugins?.includes(p.id)
                return (
                  <label key={p.id} className="flex items-start gap-2 px-2 py-1.5 rounded-md hover:bg-hover cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!enabled}
                      onChange={() => onChange({
                        ...value,
                        plugins: enabled
                          ? value.plugins.filter(x => x !== p.id)
                          : [...(value.plugins ?? []), p.id],
                      })}
                    />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{p.displayName}</div>
                      <div className="t3 text-[11px] truncate">{whereHint(p)}</div>
                    </div>
                  </label>
                )
              })}
              {pluginPresets.length === 0 && <div className="t3 text-[12px] p-2">内容生成预设为空，可在设置 → 内容生成中新增</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 入库配置表单（含"是否入库"总开关；取消后向量保留、检索排除） */
export function IndexConfigFields({ value, onChange }: {
  value: IndexConfig
  onChange: (v: IndexConfig) => void
}) {
  const presets = useSettingsStore(s => s.presets)
  const pluginPresets = useMemo(() => presets.filter(p => p.kind === 'plugin'), [presets])
  const comps = value.components ?? { summary: false, images: false }
  const toggleComp = (k: keyof typeof comps) =>
    onChange({ ...value, components: { ...comps, [k]: !comps[k] } })

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={!!value.enabled}
          onChange={() => onChange({ ...value, enabled: !value.enabled })}
        />
        <span className="text-[13px] font-medium">是否入库</span>
        <span className="t3 text-[11.5px]">（organized 恒入库；取消勾选后向量保留但检索时不命中）</span>
      </label>
      {!!value.enabled && (
        <>
          <div>
            <div className="label mb-1.5">入库组件</div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              {([['summary', 'Summary'], ['images', '图片']] as const).map(([k, label]) => (
                <label key={k} className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input type="checkbox" checked={comps[k]} onChange={() => toggleComp(k)} />
                  <span className="text-[13px]">{label}</span>
                </label>
              ))}
            </div>
          </div>
          <div>
            <div className="label mb-1.5">入库插件</div>
            <div className="space-y-1 max-h-[200px] overflow-auto scroll-thin">
              {pluginPresets.map(p => {
                const enabled = value.plugins?.includes(p.id)
                return (
                  <label key={p.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-hover cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!enabled}
                      onChange={() => onChange({
                        ...value,
                        plugins: enabled
                          ? value.plugins.filter(x => x !== p.id)
                          : [...(value.plugins ?? []), p.id],
                      })}
                    />
                    <span className="text-[13px] font-medium">{p.displayName}</span>
                  </label>
                )
              })}
              {pluginPresets.length === 0 && <div className="t3 text-[12px] p-1">内容生成预设为空，可在设置 → 内容生成中新增</div>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** 一行配置摘要（底边栏收缩态 / 居中展示） */
export function genConfigSummary(cfg: GenConfig | undefined): string {
  const s = useSettingsStore.getState()
  if (!cfg || !cfg.presetId) return '未配置'
  const preset = s.orgPresets().find(p => p.id === cfg.presetId)?.displayName ?? '未设置'
  const orgModel = cfg.organizeModel ? cfg.organizeModel.split('/').pop() : '默认'
  const genModel = cfg.contentModel ? cfg.contentModel.split('/').pop() : '默认'
  const nPlugins = cfg.plugins?.length ?? 0
  return `预设：${preset} ｜ 整理模型：${orgModel} ｜ 生成模型：${genModel} ｜ 插件 ×${nPlugins}`
}

export function indexConfigSummary(cfg: IndexConfig | undefined): string {
  if (!cfg) return '未配置'
  if (!cfg.enabled) return '未入库'
  const comps = cfg.components ?? { summary: false, images: false }
  const parts: string[] = ['organized']
  if (comps.summary) parts.push('summary')
  if (comps.images) parts.push('图片')
  parts.push(`插件 ×${cfg.plugins?.length ?? 0}`)
  return parts.join(' ｜ ')
}
