import React from 'react'

/** 全局渲染错误兜底：白屏 -> 可重试的错误提示 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 48, textAlign: 'center', fontFamily: 'system-ui' }}>
          <div style={{ fontSize: 15, marginBottom: 8, color: '#b91c1c' }}>页面渲染出错</div>
          <div style={{ fontSize: 12.5, color: '#666', marginBottom: 16, wordBreak: 'break-all' }}>
            {this.state.error.message}
          </div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ padding: '6px 18px', cursor: 'pointer' }}
          >
            重试
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
