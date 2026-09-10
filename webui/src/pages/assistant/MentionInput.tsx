import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useChatStore } from '../../store/chat'
import { Icon } from '../../lib/icons'
import { cx } from '../../lib/utils'
import type { KnowledgeBase } from '../../api/types'

export interface KbChip { id: string; name: string }
const ALL_KB: KbChip = { id: '*', name: '所有知识库' }
const EMPTY_KBIDS: string[] = []

/**
 * 聊天输入框（受控：草稿与已选知识库按会话存于 chat store）：
 * - 输入 @ 弹出现有知识库列表（可继续输入过滤、点击/回车/空格选择）
 * - @all 选择所有知识库
 * - 已选知识库以标签形式显示，可删除；发送后保留（按会话持久化）
 * - 流式回复中发送键变为停止键
 * - debug2 #2：textarea 恒可输入（inputDisabled 只拦发送不拦打字——流式中
 *   能提前打字，发送由 send() 的 inputDisabled/streaming 拦截链保证）
 */
export function MentionInput({ kbs, inputDisabled, streaming, onSend, onStop }: {
  kbs: KnowledgeBase[]
  /** 发送禁用（流式中/无会话）：只禁发送，不禁输入（debug2 #2 起） */
  inputDisabled?: boolean
  streaming?: boolean
  onSend: (content: string, kbIds: string[]) => void
  onStop?: () => void
}) {
  // 受控：草稿/已选知识库按会话存 store（切会话恢复）
  const value = useChatStore(s => (s.activeId ? s.ui[s.activeId]?.draft : undefined)) ?? ''
  const kbIds = useChatStore(s => (s.activeId ? s.ui[s.activeId]?.kbIds : undefined)) ?? EMPTY_KBIDS
  const setDraft = useChatStore(s => s.setDraft)
  const patchUi = useChatStore(s => s.patchUi)

  const taRef = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [hl, setHl] = useState(0)

  const chips: KbChip[] = kbIds.map(id => ({
    id, name: id === '*' ? ALL_KB.name : kbs.find(k => k.id === id)?.name ?? id,
  }))

  const options: KbChip[] = [{ ...ALL_KB }, ...kbs.map(k => ({ id: k.id, name: k.name }))]
  const filtered = mention
    ? options.filter(o => o === ALL_KB || '@all'.startsWith(mention.query.toLowerCase()) || o.name.toLowerCase().includes(mention.query.toLowerCase()) || 'all'.includes(mention.query.toLowerCase()))
    : options

  useLayoutEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = '0px'
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'
  }, [value])

  useEffect(() => { setHl(0) }, [mention?.query])

  // 从 DOM 实时读取值与光标，避免受 React 状态更新时序影响
  const detect = () => {
    const ta = taRef.current
    if (!ta) return
    const text = ta.value
    const caret = ta.selectionStart ?? text.length
    const m = /@([^@\s]*)$/.exec(text.slice(0, caret))
    if (m) setMention({ query: m[1], start: caret - m[0].length })
    else setMention(null)
  }

  const setKbIds = (ids: string[]) => patchUi({ kbIds: ids })

  const pick = (chip: KbChip) => {
    const ta = taRef.current
    const caret = ta?.selectionStart ?? value.length
    const start = mention?.start ?? Math.max(caret - 1, 0)
    const nextIds = chip.id === '*'
      ? ['*']
      : kbIds.includes(chip.id) ? kbIds : [...kbIds.filter(c => c !== '*'), chip.id]
    setKbIds(nextIds)
    setDraft((value.slice(0, start) + value.slice(caret)).trimStart())
    setMention(null)
    taRef.current?.focus()
  }

  const send = () => {
    const text = value.trim()
    if (!text || inputDisabled || streaming) return
    onSend(text, kbIds)
    setDraft('')      // 清空文本框；chips 保留（按会话持久化）
    setMention(null)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHl(h => (h + 1) % Math.max(filtered.length, 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHl(h => (h - 1 + filtered.length) % Math.max(filtered.length, 1)); return }
      if ((e.key === 'Enter' || e.key === 'Tab') && filtered[hl]) { e.preventDefault(); pick(filtered[hl]); return }
      // 空格确认（query 非空时）：选中高亮项，空格不落入文本框
      if (e.key === ' ' && mention.query !== '' && filtered[hl]) { e.preventDefault(); pick(filtered[hl]); return }
      if (e.key === 'Escape') { setMention(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  const removeChip = (id: string) => setKbIds(kbIds.filter(c => c !== id))

  return (
    <div className="relative">
      {mention && (
        <div className="menu anim-pop absolute bottom-full left-3 z-50 mb-2 w-[300px] p-1.5">
          <div className="px-2 pb-1 pt-0.5 text-[11px] t3">选择要引用的知识库（@all 为全部）</div>
          {filtered.length === 0 && <div className="px-2 py-3 text-center text-[12px] t3">未找到匹配的知识库</div>}
          {filtered.map((o, i) => (
            <button
              key={o.id}
              className={cx('menu-item', i === hl && 'bg-[var(--hover)]')}
              onMouseEnter={() => setHl(i)}
              onClick={() => pick(o)}
            >
              <Icon name={o.id === '*' ? 'sparkles' : 'database'} size={14} style={{ color: 'var(--primary)' }} />
              <span className="flex-1 truncate">{o.name}</span>
              {o.id === '*' && <span className="text-[11px] t3">@all</span>}
            </button>
          ))}
        </div>
      )}

      {chips.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {chips.map(c => (
            <span key={c.id} className="badge badge-primary" style={{ fontSize: 11.5, gap: 5, padding: '3px 8px' }}>
              <Icon name={c.id === '*' ? 'sparkles' : 'database'} size={11} />
              {c.name}
              <button className="ml-0.5 opacity-70 hover:opacity-100" onClick={() => removeChip(c.id)}>
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
          <span className="text-[11px] t3">回答将基于以上知识库</span>
        </div>
      )}

      <div className="card flex items-end gap-2 p-2 shadow-sm">
        <button
          className="btn btn-ghost btn-icon shrink-0"
          title="输入 @ 选择知识库"
          onClick={() => {
            taRef.current?.focus()
            const next = value + (value.endsWith('@') || value === '' ? '@' : ' @')
            setDraft(next)
            // start 指向 @ 字符本身（修复：原先指向末尾，pick 切不掉按钮插入的 @）
            setMention({ query: '', start: next.length - 1 })
          }}
        >
          <Icon name="database" size={16} />
        </button>
        <textarea
          ref={taRef}
          className="textarea max-h-[160px] min-h-[38px] flex-1 border-none bg-transparent px-1 py-2 focus:bg-transparent"
          style={{ resize: 'none' }}
          placeholder={chips.length ? '基于所选知识库提问…（Shift+Enter 换行）' : '输入消息…（输入 @ 引用知识库）'}
          value={value}
          onChange={e => { setDraft(e.target.value); detect() }}
          onKeyDown={onKeyDown}
          onClick={detect}
          onKeyUp={detect}
        />
        {streaming ? (
          <button
            className="btn btn-primary btn-icon shrink-0"
            style={{ height: 34, width: 34 }}
            onClick={onStop}
            title="停止生成"
          >
            <Icon name="square" size={13} />
          </button>
        ) : (
          <button
            className="btn btn-primary btn-icon shrink-0"
            style={{ height: 34, width: 34 }}
            disabled={inputDisabled || !value.trim()}
            onClick={send}
            title="发送（Enter）"
          >
            <Icon name="send" size={15} />
          </button>
        )}
      </div>
    </div>
  )
}
