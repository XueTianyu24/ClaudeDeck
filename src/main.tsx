import React from "react";
import ReactDOM from "react-dom/client";
// Beacon 品牌字体：Space Grotesk（拉丁标题/导航）+ JetBrains Mono（数据/时间/费用）。
// 中文回落系统字体（微软雅黑/苹方），随包分发、离线可用。
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import App from "./App";
import ErrorBoundary from "./ErrorBoundary";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
