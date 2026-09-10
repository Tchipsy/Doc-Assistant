import { useMemo } from 'react'
import { useSettingsStore, modelsOfType, DEFAULT_KEY_MODEL_TYPES } from '../../store/settings'
import { Dropdown } from '../../components/Dropdown'
import { Icon } from '../../lib/icons'
import { DEFAULT_MODEL_LABELS, MODEL_TYPE_LABELS, type CheckedModel, type DefaultModelKey } from '../../api/types'

const DESC: Record<DefaultModelKey, string> = {
  assistant: '助手界面聊天默认使用的模型',
  organize: '文档解析后按预设整理内容（pass1）的模型',
  contentGen: '内容生成（pass2 插件）默认模型',
  assist: '会话命名、查询改写等辅助任务使用的模型',
  embedding: '文档入库与查询向量化的嵌入模型（/embeddings）',
  rerank: '检索结果重排模型（/rerank，未设置则跳过重排）',
}

const KEYS: DefaultModelKey[] = ['assistant', 'organize', 'contentGen', 'assist', 'embedding', 'rerank']

const EMPTY_CHECKED: CheckedModel[] = []

export function DefaultsSection() {
  const settings = useSettingsStore(s => s.settings)!
  const updateDefaults = useSettingsStore(s => s.updateDefaults)
  const checked = settings.checkedModels ?? EMPTY_CHECKED

  // 按槽位期望类型过滤（步骤12）：聊天类列表末尾附注未分类（''）旧模型
  const optionsByKey = useMemo(() => {
    const toOpts = (list: CheckedModel[]) =>
      list.map(m => ({ value: m.value, label: m.modelId, group: m.providerName }))
    return {
      chat: toOpts(modelsOfType(checked, 'chat')),
      embedding: toOpts(modelsOfType(checked, 'embedding')),
      rerank: toOpts(modelsOfType(checked, 'rerank')),
    }
  }, [checked])

  return (
    <div>
      <div className="mb-1 text-[15px] font-semibold t1">默认模型</div>
      <div className="mb-5 text-[12px] t3">
        各场景默认使用的模型，从「模型服务」中已勾选的对应类型模型中选择（类型在模型服务中标记）
      </div>

      {checked.length === 0 && (
        <div className="card mb-4 flex items-center gap-2.5 px-4 py-3 text-[12.5px]" style={{ background: 'var(--danger-soft)' }}>
          <Icon name="alert" size={15} style={{ color: 'var(--danger)' }} />
          <span style={{ color: 'var(--danger)' }}>尚未勾选任何模型，请先前往「模型服务」添加服务商并勾选模型</span>
        </div>
      )}

      <div className="space-y-3">
        {KEYS.map(key => {
          const expected = DEFAULT_KEY_MODEL_TYPES[key]
          const options = optionsByKey[expected]
          const value = settings.defaults?.[key]
          const valid = options.some(o => o.value === value)
          const selected = checked.find(m => m.value === value)
          // 步骤12 警示点：已配置模型的类型与槽位期望不符（如聊天模型填进嵌入槽）
          const mismatched = !!selected?.modelType && selected.modelType !== expected
          return (
            <div key={key} className="card flex items-center gap-4 px-4 py-3.5">
              <div className="w-[130px] shrink-0">
                <div className="text-[13.5px] font-medium t1">{DEFAULT_MODEL_LABELS[key]}</div>
              </div>
              <div className="min-w-0 flex-1 text-[12px] t3">{DESC[key]}</div>
              <div className="w-[230px] shrink-0">
                <div className="relative">
                  <Dropdown
                    options={options}
                    value={valid ? value! : ''}
                    placeholder={value && !valid
                      ? (selected
                        ? `${value.split('/').pop()}（${MODEL_TYPE_LABELS[selected.modelType ?? '']}）`
                        : `${value.split('/').pop()}（已停用）`)
                      : '请选择模型'}
                    onChange={v => updateDefaults({ [key]: v || null })}
                    emptyText={`无${MODEL_TYPE_LABELS[expected]}类型模型`}
                  />
                  {mismatched && (
                    <span
                      className="absolute right-[-8px] top-[-6px] h-2.5 w-2.5 cursor-help rounded-full"
                      style={{ background: 'var(--warn)' }}
                      title={`模型类型不匹配：该模型是「${MODEL_TYPE_LABELS[selected.modelType!]}」，此槽位期望「${MODEL_TYPE_LABELS[expected]}」；可正常保存但实际调用可能报错`}
                    />
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
