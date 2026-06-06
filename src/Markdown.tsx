import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 统一的 Markdown 渲染（GFM：表格/删除线/任务列表/自动链接）。
 * react-markdown 默认不渲染原始 HTML，天然防 XSS。
 * 链接点击被拦截：webview 内直接导航会替换掉整个 app 页面。
 */
export default function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            return (
              <a
                href={href}
                title={href}
                className="md-link"
                onClick={(e) => e.preventDefault()}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
