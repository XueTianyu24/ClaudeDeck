import { useState } from "react";
import { Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlight, themes, type PrismTheme } from "prism-react-renderer";

/**
 * 统一的 Markdown 渲染（GFM：表格/删除线/任务列表/自动链接）。
 * react-markdown 默认不渲染原始 HTML，天然防 XSS。
 * 链接点击被拦截：webview 内直接导航会替换掉整个 app 页面。
 *
 * 围栏代码块走 prism-react-renderer 语法高亮（参考 claude-code-history-viewer 同款），
 * 带语言标签 + 复制按钮；深/浅主题跟随 <html data-theme>。
 */

// 当前主题对应的 Prism 配色。app 切主题会重渲染整棵树，渲染时读 dataset 即可，无需监听。
function prismTheme(): PrismTheme {
  const dark = document.documentElement.dataset.theme !== "light";
  return dark ? themes.vsDark : themes.vsLight;
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

function CodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  async function onCopy() {
    if (await copyText(code)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }
  return (
    <div className="cb">
      <div className="cb-bar">
        <span className="cb-lang">{language || "code"}</span>
        <button className="cb-copy" onClick={onCopy} title="复制代码">
          {copied ? (
            "✓ 已复制"
          ) : (
            <>
              <Copy size={11} /> 复制
            </>
          )}
        </button>
      </div>
      <Highlight theme={prismTheme()} code={code} language={language || "text"}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="cb-pre">
            <code>
              {tokens.map((line, i) => (
                <span key={i} {...getLineProps({ line })} className="cb-line">
                  {line.map((token, k) => (
                    <span key={k} {...getTokenProps({ token })} />
                  ))}
                </span>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  );
}

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
          code({ className, children }) {
            const match = /language-(\w+)/.exec(className || "");
            const raw = String(children).replace(/\n$/, "");
            // 围栏块：有语言标记，或内容含换行（无语言的多行块）。其余按行内码。
            const isBlock = !!match || raw.includes("\n");
            if (isBlock) {
              return <CodeBlock language={match?.[1] || ""} code={raw} />;
            }
            return <code className="md-inline">{children}</code>;
          },
          // CodeBlock 自带容器，解开 react-markdown 默认的 <pre> 包裹，避免双层。
          pre({ children }) {
            return <>{children}</>;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
