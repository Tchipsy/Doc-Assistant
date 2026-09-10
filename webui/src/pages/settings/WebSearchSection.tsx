import { useSettingsStore } from '../../store/settings'
import { Dropdown } from '../../components/Dropdown'
import { Icon } from '../../lib/icons'
import type { WebSearchSettings } from '../../api/types'

const PROVIDER_OPTIONS: Array<{ value: WebSearchSettings['provider']; label: string; desc: string }> = [
  { value: 'examcp', label: 'Exa MCP', desc: 'MCP 直调（免密钥），开箱即用' },
  { value: 'tavily', label: 'Tavily', desc: '搜索 + 网页提取 REST API' },
  { value: 'exa', label: 'Exa', desc: 'Exa REST API（x-api-key）' },
  { value: 'jina', label: 'Jina AI', desc: 's.jina.ai 搜索 + r.jina.ai 网页阅读' },
]

const DEFAULT_URLS: Record<WebSearchSettings['provider'], string> = {
  tavily: 'https://api.tavily.com',
  exa: 'https://api.exa.ai',
  examcp: 'https://mcp.exa.ai/mcp',
  jina: 'https://r.jina.ai',
}

export function WebSearchSection() {
  const settings = useSettingsStore(s => s.settings)
  const updateWebsearch = useSettingsStore(s => s.updateWebsearch)
  if (!settings?.websearch) return null
  const ws = settings.websearch
  const active = PROVIDER_OPTIONS.find(o => o.value === ws.provider)
  const isExamcp = ws.provider === 'examcp'

  return (
    <div>
      <div className="mb-1 text-[15px] font-semibold t1">网络搜索</div>
      <div className="mb-5 text-[12px] t3">
        助手联网回答与「生成工具 → 网络搜索」使用此配置 · Exa MCP 免密钥，其余服务商需在对应官网申请 API 密钥
      </div>

      <div className="mb-4 w-[300px]">
        <div className="label mb-1.5">服务商</div>
        <Dropdown
          options={PROVIDER_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
          value={ws.provider}
          onChange={v => updateWebsearch({ provider: v as WebSearchSettings['provider'], apiUrl: DEFAULT_URLS[v as WebSearchSettings['provider']] })}
        />
      </div>

      <div className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Icon name="globe" size={15} style={{ color: 'var(--primary)' }} />
          <span className="text-[14px] font-semibold t1">{active?.label}</span>
          <span className="text-[11.5px] t3">{active?.desc}</span>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="label mb-1">API 地址</div>
              <input
                className="input"
                placeholder={DEFAULT_URLS[ws.provider]}
                defaultValue={ws.apiUrl}
                key={`${ws.provider}-url`}
                onBlur={e => {
                  const v = e.target.value.trim()
                  if (v !== ws.apiUrl) updateWebsearch({ apiUrl: v })
                }}
              />
            </div>
            <div>
              <div className="label mb-1">API 密钥</div>
              <input
                className="input" type="password"
                placeholder={isExamcp ? '无需密钥' : '必填'}
                disabled={isExamcp}
                title={isExamcp ? 'Exa MCP 无需密钥' : undefined}
                defaultValue={ws.apiKey}
                key={`${ws.provider}-key`}
                onBlur={e => {
                  const v = e.target.value
                  // 打码值（••••尾4）原样回传=未修改；后端同样忽略
                  if (v !== ws.apiKey) updateWebsearch({ apiKey: v })
                }}
              />
            </div>
          </div>
          {isExamcp ? (
            <div className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-[12px] t3" style={{ background: 'var(--panel-2)' }}>
              <Icon name="info" size={14} />
              Exa MCP 走 MCP 协议直调（mcp.exa.ai），无需 API 密钥；如自建/换用其他 MCP 服务，改 API 地址即可。
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg px-3 py-2.5 text-[12px] t3" style={{ background: 'var(--panel-2)' }}>
              <Icon name="info" size={14} />
              密钥保存后仅显示尾 4 位；留空保存 = 不修改密钥。切换服务商时 API 地址自动预填默认值（可改）。
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
