import { useSettingsStore } from '../../store/settings'
import { Dropdown } from '../../components/Dropdown'
import { Icon } from '../../lib/icons'
import type { ParsingSettings } from '../../api/types'

const PADDLE_MODELS = ['PaddleOCR-VL-1.6', 'PP-StructureV3']

const PARSER_OPTIONS: Array<{ value: ParsingSettings['parser']; label: string; desc: string }> = [
  { value: 'paddleocr', label: 'PaddleOCR', desc: '云端 / 自建 PaddleOCR 解析服务' },
  { value: 'mineru', label: 'MinerU', desc: 'MinerU 文档解析服务（API 地址可指向本地部署）' },
  { value: 'local', label: '本地文档解析', desc: 'PyMuPDF 本地直抽，无需网络与密钥（适合文本型 PDF）' },
]

export function ParsingSection() {
  const settings = useSettingsStore(s => s.settings)!
  const updateParser = useSettingsStore(s => s.updateParser)
  const active = settings.parser.parser
  const conf = (settings.parser as any)[active] ?? {}

  return (
    <div>
      <div className="mb-1 text-[15px] font-semibold t1">文档解析</div>
      <div className="mb-5 text-[12px] t3">
        解析服务商不可增删 · 新导入文档按此配置解析；已导入文档可右键「重新解析」按当前配置重跑
      </div>

      <div className="mb-4 w-[300px]">
        <div className="label mb-1.5">服务商</div>
        <Dropdown
          options={PARSER_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
          value={active}
          onChange={v => updateParser({ parser: v as ParsingSettings['parser'] })}
        />
      </div>

      <div className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Icon name="fileText" size={15} style={{ color: 'var(--primary)' }} />
          <span className="text-[14px] font-semibold t1">{PARSER_OPTIONS.find(o => o.value === active)?.label}</span>
          <span className="text-[11.5px] t3">{PARSER_OPTIONS.find(o => o.value === active)?.desc}</span>
        </div>

        {active === 'local' ? (
          <div className="flex items-center gap-2 rounded-lg px-3 py-3 text-[12.5px] t3" style={{ background: 'var(--panel-2)' }}>
            <Icon name="info" size={14} />
            本地文档解析用 PyMuPDF 直接抽取文本与图片，无需配置 API 地址与密钥；扫描件请使用 OCR 服务。
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="label mb-1">API 地址</div>
                <input
                  className="input"
                  placeholder={active === 'paddleocr' ? 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs' : 'https://...'}
                  defaultValue={conf.apiUrl}
                  key={`${active}-url`}
                  onBlur={e => updateParser({ [active]: { ...conf, apiUrl: e.target.value.trim() } } as any)}
                />
              </div>
              <div>
                <div className="label mb-1">API 密钥</div>
                <input
                  className="input" type="password" placeholder="可选"
                  key={`${active}-key`}
                  defaultValue={conf.apiKey}
                  onBlur={e => updateParser({ [active]: { ...conf, apiKey: e.target.value } } as any)}
                />
              </div>
            </div>
            {active === 'paddleocr' && (
              <div className="w-[300px]">
                <div className="label mb-1.5">解析模型</div>
                <Dropdown
                  options={PADDLE_MODELS.map(m => ({ value: m, label: m }))}
                  value={conf.model ?? PADDLE_MODELS[1]}
                  onChange={v => updateParser({ paddleocr: { ...settings.parser.paddleocr, model: v } })}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
