import { useMemo } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { cx } from '../lib/utils'
import type { Fragment } from '../api/types'

export function Markdown({ text, className, refs, html }: {
  text: string
  className?: string
  /** 引用协议数据（步骤3）：提供时把正文里的 [[c:N]] 转为行内引用上标 */
  refs?: Fragment[]
  /** 步骤9 渲染缓存命中时直接注入的 HTML（零解析）。值与 renderMarkdown 输出
   * 逐字节一致（缓存键含渲染器版本与 md 摘要），走同一 dangerouslySetInnerHTML 路径；
   * 未提供时现场渲染。 */
  html?: string
}) {
  const rendered = useMemo(
    () => (html !== undefined ? html : renderMarkdown(text ?? '', { refs })),
    [html, text, refs])
  return <div className={cx('md', className)} dangerouslySetInnerHTML={{ __html: rendered }} />
}
