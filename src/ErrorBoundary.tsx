import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * 顶层错误边界：任一渲染异常时显示可恢复的降级页，而非整窗白屏。
 * 没有它时，单个组件抛错会让 React 卸载整棵树，用户只看到空白。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 留个控制台痕迹，方便用户反馈时附日志
    console.error("ClaudeDeck 渲染异常:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <main className="app">
        <div className="empty">
          <p>😵 界面出了点问题</p>
          <span>{error.message || String(error)}</span>
          <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
            <button className="test-btn" onClick={() => this.setState({ error: null })}>
              重试
            </button>
            <button className="test-btn" onClick={() => location.reload()}>
              重新加载
            </button>
          </div>
        </div>
      </main>
    );
  }
}
