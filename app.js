/* =============================================================
 * AyayaMarkdown —— 主逻辑
 *
 * 功能模块：
 *   1. 编辑器初始化（CodeMirror）
 *   2. Markdown -> HTML 渲染（marked + highlight.js）
 *   3. LaTeX 公式渲染（KaTeX 只渲染 marked 数学扩展生成的节点）
 *   4. Mermaid 图表渲染
 *   5. 多文档侧边栏 / 文件上传 / 导出 MD / HTML / PDF
 *   6. 主题：仅深色（早期支持的浅色已移除）
 *   7. 左右面板宽度可拖拽调整
 *   8. 文档集合保存到 IndexedDB；UI 小状态仍走 localStorage
 *   9. 字数统计 + Toast 通知
 *   10. 快捷键（Ctrl+S / Ctrl+O）
 *   11. 目录锚点跳转 + 跳转后返回原位置
 *   12. 编辑器格式化工具栏（含窄宽溢出折叠）
 * ============================================================= */

(function () {
  "use strict";

  /* ---------- 顶部声明区：所有共享状态先声明，避免 TDZ 报错 ---------- */
  // 渲染防抖计时器：在 applyTheme 触发的早期 schedulePreview 中也会被读取，
  // 因此必须在第一次 schedulePreview 之前完成声明
  let renderTimer = null;
  let saveTimer = null;
  let renderVersion = 0;
  let storageWriteChain = Promise.resolve();
  const persistedDocumentVersions = new Map();
  // 保存时发生跨标签页冲突的文档：用于只提示一次
  const conflictedDocIds = new Set();
  let documentsReady = false;
  let isDragging = false;
  let isSidebarResizing = false;
  // 拖动起始锚点：避免按下时按"鼠标绝对位置"重算宽度导致瞬移，改成基于按下那一刻的宽度做增量计算
  let sidebarDragStartX = 0;
  let sidebarDragStartWidth = 0;
  let splitterDragStartX = 0;
  let splitterDragStartEditorWidth = 0;
  let activeResizePointerId = null;
  let documents = [];
  let activeDocId = null;
  let isLoadingDocument = false;
  let storageFailureShown = false;
  // 文档切换时记住每个文档当前的阅读进度（编辑器 + 预览滚动位置），
  // 仅内存保留：刷新页面后从顶部开始即可，避免持久化 + 渲染高度变化带来的复杂性
  const scrollPositions = new Map();
  // 等待下一次 renderPreview 完成后再恢复的预览滚动位置；null 表示无待恢复任务
  let pendingPreviewScrollTop = null;

  /* ---------- 默认示例文档：首次打开时展示，让用户看到所有特性 ---------- */
  const DEFAULT_DOC = `# 欢迎使用 AyayaMarkdown ✨

一款支持 **代码高亮**、**Mermaid 图表** 与 **LaTeX 公式** 的在线编辑器。
左侧编辑，右侧实时预览，所有内容自动保存到浏览器。

## 基础语法

支持 *斜体*、**粗体**、~~删除线~~、\`行内代码\`，以及 [链接](https://www.markdownguide.org/)。

> 引用块：好的工具能让创作变成一种享受。

- 无序列表项 A
- 无序列表项 B
  - 嵌套子项
- 无序列表项 C

1. 有序列表第一条
2. 有序列表第二条

- [x] 已完成的任务
- [ ] 待办任务

## 代码高亮

\`\`\`javascript
// 一段斐波那契数列的实现
function fibonacci(n) {
  if (n < 2) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

console.log(fibonacci(10)); // 55
\`\`\`

\`\`\`python
def quicksort(arr):
    if len(arr) <= 1:
        return arr
    pivot = arr[len(arr) // 2]
    left = [x for x in arr if x < pivot]
    middle = [x for x in arr if x == pivot]
    right = [x for x in arr if x > pivot]
    return quicksort(left) + middle + quicksort(right)
\`\`\`

## 数学公式（LaTeX）

行内公式：质能方程 $E = mc^2$，欧拉恒等式 $e^{i\\pi} + 1 = 0$。

块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

$$
\\frac{\\partial}{\\partial t} \\Psi(\\mathbf{r}, t) = -\\frac{i}{\\hbar} \\hat{H} \\Psi(\\mathbf{r}, t)
$$

## Mermaid 图表

\`\`\`mermaid
graph LR
  A[用户输入] --> B{是否有效?}
  B -->|是| C[渲染预览]
  B -->|否| D[显示错误]
  C --> E[导出文件]
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant U as 用户
  participant E as 编辑器
  participant P as 预览
  U->>E: 输入 Markdown
  E->>P: 实时渲染
  P-->>U: 显示结果
\`\`\`

## 表格

| 功能 | 快捷键 | 状态 |
| ---- | ------ | ---- |
| 新建 | 工具栏按钮 | ✅ |
| 上传 | Ctrl+O | ✅ |
| 导出 | Ctrl+S | ✅ |

---

现在，开始你的创作吧！🎉
`;

  /* ---------- DOM 缓存 ---------- */
  const $ = (sel) => document.querySelector(sel);
  const editorEl = $("#editor");
  const previewEl = $("#preview");
  const fileInput = $("#file-input");
  const splitter = $("#splitter");
  const sidebarToggle = $("#btn-sidebar-toggle");
  const documentSidebar = $(".document-sidebar");
  const sidebarResizer = $("#document-sidebar-resizer");
  const documentList = $("#document-list");
  const docCount = $("#doc-count");
  const editorPane = $(".pane-editor");
  const previewPane = $(".pane-preview");
  const workspace = $(".workspace");
  const statWords = $("#stat-words");
  const statChars = $("#stat-chars");
  const statLines = $("#stat-lines");
  const toastContainer = $("#toast-container");

  const requiredDependencies = {
    marked: window.marked,
    DOMPurify: window.DOMPurify,
    highlight: window.hljs,
    Mermaid: window.mermaid,
    KaTeX: window.katex,
    CodeMirror: window.CodeMirror,
  };
  const missingDependencies = Object.entries(requiredDependencies)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missingDependencies.length) {
    editorEl.disabled = true;
    previewEl.textContent = `页面依赖加载失败：${missingDependencies.join("、")}。请检查网络后刷新。`;
    console.error("Missing runtime dependencies:", missingDependencies);
    return;
  }

  let uiStorageFailureShown = false;

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      console.warn("读取 localStorage 失败:", e);
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      console.warn("写入 localStorage 失败:", e);
      if (!uiStorageFailureShown) {
        uiStorageFailureShown = true;
        // 初始主题/侧边栏设置发生在 Toast 常量初始化之前，延后到当前脚本执行完再提示。
        queueMicrotask(() => {
          showToast("界面设置无法保存，但文档仍会尝试保存到 IndexedDB", "error");
        });
      }
      return false;
    }
  }

  function safeStorageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn("清理 localStorage 失败:", e);
    }
  }

  /* =============================================================
   * 1. 侧边栏显示状态
   * 把折叠状态存到 localStorage，刷新后保持选择
   * ============================================================= */
  const SIDEBAR_COLLAPSED_KEY = "md-editor-sidebar-collapsed";
  const SIDEBAR_WIDTH_KEY = "md-editor-sidebar-width";
  const SIDEBAR_MIN_WIDTH = 180;
  const SIDEBAR_MAX_WIDTH = 420;

  function getMaxSidebarWidth() {
    let workspaceWidth = workspace?.getBoundingClientRect().width || 0;
    if (workspaceWidth < SIDEBAR_MIN_WIDTH * 2) {
      workspaceWidth = window.innerWidth || SIDEBAR_MAX_WIDTH / 0.45;
    }
    return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, workspaceWidth * 0.45));
  }

  function clampSidebarWidth(width) {
    return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(getMaxSidebarWidth(), width)));
  }

  function getInitialSidebarWidth() {
    const rawWidth = safeStorageGet(SIDEBAR_WIDTH_KEY);
    const saved = rawWidth === null ? NaN : Number(rawWidth);
    return clampSidebarWidth(Number.isFinite(saved) ? saved : 248);
  }

  function applySidebarWidth(width, shouldPersist = true) {
    const nextWidth = clampSidebarWidth(width);
    document.documentElement.style.setProperty("--sidebar-width", `${nextWidth}px`);
    if (shouldPersist) safeStorageSet(SIDEBAR_WIDTH_KEY, String(nextWidth));
    sidebarResizer.setAttribute("aria-valuemax", String(Math.round(getMaxSidebarWidth())));
    sidebarResizer.setAttribute("aria-valuenow", String(nextWidth));
    if (window.cm) {
      requestAnimationFrame(() => window.cm.refresh());
    }
  }

  function isSidebarCollapsed() {
    return safeStorageGet(SIDEBAR_COLLAPSED_KEY) === "true";
  }

  function applySidebarState(collapsed) {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    safeStorageSet(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false");
    sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
    sidebarToggle.setAttribute("aria-label", collapsed ? "显示侧边栏" : "隐藏侧边栏");
    sidebarToggle.title = collapsed ? "显示侧边栏" : "隐藏侧边栏";
    if (window.cm) {
      requestAnimationFrame(() => window.cm.refresh());
      setTimeout(() => window.cm.refresh(), 240);
    }
  }

  sidebarToggle.addEventListener("click", () => {
    applySidebarState(!document.body.classList.contains("sidebar-collapsed"));
  });

  applySidebarWidth(getInitialSidebarWidth(), false);
  applySidebarState(isSidebarCollapsed());

  /* =============================================================
   * 2. 主题：只保留深色（之前支持明暗切换，现已精简为单一深色）
   * ============================================================= */
  function applyTheme() {
    document.body.setAttribute("data-theme", "dark");

    // CodeMirror 主题（仅在已初始化后）
    if (window.cm) {
      window.cm.setOption("theme", "material-darker");
    }

    // Mermaid 主题（重新初始化后需要重渲染）
    if (window.mermaid) {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "strict",
        htmlLabels: false,
        fontFamily: "Inter, sans-serif",
      });
      // 让预览刷新一次以重渲染图表
      schedulePreview();
    }
  }

  applyTheme();
  // 清理历史 localStorage 里的主题 key（旧版本残留）
  safeStorageRemove("md-editor-theme");

  /* =============================================================
   * 3. marked 配置：开启 GFM、自动换行、代码高亮
   *
   * 关键：marked v9+ 改了自定义 renderer 的方法签名 ——
   *   旧 API：code(text, lang, escaped)
   *   新 API：code({ text, lang, escaped })   ← 接收 token 对象
   * 所以这里用普通对象 + marked.use 注册扩展，方法形参解构 token。
   * ============================================================= */

  // HTML 转义（提前定义，renderer 内部要用）
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // 页面外壳自带的 id（#preview、#editor 等）：预览里的标题和用户 HTML 不能再占用，
  // 否则同一页面出现重复 id，锚点和 getElementById 都可能指错元素。
  const RESERVED_IDS = new Set(Array.from(document.querySelectorAll("[id]"), (el) => el.id));

  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.id && RESERVED_IDS.has(node.id)) node.removeAttribute("id");
  });

  function parseAndSanitizeMarkdown(md) {
    const parsed = marked.parse(md);
    return DOMPurify.sanitize(parsed, {
      USE_PROFILES: { html: true, svg: true, svgFilters: true },
      FORBID_TAGS: ["style", "iframe", "object", "embed", "form"],
      FORBID_ATTR: ["style"],
      ALLOW_DATA_ATTR: true,
    });
  }

  /* ---------- 数学公式扩展 ----------
   * 公式只从这两个 marked token 产生，渲染阶段只对它们生成的节点调用 KaTeX。
   * 不再用 auto-render 扫全文：它会把“$5 和 $10”这类金额当成公式，
   * 也会绕过 markdown 的 \$ 转义。
   *   块级：$$...$$、\[...\]（独占段落）
   *   行内：$...$（Pandoc 规则：$ 内侧不能是空白，结尾 $ 后不能紧跟数字）、
   *         \(...\)、段落中的 $$...$$（按 display 渲染）
   */
  function earliestIndex(src, needles) {
    const indexes = needles.map((needle) => src.indexOf(needle)).filter((idx) => idx !== -1);
    return indexes.length ? Math.min(...indexes) : undefined;
  }

  const mathBlockExt = {
    name: "mathBlock",
    level: "block",
    start(src) {
      return earliestIndex(src, ["$$", "\\["]);
    },
    tokenizer(src) {
      const match =
        src.match(/^\$\$([\s\S]+?)\$\$\s*(?:\n|$)/) ||
        src.match(/^\\\[([\s\S]+?)\\\]\s*(?:\n|$)/);
      if (match) {
        return {
          type: "mathBlock",
          raw: match[0],
          text: match[1].trim(),
        };
      }
    },
    renderer(token) {
      // 公式里可能含 <、>、& 等字符，必须先转义后再拼进 HTML；
      // 渲染阶段从 textContent 取回原文交给 KaTeX。
      return `<div class="math-block">${escapeHtml(token.text)}</div>\n`;
    },
  };

  const mathInlineExt = {
    name: "mathInline",
    level: "inline",
    start(src) {
      return earliestIndex(src, ["$", "\\("]);
    },
    tokenizer(src) {
      const display = src.match(/^\$\$(?!\$)([\s\S]+?)\$\$/) || src.match(/^\\\(([\s\S]+?)\\\)/);
      if (display) {
        return {
          type: "mathInline",
          raw: display[0],
          text: display[1].trim(),
          display: display[0].startsWith("$$"),
        };
      }

      const match = src.match(/^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/);
      if (match) {
        return {
          type: "mathInline",
          raw: match[0],
          text: match[1],
          display: false,
        };
      }
    },
    renderer(token) {
      const className = token.display ? "math-inline math-display" : "math-inline";
      return `<span class="${className}">${escapeHtml(token.text)}</span>`;
    },
  };

  function renderMathNodes(root) {
    root.querySelectorAll(".math-inline, .math-block").forEach((node) => {
      try {
        window.katex.render(node.textContent, node, {
          displayMode: node.classList.contains("math-block") || node.classList.contains("math-display"),
          throwOnError: false,
        });
      } catch (e) {
        console.warn("KaTeX 渲染失败:", e);
      }
    });
  }

  /* ---------- 代码高亮缓存 ----------
   * 每次预览重渲染都会重新高亮全部代码块；未改动的块直接复用结果。
   * 未标注语言的超长代码块跳过 highlightAuto（它要把所有语言都试一遍）。
   */
  const HIGHLIGHT_CACHE_LIMIT = 200;
  const AUTO_DETECT_MAX_LENGTH = 20000;
  const highlightCache = new Map();

  function highlightCode(text, language) {
    const key = `${language}\u0000${text}`;
    if (highlightCache.has(key)) {
      const cached = highlightCache.get(key);
      highlightCache.delete(key);
      highlightCache.set(key, cached);
      return cached;
    }

    let highlighted;
    try {
      if (language && hljs.getLanguage(language)) {
        highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
      } else if (text.length <= AUTO_DETECT_MAX_LENGTH) {
        highlighted = hljs.highlightAuto(text).value;
      } else {
        highlighted = escapeHtml(text);
      }
    } catch (_) {
      highlighted = escapeHtml(text);
    }

    highlightCache.set(key, highlighted);
    if (highlightCache.size > HIGHLIGHT_CACHE_LIMIT) {
      highlightCache.delete(highlightCache.keys().next().value);
    }
    return highlighted;
  }

  marked.use({
    gfm: true,
    breaks: true,
    extensions: [mathBlockExt, mathInlineExt],
    renderer: {
      // 自定义代码块：mermaid 直通；其它语言走 highlight.js + 加语言标签 + 复制按钮
      code(token) {
        // 兼容新旧两种调用约定：v9+ 传 token 对象，旧版传 (text, lang, escaped)
        const text = typeof token === "object" ? token.text : token;
        const lang = typeof token === "object" ? token.lang : arguments[1];
        const language = (lang || "").trim().toLowerCase();

        // mermaid 块：用占位 div，渲染阶段交给 mermaid.run() 处理
        if (language === "mermaid") {
          return `<div class="mermaid">${escapeHtml(text)}</div>`;
        }

        // 普通代码块：用 highlight.js 高亮（未指定语言时尝试自动识别）
        const highlighted = highlightCode(text, language);

        const langLabel = language || "text";
        const langClass = langLabel.replace(/[^a-z0-9_-]/g, "-") || "text";
        // 复制内容直接取 <code> 的 textContent，不再把整段代码塞进 data 属性
        return `<div class="code-block-wrapper">
  <span class="code-lang-label">${escapeHtml(langLabel)}</span>
  <button class="copy-btn" type="button">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>
    复制
  </button>
  <pre><code class="hljs language-${langClass}">${highlighted}</code></pre>
</div>`;
      },
    },
  });

  function defineMarkdownEditorMode() {
    if (!window.CodeMirror || CodeMirror.modes["ayaya-markdown"]) return;

    const baseSpec = {
      name: "gfm",
      fencedCodeBlocks: true,
      highlightFormatting: true,
      strikethrough: true,
      taskLists: true,
    };

    // 与预览的行内公式规则保持一致：$ 内侧不能是空白，结尾 $ 后不能紧跟数字，
    // 这样“$5 和 $10”在编辑区也不会被着色成公式。
    function findClosingDollar(stream) {
      const line = stream.string;
      const open = stream.pos;
      if (open + 1 >= line.length || /\s/.test(line[open + 1])) return -1;
      let pos = open + 2;
      while (pos < line.length) {
        if (line[pos] === "\\") {
          pos += 2;
          continue;
        }
        if (line[pos] === "$") {
          if (/\s/.test(line[pos - 1]) || /\d/.test(line[pos + 1] || "")) return -1;
          return pos;
        }
        pos += 1;
      }
      return -1;
    }

    CodeMirror.defineMode("ayaya-markdown", (config) => {
      const baseMode = CodeMirror.getMode(config, baseSpec);

      return {
        startState() {
          return {
            base: CodeMirror.startState(baseMode),
            inBlockMath: false,
            inInlineMath: false,
          };
        },
        copyState(state) {
          return {
            base: CodeMirror.copyState(baseMode, state.base),
            inBlockMath: state.inBlockMath,
            inInlineMath: state.inInlineMath,
          };
        },
        blankLine(state) {
          if (!state.inBlockMath && baseMode.blankLine) {
            baseMode.blankLine(state.base);
          }
        },
        token(stream, state) {
          if (state.inBlockMath) {
            if (stream.match("$$")) {
              state.inBlockMath = false;
              return "math math-delimiter";
            }

            while (!stream.eol() && !stream.match("$$", false)) {
              stream.next();
            }
            return "math";
          }

          if (state.inInlineMath) {
            if (stream.match("$")) {
              state.inInlineMath = false;
              return "math math-delimiter";
            }

            while (!stream.eol() && !stream.match("$", false)) {
              stream.next();
            }
            return "math";
          }

          if (stream.match("$$")) {
            state.inBlockMath = true;
            return "math math-delimiter";
          }

          if (stream.peek() === "$") {
            const start = stream.pos;
            const line = stream.string;
            if (start > 0 && line[start - 1] === "\\") {
              return baseMode.token(stream, state.base);
            }

            if (findClosingDollar(stream) !== -1) {
              stream.next();
              state.inInlineMath = true;
              return "math math-delimiter";
            }
          }

          return baseMode.token(stream, state.base);
        },
        innerMode(state) {
          return { mode: baseMode, state: state.base };
        },
      };
    });
  }

  defineMarkdownEditorMode();

  /* =============================================================
   * 4. CodeMirror 编辑器初始化
   * ============================================================= */
  const cm = CodeMirror.fromTextArea(editorEl, {
    mode: {
      name: "ayaya-markdown",
    },
    lineNumbers: true,
    lineWrapping: true,
    theme: document.body.getAttribute("data-theme") === "dark" ? "material-darker" : "default",
    indentUnit: 2,
    tabSize: 2,
    autofocus: true,
    styleActiveLine: true,
    placeholder: "在这里开始写 Markdown…",
    // Ctrl/Cmd+S 只由 document 上的全局快捷键处理：keydown 会从编辑器冒泡上去，
    // 这里再绑一次会导出两份文件。
    extraKeys: {
      Enter: "newlineAndIndentContinueMarkdownList",
    },
  });
  window.cm = cm;
  cm.getInputField().setAttribute("aria-label", editorEl.getAttribute("aria-label") || "Markdown 编辑器");
  requestAnimationFrame(() => cm.refresh());

  /* =============================================================
   * 5. 渲染预览（带防抖）
   * ============================================================= */
  function schedulePreview() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => void renderPreview(), 120);
  }

  function bindCopyButtons(root) {
    root.querySelectorAll(".code-block-wrapper .copy-btn").forEach((btn) => {
      // 原始内容只在绑定时记一次：连续点击时不会把“已复制”当成原始内容存下来
      const original = btn.innerHTML;
      let resetTimer = null;
      btn.addEventListener("click", async () => {
        const code = btn.closest(".code-block-wrapper")?.querySelector("pre code")?.textContent || "";
        const copied = await copyToClipboard(code);
        btn.textContent = copied ? "✓ 已复制" : "复制失败";
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          btn.innerHTML = original;
        }, 1500);
      });
    });
  }

  // 预览里的外链在新标签页打开，避免点一下就把编辑器页面导航走
  function openExternalLinksInNewTab(root) {
    root.querySelectorAll("a[href]").forEach((a) => {
      if ((a.getAttribute("href") || "").startsWith("#")) return;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
  }

  // 导出的 HTML / PDF 要能在浅色背景和打印中阅读，Mermaid 改用浅色主题；
  // 用户自己写了 %%{init}%% 指令的图保持原样。
  function applyMermaidTheme(nodes, theme) {
    nodes.forEach((node) => {
      if (/^\s*%%\{/.test(node.textContent)) return;
      node.textContent = `%%{init: {"theme": "${theme}"}}%%\n${node.textContent}`;
    });
  }

  async function renderMarkdownInto(root, md, { interactive = false, mermaidTheme = null } = {}) {
    root.innerHTML = parseAndSanitizeMarkdown(md);
    renderMathNodes(root);

    const mermaidNodes = root.querySelectorAll(".mermaid");
    mermaidNodes.forEach((node) => node.removeAttribute("data-processed"));
    if (mermaidTheme) applyMermaidTheme(mermaidNodes, mermaidTheme);
    if (mermaidNodes.length) {
      try {
        await window.mermaid.run({ nodes: mermaidNodes });
      } catch (e) {
        console.warn("Mermaid 渲染失败:", e);
      }
    }

    assignHeadingIds(root);
    if (interactive) {
      bindCopyButtons(root);
      openExternalLinksInNewTab(root);
    }
  }

  async function renderPreview() {
    // 编辑器尚未初始化时直接跳过，避免在启动早期（如主题初始化）误调
    if (!window.cm) return;
    const md = cm.getValue();
    const currentRenderVersion = ++renderVersion;

    // 统计由编辑器的 change / cursorActivity 事件独立刷新，渲染失败也不影响
    try {
      await renderMarkdownInto(previewEl, md, { interactive: true });
    } catch (e) {
      console.error("Markdown preview render failed:", e);
      previewEl.textContent = "渲染失败，请打开浏览器控制台查看详情。";
      return;
    }
    if (currentRenderVersion !== renderVersion) return;

    // 切换文档时（lastJumpFrom 记录的 docId 已不是当前 doc）记录失效，隐藏返回按钮。
    // 仅在编辑当前文档导致的重新渲染时不清，保持返回按钮可用 —— previewScroll 滚动位置不会因 innerHTML 重置归零，回跳依然有意义。
    if (lastJumpFrom && lastJumpFrom.docId !== activeDocId) {
      hideJumpBackBtn();
    }

    // 文档切换后恢复阅读进度：等到本次 DOM 渲染完成后再设置预览滚动位置
    //    用两次 rAF 让浏览器把布局算完，避免设了之后被立即覆盖
    if (pendingPreviewScrollTop != null) {
      const target = pendingPreviewScrollTop;
      pendingPreviewScrollTop = null;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (previewScroll) previewScroll.scrollTop = target;
        });
      });
    }
  }

  function slugify(text) {
    return (
      String(text)
        .trim()
        .toLowerCase()
        // 用 Unicode property escapes 保留所有"字母 + 数字"——
        // 包括 CJK、日文假名、韩文谚文、欧洲带音字符（é/ñ/ü/ß 等）、希腊字母等；
        // 加上空白、下划线、连字符；其余符号一律剥掉
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s+/g, "-")
        .replace(/^-+|-+$/g, "") || "section"
    );
  }

  // 按出现顺序给标题分配 id：同名标题加序号区分，并跳过页面外壳占用的 id。
  // 预览渲染和源码扫描共用同一规则，保证两边算出的 id 一致。
  function createHeadingIdAllocator() {
    const used = Object.create(null);
    return (text) => {
      const base = slugify(text);
      let id;
      do {
        used[base] = used[base] === undefined ? 0 : used[base] + 1;
        id = used[base] === 0 ? base : `${base}-${used[base]}`;
      } while (RESERVED_IDS.has(id));
      return id;
    };
  }

  function assignHeadingIds(root) {
    const nextId = createHeadingIdAllocator();
    root.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
      h.id = nextId(h.textContent);
    });
  }

  /* ---------- 目录锚点跳转 + 返回上次位置 ---------- */
  // 预览区滚动容器（不是 #preview 自己，而是它的父级 .pane-body）
  const previewScroll = previewEl.parentElement;
  const jumpBackBtn = document.getElementById("btn-jump-back");
  // 跳转前的滚动位置；为 null 表示当前没有可返回的状态
  // editorTop 用 CodeMirror scroller 的 scrollTop 表示
  let lastJumpFrom = null;

  function showJumpBackBtn() {
    if (!jumpBackBtn) return;
    jumpBackBtn.hidden = false;
    // 触发一次重排再加 .visible，让淡入过渡能生效
    requestAnimationFrame(() => jumpBackBtn.classList.add("visible"));
  }

  function hideJumpBackBtn() {
    if (!jumpBackBtn) return;
    jumpBackBtn.classList.remove("visible");
    jumpBackBtn.hidden = true;
    lastJumpFrom = null;
  }

  // 在源 markdown 里按出现顺序找标题行，给出和预览区一致的 slug
  // 返回 [{line, level, text, id}, ...]
  // 支持两种语法：ATX（# 开头）和 setext（下一行用 === 或 ---）
  function listSourceHeadings() {
    if (!window.cm) return [];
    const src = cm.getValue();
    const lines = src.split("\n");
    const nextId = createHeadingIdAllocator();
    const result = [];
    let inFence = false;
    // 围栏代码块（``` 或 ~~~），代码块内的 # 不算标题
    const fenceRe = /^\s{0,3}(`{3,}|~{3,})/;
    const atxRe = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
    // setext 风格的下划线行：`===…`(h1) 或 `---…`(h2)；前提是上一行非空
    const setextH1Re = /^=+\s*$/;
    const setextH2Re = /^-+\s*$/;

    function pushHeading(line, level, text) {
      result.push({ line, level, text, id: nextId(text) });
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (fenceRe.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;

      // ATX 标题
      const m = line.match(atxRe);
      if (m) {
        pushHeading(i, m[1].length, m[2]);
        continue;
      }

      // setext：当前行是 === / ---，且上一行有内容 → 上一行是标题
      if (i > 0) {
        const prev = lines[i - 1];
        const prevTrim = prev.trim();
        if (prevTrim && !atxRe.test(prev)) {
          if (setextH1Re.test(line)) {
            pushHeading(i - 1, 1, prevTrim);
            continue;
          }
          if (setextH2Re.test(line) && /^-{2,}\s*$/.test(line)) {
            // 至少两个 - 才认为是 h2，避免和水平分割线 / 列表前缀混淆
            pushHeading(i - 1, 2, prevTrim);
            continue;
          }
        }
      }
    }
    return result;
  }

  // 把 CodeMirror 滚动到指定行，平滑动画。
  // heightAtLine 比 charCoords 更稳定：charCoords 对未渲染的视口外行只给估算值，
  // 跨长距离跳转时容易偏；heightAtLine 用 CodeMirror 内部行高累计树，无论行在不在视口都准确。
  // 不做延迟校正：动画期间用 instant scroll 打断 smooth 会造成"突然卡住"的视觉。
  function preferredScrollBehavior() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  }

  function smoothScrollEditorToLine(lineNo) {
    if (!window.cm) return;
    const scroller = cm.getScrollerElement();
    const target = Math.max(0, cm.heightAtLine(lineNo, "local") - 12);
    scroller.scrollTo({ top: target, behavior: preferredScrollBehavior() });
  }

  // 把预览区平滑滚动到目标元素。
  // 用户点 anchor 时 renderPreview 早已跑完，KaTeX 同步、Mermaid promise 也已 resolve，
  // DOM 高度此时是稳定的，无需"动画期间校正"——校正反而会打断 smooth 动画造成卡顿。
  function smoothScrollPreviewToElement(targetEl) {
    if (!targetEl || !previewScroll) return;
    const target = Math.max(
      0,
      targetEl.getBoundingClientRect().top
        - previewScroll.getBoundingClientRect().top
        + previewScroll.scrollTop
        - 24
    );
    previewScroll.scrollTo({ top: target, behavior: preferredScrollBehavior() });
  }

  // 拦截预览区里所有锚点链接（[xx](#anchor)）：在容器内部滚动到目标，并记录跳转前位置
  previewEl.addEventListener("click", (e) => {
    const a = e.target.closest('a[href]');
    if (!a || !previewEl.contains(a)) return;
    const href = a.getAttribute("href") || "";
    if (!href.startsWith("#") || href === "#") return;

    // 解码：marked 可能会对中文锚点做 URI 编码
    let id;
    try {
      id = decodeURIComponent(href.slice(1));
    } catch (_) {
      id = href.slice(1);
    }

    // 1) 精确按 id 找
    let target = null;
    try {
      target = previewEl.querySelector(`#${CSS.escape(id)}`);
    } catch (_) {
      target = null;
    }

    // 2) 兜底：按 slug(textContent) 匹配 —— 兼容用户用其他工具生成 TOC、slug 规则略有差异的情况
    if (!target) {
      const wantSlug = slugify(id.replace(/-/g, " "));
      const headings = previewEl.querySelectorAll("h1, h2, h3, h4, h5, h6");
      for (const h of headings) {
        if (h.id === id || slugify(h.textContent) === wantSlug) {
          target = h;
          break;
        }
      }
    }
    if (!target) return;

    e.preventDefault();
    // 同时记录预览区与编辑器当前滚动位置，便于"返回"恢复；docId 用于切换文档时判定失效
    const editorScroller = window.cm ? cm.getScrollerElement() : null;
    lastJumpFrom = {
      docId: activeDocId,
      previewTop: previewScroll.scrollTop,
      editorTop: editorScroller ? editorScroller.scrollTop : 0,
    };

    // 1) 预览区滚动
    smoothScrollPreviewToElement(target);

    // 2) 编辑器同步跳到对应的标题行
    //    用源码扫描 + slug 匹配的方式而不是依赖 DOM —— DOM 只给 id，没源行信息。
    //    注意：不动光标。CodeMirror 在 setCursor 后会把光标"滚进可视区"，
    //    会和我们的 smooth scroll 抢，导致标题被塞到可视区底部；
    //    返回按钮也会被这个机制反复拉回光标行，所以这里只滚 scroller。
    const headings = listSourceHeadings();
    const targetId = target.id || id;
    let match = headings.find((h) => h.id === targetId);
    if (!match) {
      // id 不一致时按文本兜底
      const wantSlug = slugify(target.textContent);
      match = headings.find((h) => h.id === wantSlug || slugify(h.text) === wantSlug);
    }
    if (match && window.cm) {
      smoothScrollEditorToLine(match.line);
    }

    showJumpBackBtn();
  });

  if (jumpBackBtn) {
    jumpBackBtn.addEventListener("click", () => {
      if (!lastJumpFrom) {
        hideJumpBackBtn();
        return;
      }
      previewScroll.scrollTo({ top: lastJumpFrom.previewTop, behavior: preferredScrollBehavior() });
      if (window.cm) {
        cm.getScrollerElement().scrollTo({
          top: lastJumpFrom.editorTop,
          behavior: preferredScrollBehavior(),
        });
      }
      hideJumpBackBtn();
    });
  }

  /* =============================================================
   * 6. 字数 / 行数 / 字符数统计
   * ============================================================= */
  // 字数口径：汉字 / 日文假名逐字计数；其余文字按空白分词，
  // 只含标点或 Markdown 符号（#、-、** 等）的片段不计入。
  const CJK_CHAR_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
  const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

  function countWords(text) {
    const cjkCount = (text.match(CJK_CHAR_RE) || []).length;
    const otherWords = text
      .replace(CJK_CHAR_RE, " ")
      .split(/\s+/)
      .filter((token) => WORD_CHAR_RE.test(token)).length;
    return cjkCount + otherWords;
  }

  // change 与 cursorActivity 在一次输入里会连续触发，合并到下一帧只统计一次全文
  let statsFrame = 0;
  function scheduleStats() {
    if (statsFrame) return;
    statsFrame = requestAnimationFrame(() => {
      statsFrame = 0;
      try {
        updateStats(cm.getValue());
      } catch (e) {
        console.error("updateStats failed:", e);
      }
    });
  }

  function updateStats(text) {
    const totalChars = text.length;
    const totalWords = countWords(text);
    const selections = cm.getSelections();
    const selectedChars = selections.reduce((total, selection) => total + selection.length, 0);
    const selectedWords = selections.reduce((total, selection) => total + countWords(selection), 0);
    const hasSelection = selectedChars > 0;

    statChars.textContent = hasSelection
      ? `${selectedChars.toLocaleString()} / ${totalChars.toLocaleString()}`
      : totalChars.toLocaleString();
    statLines.textContent = (text ? text.split("\n").length : 0).toLocaleString();
    // 单词数沿用原有口径：按空白分隔，选区与全文使用同一规则。
    statWords.textContent = hasSelection
      ? `${selectedWords.toLocaleString()} / ${totalWords.toLocaleString()}`
      : totalWords.toLocaleString();
  }

  /* =============================================================
   * 7. 多文档管理：内容保存到 IndexedDB，UI 状态保存到 localStorage
   * ============================================================= */
  const DOCUMENTS_KEY = "md-editor-documents";
  const ACTIVE_DOCUMENT_KEY = "md-editor-active-document";
  const LEGACY_DRAFT_KEY = "md-editor-draft";

  /* ---------- IndexedDB 存储层 ----------
   * 文档内容（可能很大，包含代码块/Mermaid/将来可能粘贴的图片）放 IndexedDB；
   * UI 状态（主题、侧边栏宽度、当前激活 docId）继续放 localStorage —— 都是几十字节的小数据，
   * 同步读写更顺手，也不会撞上配额。
   *
   * 历史包袱：旧版本把整个 documents 数组塞 localStorage（5-10 MB 上限），
   * 文档稍多就容易写入失败。这里启动时一次性迁移到 IDB 后删除老 key。
   */
  const IDB_NAME = "ayaya-markdown";
  const IDB_VERSION = 1;
  const IDB_STORE = "documents";
  let idbPromise = null;

  function openIdb() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("当前浏览器不支持 IndexedDB"));
        return;
      }
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          // keyPath 用 doc.id；后续写入直接 put 即可
          db.createObjectStore(IDB_STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          idbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        idbPromise = null;
        reject(req.error);
      };
      req.onblocked = () => {
        idbPromise = null;
        reject(new Error("IndexedDB 升级被其他标签页阻塞"));
      };
    });
    return idbPromise;
  }

  async function idbReadAll() {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  // 仅用于旧数据迁移和首次初始化（且只在确认 IDB 为空时调用）；日常保存走单文档 put。
  // 绝不 clear()：万一读取失败被误判为空库，也不能把已有文档抹掉。
  async function idbPutAll(docs) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      docs.forEach((doc) => store.put(doc));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  class DocumentConflictError extends Error {
    constructor(docId) {
      super(`文档 ${docId} 已在另一个标签页中更新`);
      this.name = "DocumentConflictError";
      this.docId = docId;
    }
  }

  async function idbPutDocument(doc, expectedUpdatedAt) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      let conflict = null;
      const getRequest = store.get(doc.id);
      getRequest.onsuccess = () => {
        const storedVersion = Number(getRequest.result?.updatedAt) || 0;
        if (storedVersion !== expectedUpdatedAt) {
          conflict = new DocumentConflictError(doc.id);
          tx.abort();
          return;
        }
        store.put(doc);
      };
      getRequest.onerror = () => reject(getRequest.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(conflict || tx.error);
    });
  }

  async function idbDeleteDocument(docId, expectedUpdatedAt) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      let conflict = null;
      const getRequest = store.get(docId);
      getRequest.onsuccess = () => {
        const storedVersion = Number(getRequest.result?.updatedAt) || 0;
        if (storedVersion !== expectedUpdatedAt) {
          conflict = new DocumentConflictError(docId);
          tx.abort();
          return;
        }
        store.delete(docId);
      };
      getRequest.onerror = () => reject(getRequest.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(conflict || tx.error);
    });
  }

  function enqueueStorageWrite(operation, showError = false) {
    const task = storageWriteChain.then(operation);
    storageWriteChain = task.catch(() => undefined);
    return task.then(
      () => {
        storageFailureShown = false;
        return true;
      },
      (e) => {
        console.warn("保存文档到 IndexedDB 失败:", e);
        if (e instanceof DocumentConflictError) {
          // 冲突状态下后续每次保存都会失败，同一文档只提示一次，避免 toast 刷屏
          if (!conflictedDocIds.has(e.docId)) {
            conflictedDocIds.add(e.docId);
            showToast("另一标签页已更新此文档；本页未覆盖远端版本，请导出备份后刷新", "error");
          }
          return false;
        }
        if (showError || !storageFailureShown) {
          showToast("文档保存失败，可能是浏览器本地空间不足", "error");
          void checkStorageQuota();
        }
        storageFailureShown = true;
        return false;
      }
    );
  }

  // 估算本地存储用量；Chrome/Firefox 实测 quota 一般是磁盘空闲的几十 %，
  // 但用户开了大量文档/粘贴大图后还是有可能告急。超 80% 给个提示让用户感知。
  async function checkStorageQuota() {
    if (!navigator.storage || !navigator.storage.estimate) return;
    try {
      const { usage, quota } = await navigator.storage.estimate();
      if (!quota) return;
      const ratio = usage / quota;
      if (ratio > 0.8) {
        const usedMB = Math.round(usage / 1024 / 1024);
        showToast(
          `本地存储已用 ${Math.round(ratio * 100)}%（约 ${usedMB} MB），建议导出备份`,
          "info"
        );
      }
    } catch (_) {
      // estimate 偶尔会拒绝（比如 file:// 协议下），静默忽略即可
    }
  }

  function makeDocumentId() {
    return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function cleanTitle(title) {
    return String(title || "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function stripMarkdownSyntax(line) {
    return line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+\.\s+/, "")
      .replace(/^\[[ xX]\]\s+/, "")
      .replace(/[*_`~>#]/g, "")
      .trim();
  }

  // 在 markdown 文本里找第一个标题（ATX `# xxx` 或 setext `xxx\n===`），返回标题文本；
  // 找不到返回空串。围栏代码块（``` 或 ~~~）内部的 # 不算标题。
  function findFirstHeadingText(md) {
    const lines = String(md || "").split(/\r?\n/);
    let inFence = false;
    const fenceRe = /^\s{0,3}(`{3,}|~{3,})/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (fenceRe.test(line)) { inFence = !inFence; continue; }
      if (inFence) continue;

      const atxM = line.match(/^#\s+(.+?)\s*#*\s*$/);
      if (atxM) return atxM[1].trim();

      // setext：上一行非空且非 ATX，本行为 === 或 ---（h2 至少两个 - 以避免水平线/列表混淆）
      if (i > 0) {
        const prev = lines[i - 1].trim();
        if (prev && !/^#{1,6}\s+/.test(prev)) {
          if (/^=+\s*$/.test(line) || /^-{2,}\s*$/.test(line)) return prev;
        }
      }
    }
    return "";
  }

  function inferDocumentTitle(md, fallback = "未命名文档") {
    const heading = findFirstHeadingText(md);
    if (heading) return cleanTitle(heading) || fallback;

    const firstContentLine = String(md || "")
      .split(/\r?\n/)
      .map((line) => stripMarkdownSyntax(line))
      .find(Boolean);

    return cleanTitle(firstContentLine) || fallback;
  }

  function createDocumentRecord({
    id = makeDocumentId(),
    title,
    content = "",
    source = "created",
    createdAt = Date.now(),
    updatedAt = Date.now(),
  } = {}) {
    const safeSource = ["created", "uploaded", "sample"].includes(source) ? source : "created";
    return {
      id,
      title: cleanTitle(title) || inferDocumentTitle(content),
      content: String(content || ""),
      source: safeSource,
      createdAt: Number(createdAt) || Date.now(),
      updatedAt: Number(updatedAt) || Date.now(),
    };
  }

  // 读取旧版本写在 localStorage 里的文档（仅迁移用，迁移完即删掉老 key）
  function readLegacyLocalStorageDocuments() {
    try {
      const raw = safeStorageGet(DOCUMENTS_KEY);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed.documents;
      if (!Array.isArray(list)) return [];

      return list
        .filter((doc) => doc && typeof doc === "object" && doc.id)
        .map((doc) => createDocumentRecord(doc));
    } catch (e) {
      console.warn("读取旧 localStorage 文档列表失败:", e);
      return [];
    }
  }

  function sortDocuments(list) {
    return list.sort((a, b) => {
      const timeDiff = b.createdAt - a.createdAt;
      return timeDiff || b.id.localeCompare(a.id);
    });
  }

  async function initializeDocuments() {
    // 1) 优先从 IndexedDB 读
    let loaded = [];
    let readFailed = false;
    try {
      const raw = await idbReadAll();
      loaded = raw.map((doc) => createDocumentRecord(doc));
    } catch (e) {
      console.warn("IndexedDB 读取失败:", e);
      readFailed = true;
    }

    // 读取失败 ≠ 空库：不迁移、不写入、不清理旧 key，只给一篇临时文档。
    // 临时文档被编辑后按新 id 单独保存，不会覆盖库里已有的文档。
    if (readFailed) {
      documents = [createDocumentRecord({ title: "未命名文档", content: "" })];
      persistedDocumentVersions.clear();
      activeDocId = documents[0].id;
      showToast("本地文档读取失败，已打开临时文档；已有文档不会被覆盖，请稍后刷新", "error");
      return;
    }

    // 2) IDB 空，尝试迁移老版本写在 localStorage 里的 documents
    if (!loaded.length) {
      const legacy = readLegacyLocalStorageDocuments();
      if (legacy.length) {
        loaded = legacy;
        try {
          await idbPutAll(loaded);
          // 迁移成功才删 localStorage 里的老数据，失败保留以便下次重试
          safeStorageRemove(DOCUMENTS_KEY);
          console.log("[AyayaMarkdown] 已从 localStorage 迁移文档到 IndexedDB");
        } catch (e) {
          console.warn("迁移到 IndexedDB 失败，保留 localStorage 中的副本:", e);
        }
      }
    }

    // 3) 还是空，使用更早期的 LEGACY_DRAFT 或默认欢迎文档
    if (!loaded.length) {
      const legacyDraft = safeStorageGet(LEGACY_DRAFT_KEY);
      const content = legacyDraft && legacyDraft.length > 0 ? legacyDraft : DEFAULT_DOC;
      loaded = [
        createDocumentRecord({
          title: legacyDraft ? inferDocumentTitle(legacyDraft) : "欢迎文档",
          content,
          source: legacyDraft ? "created" : "sample",
        }),
      ];
      try {
        await idbPutAll(loaded);
        safeStorageRemove(LEGACY_DRAFT_KEY);
      } catch (_) {
        // 即便首次写失败也不影响进入界面，后续单文档保存还会重试
      }
    }

    documents = sortDocuments(loaded);
    persistedDocumentVersions.clear();
    documents.forEach((doc) => persistedDocumentVersions.set(doc.id, doc.updatedAt));

    const storedActiveId = safeStorageGet(ACTIVE_DOCUMENT_KEY);
    activeDocId = documents.some((doc) => doc.id === storedActiveId)
      ? storedActiveId
      : documents[0].id;
    safeStorageSet(ACTIVE_DOCUMENT_KEY, activeDocId);
  }

  function getActiveDocument() {
    return documents.find((doc) => doc.id === activeDocId) || documents[0] || null;
  }

  function persistDocument(doc, showError = false) {
    if (!doc) return Promise.resolve(false);
    if (activeDocId) safeStorageSet(ACTIVE_DOCUMENT_KEY, activeDocId);
    // 捕获调用时的不可变快照，避免排队期间被后续输入改写。
    const snapshot = { ...doc };
    return enqueueStorageWrite(async () => {
      const expectedUpdatedAt = persistedDocumentVersions.get(snapshot.id) || 0;
      await idbPutDocument(snapshot, expectedUpdatedAt);
      persistedDocumentVersions.set(snapshot.id, snapshot.updatedAt);
      conflictedDocIds.delete(snapshot.id);
      announceDocumentsChanged();
    }, showError);
  }

  function removeDocumentFromStorage(docId, showError = false) {
    return enqueueStorageWrite(async () => {
      const expectedUpdatedAt = persistedDocumentVersions.get(docId) || 0;
      await idbDeleteDocument(docId, expectedUpdatedAt);
      persistedDocumentVersions.delete(docId);
      conflictedDocIds.delete(docId);
      announceDocumentsChanged();
    }, showError);
  }

  // 只有内容真的变了才推进版本号。切标签页、切文档、导出都会 flush，
  // 如果无条件刷新 updatedAt，就会让其他标签页误判冲突，列表也会把旧文档显示成“刚刚”。
  function updateDocumentSnapshot(doc, content) {
    if (doc.content === content) return false;
    doc.content = content;
    doc.updatedAt = Math.max(Date.now(), (Number(doc.updatedAt) || 0) + 1);
    return true;
  }

  function refreshDocumentTitle(doc) {
    if (doc.source === "uploaded") return false;
    const previousTitle = doc.title;
    doc.title = inferDocumentTitle(doc.content);
    return doc.title !== previousTitle;
  }

  // 本地有尚未成功写入 IndexedDB 的修改
  function isDocumentDirty(doc) {
    return doc.updatedAt !== persistedDocumentVersions.get(doc.id);
  }

  function queueCurrentDocumentSave(content) {
    const doc = getActiveDocument();
    if (!doc || !updateDocumentSnapshot(doc, content)) return;

    // 标题推断要扫描全文，放进防抖里做，不在每次按键时跑
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      refreshDocumentTitle(doc);
      renderDocumentList();
      void persistDocument(doc);
    }, 250);
  }

  function flushCurrentDocument() {
    clearTimeout(saveTimer);
    if (!window.cm || !activeDocId || isLoadingDocument) return Promise.resolve(false);

    const doc = getActiveDocument();
    if (!doc) return Promise.resolve(false);

    updateDocumentSnapshot(doc, cm.getValue());
    if (!isDocumentDirty(doc)) return Promise.resolve(true);
    // 读取失败时给的临时空文档：没写过内容就不落库
    if (!persistedDocumentVersions.has(doc.id) && !doc.content) return Promise.resolve(true);

    refreshDocumentTitle(doc);
    renderDocumentList();
    return persistDocument(doc, true);
  }

  /* ---------- 跨标签页同步 ----------
   * 任一标签页写库成功后广播一次；其他标签页重读 IndexedDB：
   *   - 本地没有未保存修改的文档直接换成新版本（当前文档会就地刷新编辑器）
   *   - 本地有未保存修改的文档保持不动，之后保存时由版本检查报冲突
   *   - 其他标签页新建 / 删除的文档同步进列表
   */
  const syncChannel = typeof BroadcastChannel === "function" ? new BroadcastChannel("ayaya-markdown-documents") : null;
  let remoteSyncTimer = null;

  function announceDocumentsChanged() {
    try {
      syncChannel?.postMessage({ type: "documents-changed" });
    } catch (e) {
      console.warn("广播文档更新失败:", e);
    }
  }

  syncChannel?.addEventListener("message", (e) => {
    if (e.data?.type !== "documents-changed") return;
    clearTimeout(remoteSyncTimer);
    remoteSyncTimer = setTimeout(() => void syncDocumentsFromStorage(), 50);
  });

  function reloadActiveDocumentInPlace(doc) {
    const cursor = cm.getCursor();
    const scroll = cm.getScrollInfo();
    isLoadingDocument = true;
    try {
      cm.setValue(doc.content || "");
    } finally {
      isLoadingDocument = false;
    }
    cm.setCursor(cursor);
    cm.scrollTo(scroll.left, scroll.top);
    scheduleStats();
    schedulePreview();
  }

  async function syncDocumentsFromStorage() {
    if (!documentsReady || !window.cm) return;

    let stored;
    try {
      stored = (await idbReadAll()).map((doc) => createDocumentRecord(doc));
    } catch (e) {
      console.warn("同步其他标签页的文档失败:", e);
      return;
    }

    const storedById = new Map(stored.map((doc) => [doc.id, doc]));
    const next = [];
    let activeContentChanged = false;

    documents.forEach((doc) => {
      const remote = storedById.get(doc.id);
      storedById.delete(doc.id);
      const dirty = isDocumentDirty(doc);

      if (remote) {
        if (!dirty && remote.updatedAt !== doc.updatedAt) {
          if (doc.id === activeDocId && remote.content !== doc.content) activeContentChanged = true;
          Object.assign(doc, remote);
          persistedDocumentVersions.set(doc.id, remote.updatedAt);
          conflictedDocIds.delete(doc.id);
        }
        next.push(doc);
      } else if (dirty || !persistedDocumentVersions.has(doc.id)) {
        // 库里没有，但本地有未保存内容或从未保存过：保留
        next.push(doc);
      } else {
        // 其他标签页删除了它
        persistedDocumentVersions.delete(doc.id);
        scrollPositions.delete(doc.id);
      }
    });

    storedById.forEach((remote) => {
      next.push(remote);
      persistedDocumentVersions.set(remote.id, remote.updatedAt);
    });

    // 删除最后一篇时，替补文档会在下一次广播里到达，这里先不清空列表
    if (!next.length) return;

    documents = sortDocuments(next);
    if (!documents.some((doc) => doc.id === activeDocId)) {
      activeDocId = documents[0].id;
      safeStorageSet(ACTIVE_DOCUMENT_KEY, activeDocId);
      loadActiveDocumentIntoEditor();
      return;
    }

    if (activeContentChanged) reloadActiveDocumentInPlace(getActiveDocument());
    renderDocumentList();
  }

  // 记录当前活动文档的滚动位置（编辑器 + 预览），供切换回来时恢复用
  function captureCurrentScroll() {
    if (!activeDocId) return;
    const editorScroller = window.cm ? cm.getScrollerElement() : null;
    scrollPositions.set(activeDocId, {
      editorTop: editorScroller ? editorScroller.scrollTop : 0,
      previewTop: previewScroll ? previewScroll.scrollTop : 0,
    });
  }

  function loadActiveDocumentIntoEditor() {
    const doc = getActiveDocument();
    if (!doc) return;

    activeDocId = doc.id;
    isLoadingDocument = true;
    try {
      cm.setValue(doc.content || "");
    } finally {
      isLoadingDocument = false;
    }

    updateStats(doc.content || "");

    // 跳转返回状态如果不属于当前文档，立即失效（覆盖删除当前文档等切换路径）
    if (lastJumpFrom && lastJumpFrom.docId !== doc.id) {
      hideJumpBackBtn();
    }

    // 拿出之前记下的滚动位置：编辑器在 refresh 后立即设；预览要等 renderPreview 跑完才能设
    const saved = scrollPositions.get(doc.id);
    pendingPreviewScrollTop = saved ? saved.previewTop : 0;

    schedulePreview();
    renderDocumentList();
    requestAnimationFrame(() => {
      cm.refresh();
      const editorScroller = cm.getScrollerElement();
      if (editorScroller) editorScroller.scrollTop = saved ? saved.editorTop : 0;
    });
  }

  function switchDocument(docId) {
    if (!docId || docId === activeDocId) return;

    const next = documents.find((doc) => doc.id === docId);
    if (!next) return;

    captureCurrentScroll();
    // 切换文档前清掉"跳转返回"状态：滚动位置属于上一篇文档，留着会跳错位置
    hideJumpBackBtn();
    void flushCurrentDocument();
    activeDocId = next.id;
    safeStorageSet(ACTIVE_DOCUMENT_KEY, activeDocId);
    loadActiveDocumentIntoEditor();
  }

  function deleteDocument(docId) {
    const index = documents.findIndex((doc) => doc.id === docId);
    if (index === -1) return;

    const doc = documents[index];
    if (!confirm(`删除“${doc.title}”？`)) return;

    void flushCurrentDocument();
    const wasActive = doc.id === activeDocId;
    documents.splice(index, 1);
    void removeDocumentFromStorage(doc.id, true);

    if (!documents.length) {
      const replacement = createDocumentRecord({ title: "未命名文档", content: "" });
      documents.push(replacement);
      void persistDocument(replacement, true);
    }

    if (wasActive) {
      const next = documents[Math.min(index, documents.length - 1)];
      activeDocId = next.id;
      safeStorageSet(ACTIVE_DOCUMENT_KEY, activeDocId);
      loadActiveDocumentIntoEditor();
    } else {
      renderDocumentList();
    }

    showToast("文档已删除", "info");
  }

  function getSourceLabel(source) {
    if (source === "uploaded") return "上传";
    if (source === "sample") return "示例";
    return "新建";
  }

  function formatUpdatedAt(timestamp) {
    const diff = Date.now() - Number(timestamp);
    if (!Number.isFinite(diff) || diff < 0) return "";
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;

    const date = new Date(timestamp);
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function renderDocumentList() {
    docCount.textContent = documents.length.toLocaleString();
    // 整个列表会重建，记住焦点所在的文档按钮，重建后放回去（键盘切换文档时不丢焦点）
    const focusedDocId = documentList.contains(document.activeElement)
      ? document.activeElement.closest("[data-doc-id]")?.dataset.docId
      : null;

    documentList.innerHTML = documents
      .map((doc) => {
        const isActive = doc.id === activeDocId;
        const title = escapeHtml(doc.title || "未命名文档");
        const meta = escapeHtml(`${getSourceLabel(doc.source)} · ${formatUpdatedAt(doc.updatedAt)}`);
        const id = escapeHtml(doc.id);

        return `<div class="document-item${isActive ? " active" : ""}" role="listitem">
  <button class="document-switch" type="button" data-doc-id="${id}"${isActive ? ' aria-current="true"' : ""}>
    <svg class="document-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
    <span class="document-info">
      <span class="document-title">${title}</span>
      <span class="document-meta">${meta}</span>
    </span>
  </button>
  <button class="document-delete" type="button" data-delete-doc="${id}" title="删除文档" aria-label="删除 ${title}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  </button>
</div>`;
      })
      .join("");

    if (focusedDocId) {
      const button = Array.from(documentList.querySelectorAll(".document-switch")).find(
        (item) => item.dataset.docId === focusedDocId
      );
      button?.focus();
    }
  }

  // 文档列表键盘导航：上下（窄屏横排时左右）方向键在文档之间移动焦点
  documentList.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const buttons = Array.from(documentList.querySelectorAll(".document-switch"));
    const currentIndex = buttons.indexOf(e.target.closest(".document-switch"));
    if (currentIndex === -1) return;
    e.preventDefault();
    let nextIndex;
    if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = buttons.length - 1;
    else if (e.key === "ArrowDown" || e.key === "ArrowRight") nextIndex = Math.min(buttons.length - 1, currentIndex + 1);
    else nextIndex = Math.max(0, currentIndex - 1);
    buttons[nextIndex].focus();
  });

  documentList.addEventListener("click", (e) => {
    const deleteButton = e.target.closest("[data-delete-doc]");
    if (deleteButton) {
      deleteDocument(deleteButton.dataset.deleteDoc);
      return;
    }

    const switchButton = e.target.closest("[data-doc-id]");
    if (switchButton) switchDocument(switchButton.dataset.docId);
  });

  window.addEventListener("beforeunload", () => void flushCurrentDocument());
  window.addEventListener("pagehide", () => void flushCurrentDocument());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushCurrentDocument();
  });

  /* =============================================================
   * 8. 文件操作：新建 / 上传 / 导出
   * ============================================================= */
  function newDocument() {
    void flushCurrentDocument();

    const doc = createDocumentRecord({ title: "未命名文档", content: "" });
    documents.unshift(doc);
    activeDocId = doc.id;
    void persistDocument(doc, true);
    loadActiveDocumentIntoEditor();
    cm.focus();
    showToast("已新建空白文档", "info");
  }

  function openFile() {
    fileInput.click();
  }

  fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = typeof reader.result === "string" ? reader.result : "";
      const doc = createDocumentRecord({
        title: stripFileExtension(file.name),
        content,
        source: "uploaded",
      });

      void flushCurrentDocument();
      documents.unshift(doc);
      activeDocId = doc.id;
      void persistDocument(doc, true);
      loadActiveDocumentIntoEditor();
      showToast(`已添加 ${file.name}`, "success");
    };
    reader.onerror = () => showToast("文件读取失败", "error");
    reader.readAsText(file, "utf-8");
    // 重置 input 以便同一文件可以再次选择
    fileInput.value = "";
  });

  function exportMarkdown() {
    void flushCurrentDocument();
    const md = cm.getValue();
    if (!md.trim()) {
      showToast("内容为空，无法导出", "error");
      return;
    }
    const filename = inferFilename(md, getActiveDocument()?.title) + ".md";
    downloadBlob(md, filename, "text/markdown;charset=utf-8");
    showToast(`已导出 ${filename}`, "success");
  }

  async function renderExportBody(md) {
    const host = document.createElement("div");
    host.className = "export-render-host";
    host.setAttribute("aria-hidden", "true");
    const root = document.createElement("article");
    root.className = "markdown-body";
    host.appendChild(root);
    document.body.appendChild(host);

    try {
      await renderMarkdownInto(root, md, { mermaidTheme: "default" });
      root.querySelectorAll(".copy-btn").forEach((button) => button.remove());
      return root.innerHTML;
    } finally {
      host.remove();
    }
  }

  async function exportHtml() {
    void flushCurrentDocument();
    const md = cm.getValue();
    if (!md.trim()) {
      showToast("内容为空，无法导出", "error");
      return;
    }
    try {
      const bodyHtml = await renderExportBody(md);
      const title = inferFilename(md, getActiveDocument()?.title);
      const fullHtml = buildExportableHtml(title, bodyHtml);
      downloadBlob(fullHtml, title + ".html", "text/html;charset=utf-8");
      showToast(`已导出 ${title}.html`, "success");
    } catch (e) {
      console.error("HTML export failed:", e);
      showToast("HTML 导出失败，请检查文档中的 Mermaid 语法", "error");
    }
  }

  async function exportPdf() {
    void flushCurrentDocument();
    const md = cm.getValue();
    if (!md.trim()) {
      showToast("内容为空，无法导出", "error");
      return;
    }
    // 必须在用户点击的同步阶段打开窗口，否则等待 Mermaid 后会被 popup blocker 拦截。
    const win = window.open("", "_blank");
    if (!win) {
      showToast("浏览器拦截了弹窗，请允许弹窗后重试", "error");
      return;
    }
    win.opener = null;

    let fullHtml;
    try {
      const bodyHtml = await renderExportBody(md);
      const title = inferFilename(md, getActiveDocument()?.title);
      fullHtml = buildExportableHtml(title, bodyHtml);
    } catch (e) {
      console.error("PDF export failed:", e);
      win.close();
      showToast("PDF 导出失败，请检查文档中的 Mermaid 语法", "error");
      return;
    }

    win.document.open();
    win.document.write(fullHtml);
    win.document.close();

    // 等所有 <link rel="stylesheet"> 加载完再 print —— 之前用 setTimeout(300) 兜底，
    // CDN 慢时样式还没下载完就打印，PDF 里就成了"裸 HTML"。
    const triggerPrint = () => {
      const fire = () => {
        try {
          win.focus();
          win.print();
        } catch (e) {
          console.warn("打印失败:", e);
        }
      };
      const links = Array.from(win.document.querySelectorAll('link[rel="stylesheet"]'));
      if (!links.length) {
        fire();
        return;
      }
      let printed = false;
      let pending = links.length;
      const done = () => {
        if (printed) return;
        pending -= 1;
        if (pending <= 0) {
          printed = true;
          fire();
        }
      };
      links.forEach((link) => {
        // 已经加载完成（缓存命中）：sheet 不为 null
        if (link.sheet) {
          done();
          return;
        }
        link.addEventListener("load", done, { once: true });
        link.addEventListener("error", done, { once: true });
      });
      // 兜底：3 秒还没全完成也强制 print，避免某条 link 永远 hang 住
      setTimeout(() => {
        if (printed) return;
        printed = true;
        fire();
      }, 3000);
    };
    if (win.document.readyState === "complete") {
      triggerPrint();
    } else {
      win.addEventListener("load", triggerPrint, { once: true });
    }
    showToast("已打开打印窗口，请在弹窗里选「另存为 PDF」", "info");
  }

  function stripFileExtension(filename) {
    return String(filename || "").replace(/\.(md|markdown|txt)$/i, "");
  }

  // 从第一个标题（ATX 或 setext）推断文件名，没有就用当前文档名或时间戳
  function inferFilename(md, fallbackTitle = "") {
    const heading = findFirstHeadingText(md);
    if (heading) {
      return heading.replace(/[\\/:*?"<>|]/g, "-").slice(0, 50) || "document";
    }
    const fallback = cleanTitle(fallbackTitle).replace(/[\\/:*?"<>|]/g, "-").slice(0, 50);
    if (fallback) return fallback;

    const now = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `markdown-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  }

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // 构建可独立打开的 HTML 文档（排版 CSS 仍从带 SRI 的 CDN 加载）
  // 浅色 / 深色两套主题靠 prefers-color-scheme 自适应；
  // 打印 (PDF 导出) 强制浅色，避免黑底浪费墨水。
  function buildExportableHtml(title, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src data: https://cdn.jsdelivr.net; img-src data: blob: https: file:; object-src 'none'; base-uri 'none'; form-action 'none'">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css" integrity="sha384-nB0miv6/jRmo5UMMR1wu3Gz6NLsoTkbqJghGIsx//Rlm+ZU03BU6SQNC66uf4l5+" crossorigin="anonymous">
<!-- 两套 highlight.js 主题用 media query 选其一；打印时归类到浅色 -->
<link rel="stylesheet" media="(prefers-color-scheme: light), print" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css" integrity="sha384-eFTL69TLRZTkNfYZOLM+G04821K1qZao/4QLJbet1pP4tcF+fdXq/9CdqAbWRl/L" crossorigin="anonymous">
<link rel="stylesheet" media="(prefers-color-scheme: dark)" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css" integrity="sha384-wH75j6z1lH97ZOpMOInqhgKzFkAInZPPSPlZpYKYTOqsaizPvhQZmAtLcPKXpLyH" crossorigin="anonymous">
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff;
    --text: #1f2328;
    --muted: #555;
    --border: #e5e7eb;
    --code-bg: #f6f8fa;
    --quote-bg: #f0f0ff;
    --quote-border: #4f46e5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0d1117;
      --text: #c9d1d9;
      --muted: #8b949e;
      --border: #30363d;
      --code-bg: #161b22;
      --quote-bg: #161b22;
      --quote-border: #7ee787;
    }
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
    max-width: 860px;
    margin: 40px auto;
    padding: 0 24px;
    line-height: 1.75;
    background: var(--bg);
    color: var(--text);
  }
  h1, h2 { padding-bottom: .3em; border-bottom: 1px solid var(--border); }
  pre { background: var(--code-bg); padding: 16px; border-radius: 8px; overflow-x: auto; }
  .code-block-wrapper { position: relative; }
  .code-lang-label { float: right; margin: 8px 10px 0 12px; color: var(--muted); font: 600 11px/1 sans-serif; text-transform: uppercase; }
  code { font-family: "JetBrains Mono", monospace; font-size: .9em; }
  :not(pre) > code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; }
  blockquote {
    border-left: 4px solid var(--quote-border);
    background: var(--quote-bg);
    padding: .4em 1em;
    margin: 1em 0;
    color: var(--muted);
    border-radius: 0 6px 6px 0;
  }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid var(--border); padding: 8px 14px; }
  th { background: var(--code-bg); }
  img { max-width: 100%; }
  .mermaid { text-align: center; margin: 1em 0; }
  /* Mermaid 按浅色主题渲染；深色阅读模式下给图一张浅色底卡片 */
  @media (prefers-color-scheme: dark) {
    .mermaid svg { background: #fff; border-radius: 8px; padding: 12px; }
  }
  li:has(> input[type="checkbox"]:first-child),
  li:has(> p:first-child > input[type="checkbox"]:first-child) { list-style: none; }
  li > input[type="checkbox"]:first-child,
  li > p:first-child > input[type="checkbox"]:first-child { margin: 0 .5em 0 -1.4em; }
  /* 打印 / PDF 导出强制浅色 */
  @media print {
    body { background: #fff !important; color: #1f2328 !important; }
    pre, :not(pre) > code, th { background: #f6f8fa !important; }
    blockquote { background: #f0f0ff !important; color: #555 !important; border-left-color: #4f46e5 !important; }
    th, td { border-color: #e5e7eb !important; }
    h1, h2 { border-bottom-color: #e5e7eb !important; }
  }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
  }

  /* =============================================================
   * 9. Toast 通知
   * ============================================================= */
  const ICONS = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
  };

  function showToast(message, type = "info") {
    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.innerHTML = `${ICONS[type] || ICONS.info}<span>${escapeHtml(message)}</span>`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("toast-out");
      setTimeout(() => toast.remove(), 200);
    }, 2400);
  }

  // 返回是否真的复制成功，按钮据此显示“已复制”或“复制失败”
  async function copyToClipboard(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {
        // 权限被拒或非安全上下文：退回 execCommand
      }
    }
    return fallbackCopy(text);
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch (_) {}
    document.body.removeChild(ta);
    return copied;
  }

  /* =============================================================
   * 10. 拖拽分割线调整左右宽度
   * ============================================================= */
  const mobileLayoutQuery = window.matchMedia("(max-width: 768px)");

  function getResizableEditorWidth() {
    const rect = workspace.getBoundingClientRect();
    const sidebarWidth = documentSidebar ? documentSidebar.getBoundingClientRect().width : 0;
    return rect.width - sidebarWidth - splitter.offsetWidth;
  }

  function applyEditorPaneWidth(width) {
    if (mobileLayoutQuery.matches) return;
    const resizableWidth = getResizableEditorWidth();
    const min = 200;
    if (resizableWidth <= min * 2) return;
    const nextWidth = Math.round(Math.max(min, Math.min(resizableWidth - min, width)));
    editorPane.style.flex = `0 0 ${nextWidth}px`;
    previewPane.style.flex = "1";
    const percent = Math.round((nextWidth / resizableWidth) * 100);
    splitter.setAttribute("aria-valuenow", String(percent));
    splitter.setAttribute("aria-valuetext", `${nextWidth} 像素，${percent}%`);
  }

  function resetSplitForMobile() {
    if (!mobileLayoutQuery.matches) return;
    editorPane.style.removeProperty("flex");
    previewPane.style.removeProperty("flex");
    splitter.setAttribute("aria-valuenow", "50");
    splitter.setAttribute("aria-valuetext", "编辑区和预览区各占一半");
    requestAnimationFrame(() => cm.refresh());
  }

  if (typeof mobileLayoutQuery.addEventListener === "function") {
    mobileLayoutQuery.addEventListener("change", resetSplitForMobile);
  } else {
    mobileLayoutQuery.addListener(resetSplitForMobile);
  }
  resetSplitForMobile();

  sidebarResizer.addEventListener("pointerdown", (e) => {
    if (mobileLayoutQuery.matches || e.button !== 0) return;
    isSidebarResizing = true;
    activeResizePointerId = e.pointerId;
    documentSidebar.classList.add("resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    sidebarDragStartX = e.clientX;
    sidebarDragStartWidth = documentSidebar.getBoundingClientRect().width;
    e.preventDefault();
    e.stopPropagation();
  });

  splitter.addEventListener("pointerdown", (e) => {
    if (mobileLayoutQuery.matches || e.button !== 0) return;
    isDragging = true;
    activeResizePointerId = e.pointerId;
    splitter.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    splitterDragStartX = e.clientX;
    splitterDragStartEditorWidth = editorPane.getBoundingClientRect().width;
    e.preventDefault();
  });

  document.addEventListener("pointermove", (e) => {
    if (activeResizePointerId !== null && e.pointerId !== activeResizePointerId) return;
    if (isSidebarResizing) {
      // 用按下时刻的宽度 + 鼠标位移，保证原地起拖、不瞬移
      applySidebarWidth(sidebarDragStartWidth + (e.clientX - sidebarDragStartX));
      return;
    }

    if (!isDragging) return;
    let leftWidth = splitterDragStartEditorWidth + (e.clientX - splitterDragStartX);
    applyEditorPaneWidth(leftWidth);
  });

  function finishResize(e) {
    if (activeResizePointerId !== null && e?.pointerId !== activeResizePointerId) return;
    activeResizePointerId = null;
    if (isSidebarResizing) {
      isSidebarResizing = false;
      documentSidebar.classList.remove("resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      cm.refresh();
    }

    if (isDragging) {
      isDragging = false;
      splitter.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      cm.refresh();
    }
  }

  document.addEventListener("pointerup", finishResize);
  document.addEventListener("pointercancel", finishResize);

  sidebarResizer.addEventListener("keydown", (e) => {
    if (mobileLayoutQuery.matches || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const step = e.shiftKey ? 40 : 10;
    const current = documentSidebar.getBoundingClientRect().width;
    if (e.key === "Home") applySidebarWidth(SIDEBAR_MIN_WIDTH);
    else if (e.key === "End") applySidebarWidth(getMaxSidebarWidth());
    else applySidebarWidth(current + (e.key === "ArrowRight" ? step : -step));
  });

  splitter.addEventListener("keydown", (e) => {
    if (mobileLayoutQuery.matches || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const resizableWidth = getResizableEditorWidth();
    const current = editorPane.getBoundingClientRect().width;
    const step = e.shiftKey ? 40 : 10;
    if (e.key === "Home") applyEditorPaneWidth(200);
    else if (e.key === "End") applyEditorPaneWidth(resizableWidth - 200);
    else applyEditorPaneWidth(current + (e.key === "ArrowRight" ? step : -step));
    cm.refresh();
  });

  /* =============================================================
   * 11. 全局快捷键
   * ============================================================= */
  document.addEventListener("keydown", (e) => {
    const isMod = e.ctrlKey || e.metaKey;
    if (!isMod) return;

    // Ctrl/Cmd + S: 导出 MD（按住不放时浏览器会连发 keydown，只响应第一次）
    // 不提供 Ctrl/Cmd + N：Chrome 等浏览器保留该组合键用于新建窗口，网页拦截不到。
    if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      if (!e.repeat) exportMarkdown();
    }
    // Ctrl/Cmd + O: 上传
    else if (e.key === "o" || e.key === "O") {
      e.preventDefault();
      openFile();
    }
  });

  /* =============================================================
   * 11.5 编辑器格式化工具栏
   *
   * 三类操作：
   *   - 行内包裹（粗体/斜体/代码等）：wrapSelection
   *   - 行首前缀（标题/引用/列表）：togglePrefix（多行选区按行处理；二次点击撤销）
   *   - 块级插入（代码块/表格/分隔线/图片）：insertBlock
   * 全部用 cm.operation 包一下，保证 undo 是一步。
   * ============================================================= */
  function wrapSelection(prefix, suffix, placeholder) {
    suffix = suffix === undefined ? prefix : suffix;
    placeholder = placeholder || "";
    cm.operation(() => {
      if (cm.somethingSelected()) {
        const selections = cm.getSelections();
        cm.replaceSelections(selections.map((sel) => prefix + sel + suffix));
      } else {
        const cursor = cm.getCursor();
        cm.replaceRange(prefix + placeholder + suffix, cursor);
        if (placeholder) {
          cm.setSelection(
            { line: cursor.line, ch: cursor.ch + prefix.length },
            { line: cursor.line, ch: cursor.ch + prefix.length + placeholder.length }
          );
        } else {
          cm.setCursor({ line: cursor.line, ch: cursor.ch + prefix.length });
        }
      }
    });
    cm.focus();
  }

  // 检测行首已有的"块级前缀"长度（同类才会被替换）：
  //   heading: # / ## / ... / ###### + 空格
  //   quote:   > + 空格
  //   list:    - / * / + / 1. 等列表标记，含可选的任务复选框 [ ]/[x]
  // 同类下不同前缀（# vs ##、- vs 1.）会互相替换；同前缀二次点击则移除。
  function detectBlockPrefix(text, kind) {
    if (kind === "heading") return text.match(/^#{1,6}\s+/);
    if (kind === "quote")   return text.match(/^>\s+/);
    if (kind === "list")    return text.match(/^([-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+)/);
    return null;
  }

  function setBlockPrefix(kind, newPrefix) {
    cm.operation(() => {
      // listSelections() 即便没选区也会返回一个零宽 Range（anchor === head），
      // 调用 from()/to() 都拿到光标位置，不需要再合成对象。
      const ranges = cm.listSelections();
      const lineNums = new Set();
      ranges.forEach((range) => {
        const from = range.from();
        const to = range.to();
        for (let l = from.line; l <= to.line; l++) lineNums.add(l);
      });
      [...lineNums].forEach((line) => {
        const text = cm.getLine(line) || "";
        const m = detectBlockPrefix(text, kind);
        if (m) {
          const oldLen = m[0].length;
          if (m[0] === newPrefix) {
            // 同前缀二次点击 → 移除
            cm.replaceRange("", { line, ch: 0 }, { line, ch: oldLen });
          } else {
            // 同类不同前缀 → 替换（修复："# 标题"点 H2 变 "## # 标题"的堆叠 bug）
            cm.replaceRange(newPrefix, { line, ch: 0 }, { line, ch: oldLen });
          }
        } else {
          // 没有同类前缀 → 直接加
          cm.replaceRange(newPrefix, { line, ch: 0 });
        }
      });
    });
    cm.focus();
  }

  // 在光标处插入一个独立块；自动保证前后各有一个空行
  function insertBlock(text) {
    cm.operation(() => {
      const cursor = cm.getCursor();
      const lineText = cm.getLine(cursor.line) || "";
      const before = cursor.line === 0 && lineText === "" ? "" : (lineText.length > 0 ? "\n\n" : "\n");
      const insertText = before + text + "\n";
      cm.replaceRange(insertText, cursor);
    });
    cm.focus();
  }

  function applyToolbarAction(action) {
    if (!cm) return;
    switch (action) {
      case "undo": cm.undo(); cm.focus(); break;
      case "redo": cm.redo(); cm.focus(); break;
      case "h1": setBlockPrefix("heading", "# "); break;
      case "h2": setBlockPrefix("heading", "## "); break;
      case "h3": setBlockPrefix("heading", "### "); break;
      case "bold": wrapSelection("**", "**", "粗体"); break;
      case "italic": wrapSelection("*", "*", "斜体"); break;
      case "strike": wrapSelection("~~", "~~", "删除线"); break;
      case "code": wrapSelection("`", "`", "代码"); break;
      case "link": wrapSelection("[", "](https://)", "链接文本"); break;
      case "image": wrapSelection("![", "](https://)", "图片描述"); break;
      case "quote": setBlockPrefix("quote", "> "); break;
      case "ul": setBlockPrefix("list", "- "); break;
      case "ol": setBlockPrefix("list", "1. "); break;
      case "task": setBlockPrefix("list", "- [ ] "); break;
      case "codeblock": insertBlock("```\n代码\n```"); break;
      case "table":
        insertBlock("| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| A   | B   | C   |");
        break;
      case "hr": insertBlock("---"); break;
    }
  }

  // 事件委托：所有带 data-md-action 的按钮共用一个 click 监听
  // popup 在工具栏内部，所以下拉里点按钮也走这同一条
  document.querySelector(".editor-toolbar")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-md-action]");
    if (!btn) return;
    e.preventDefault();
    applyToolbarAction(btn.dataset.mdAction);
    // 在下拉里点了某个按钮，顺手关闭下拉
    closeToolbarOverflowPopup();
  });

  /* =============================================================
   * 11.5 工具栏溢出折叠
   *
   * 编辑面板宽度由用户拖 splitter 决定，可能很窄。这里在每次宽度
   * 变化时重新测算：
   *   - 工具栏放得下所有按钮 → 隐藏「更多」按钮，下拉清空
   *   - 放不下 → 显示「更多」按钮，从最左侧开始把按钮挪进下拉，
   *     直到剩下的能塞进可见宽度
   *
   * 因为按钮们都是 right-aligned（justify-content: flex-end），
   * 视觉上是右侧优先保留，左侧（最先在 DOM 里出现的）先被折叠。
   * ============================================================= */
  const editorToolbarEl = document.querySelector(".editor-toolbar");
  const moreWrapEl = editorToolbarEl?.querySelector(".editor-tool-more-wrap");
  const moreBtnEl = document.getElementById("btn-toolbar-more");
  const overflowPopupEl = document.getElementById("editor-tool-popup");

  // 给每个按钮算一个用于下拉里显示的中文标签：
  //   - 优先用 title（"一级标题"/"粗体" 等）
  //   - 退化用 textContent
  // 用 dataset.label 缓存，避免每次重排都重新读 DOM
  function ensureToolbarItemLabels() {
    if (!editorToolbarEl) return;
    editorToolbarEl.querySelectorAll("[data-md-action]").forEach((btn) => {
      if (btn.dataset.label) return;
      const label = (btn.getAttribute("title") || btn.textContent || "").trim();
      btn.dataset.label = label;
    });
  }

  function closeToolbarOverflowPopup({ restoreFocus = false } = {}) {
    if (!overflowPopupEl || overflowPopupEl.hidden) return;
    overflowPopupEl.hidden = true;
    moreBtnEl?.classList.remove("is-open");
    moreBtnEl?.setAttribute("aria-expanded", "false");
    if (restoreFocus) moreBtnEl?.focus();
  }

  function openToolbarOverflowPopup() {
    if (!overflowPopupEl) return;
    overflowPopupEl.hidden = false;
    moreBtnEl?.classList.add("is-open");
    moreBtnEl?.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => overflowPopupEl.querySelector('[role="menuitem"]')?.focus());
  }

  // 重排核心：测量当前工具栏的可见宽度，决定哪些按钮要进下拉
  //
  // 工具栏是 justify-content: flex-end（按钮整体右对齐）。当内容比容器宽时，
  // 溢出发生在「左侧」（最先在 DOM 里出现的按钮被挤到容器左边以外）。
  // scrollWidth 只测「右侧」溢出，这里测不出，所以改用：
  //   最左侧可见项的 left 坐标 < 工具栏 left 坐标 → 已溢出
  function layoutEditorToolbar() {
    if (!editorToolbarEl || !moreWrapEl || !overflowPopupEl) return;
    ensureToolbarItemLabels();

    // 收集除「更多」按钮以外的所有原生子元素（按钮 + 分隔线）
    const items = Array.from(editorToolbarEl.children).filter(
      (c) => c !== moreWrapEl
    );

    // 第一步：全部恢复显示，「更多」先藏起来，看是否本身就放得下
    items.forEach((it) => it.removeAttribute("data-overflow-hidden"));
    moreWrapEl.setAttribute("data-overflow-hidden", "");
    overflowPopupEl.innerHTML = "";

    // 用 1px 的容差兼容亚像素布局，避免 0.5px 误差导致死循环抖动
    const isOverflowing = () => {
      const tbLeft = editorToolbarEl.getBoundingClientRect().left;
      // 找到第一个还显示着的 item，比它的 left 和容器 left
      for (const it of items) {
        if (it.hasAttribute("data-overflow-hidden")) continue;
        return it.getBoundingClientRect().left < tbLeft - 1;
      }
      return false;
    };

    if (!isOverflowing()) {
      closeToolbarOverflowPopup();
      return;
    }

    // 放不下：先把「更多」按钮显示出来（它本身要占一格宽度，会让溢出更严重）
    moreWrapEl.removeAttribute("data-overflow-hidden");

    // 从最左侧开始一个一个隐藏，直到剩下的内容 + 「更多」按钮能塞下
    const hidden = [];
    for (let i = 0; i < items.length; i++) {
      if (!isOverflowing()) break;
      items[i].setAttribute("data-overflow-hidden", "");
      hidden.push(items[i]);
    }

    // 收尾：如果第一个可见元素是分隔线，把它也藏掉，免得开头突兀
    for (let i = hidden.length; i < items.length; i++) {
      if (items[i].classList.contains("editor-tool-divider")) {
        items[i].setAttribute("data-overflow-hidden", "");
        hidden.push(items[i]);
      } else {
        break;
      }
    }

    // 把被折叠的按钮（跳过分隔线）克隆进下拉里。克隆出来的节点也带
    // data-md-action，所以共用工具栏上的事件委托即可触发同样的动作。
    const popupItems = hidden.filter((it) => it.hasAttribute("data-md-action"));
    popupItems.forEach((item) => {
      const clone = item.cloneNode(true);
      clone.removeAttribute("data-overflow-hidden");
      clone.setAttribute("role", "menuitem");
      overflowPopupEl.appendChild(clone);
    });

    // 折叠后没有任何按钮被收进下拉（极端情况：只有分隔线被藏了），
    // 那「更多」按钮也没必要显示
    if (popupItems.length === 0) {
      moreWrapEl.setAttribute("data-overflow-hidden", "");
      closeToolbarOverflowPopup();
    }
  }

  // 「更多」按钮：切换下拉显隐。注意阻止冒泡，否则会被下面的 document
  // 监听认成"外部点击"立刻关掉
  moreBtnEl?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (overflowPopupEl?.hidden) {
      openToolbarOverflowPopup();
    } else {
      closeToolbarOverflowPopup();
    }
  });

  // 点下拉外面 / 按 Esc 都关闭下拉
  document.addEventListener("click", (e) => {
    if (!overflowPopupEl || overflowPopupEl.hidden) return;
    if (moreWrapEl?.contains(e.target)) return;
    closeToolbarOverflowPopup();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeToolbarOverflowPopup({ restoreFocus: true });
  });

  overflowPopupEl?.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(overflowPopupEl.querySelectorAll('[role="menuitem"]'));
    if (!items.length) return;
    e.preventDefault();
    const currentIndex = items.indexOf(document.activeElement);
    let nextIndex;
    if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = items.length - 1;
    else if (currentIndex === -1) nextIndex = e.key === "ArrowUp" ? items.length - 1 : 0;
    else if (e.key === "ArrowDown") nextIndex = (currentIndex + 1) % items.length;
    else nextIndex = (currentIndex - 1 + items.length) % items.length;
    items[nextIndex].focus();
  });

  // 监听编辑面板尺寸变化（拖 splitter / 切换侧边栏 / 窗口缩放都会触发）
  if (editorToolbarEl && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      // 用 rAF 合并多次回调，避免 ResizeObserver 在重排里再次触发自己
      requestAnimationFrame(layoutEditorToolbar);
    });
    ro.observe(editorToolbarEl);
  }
  // 兜底：窗口大小变了也重排一次
  window.addEventListener("resize", () => requestAnimationFrame(layoutEditorToolbar));
  // 首次启动跑一次
  requestAnimationFrame(layoutEditorToolbar);

  /* =============================================================
   * 12. 工具栏按钮绑定
   * ============================================================= */
  $("#btn-new").addEventListener("click", newDocument);
  $("#btn-open").addEventListener("click", openFile);
  $("#btn-new-sidebar").addEventListener("click", newDocument);
  $("#btn-open-sidebar").addEventListener("click", openFile);
  $("#btn-export-md").addEventListener("click", exportMarkdown);
  $("#btn-export-html").addEventListener("click", exportHtml);
  $("#btn-export-pdf").addEventListener("click", exportPdf);

  /* =============================================================
   * 13. 启动：加载文档列表，开始监听编辑事件
   *
   * IndexedDB 读是异步的，所以这里整体放进 Promise 链：
   * 等文档加载完成后再把内容塞进编辑器、绑定 change 监听。
   * ============================================================= */
  initializeDocuments()
    .catch((e) => {
      console.error("文档初始化失败:", e);
      showToast("文档加载失败，请检查浏览器隐私模式或刷新重试", "error");
      // 兜底：至少给一个空文档让界面能用
      if (!documents.length) {
        documents = [createDocumentRecord({ title: "未命名文档", content: "" })];
        activeDocId = documents[0].id;
      }
    })
    .then(() => {
      documentsReady = true;
      loadActiveDocumentIntoEditor();

      // change 事件触发三条独立路径：
      //   - 统计合并到下一帧更新（与 cursorActivity 共用一次全文统计）
      //   - 当前文档写入内存并防抖保存到 IndexedDB
      //   - 预览走防抖（120ms 后渲染，避免大文档卡顿）
      cm.on("change", () => {
        scheduleStats();
        if (!isLoadingDocument) {
          queueCurrentDocumentSave(cm.getValue());
        }
        schedulePreview();
      });

      // 光标或选区变化时刷新“选中 / 总计”统计；不触发保存或预览重渲染。
      cm.on("cursorActivity", scheduleStats);

      // 首次：立即更新统计 + 安排首次渲染
      try {
        updateStats(cm.getValue());
      } catch (e) {
        console.error("initial updateStats failed:", e);
      }
      schedulePreview();

      // 启动后把预览滚到顶部：避免 KaTeX/Mermaid 异步渲染过程中
      // 浏览器为了"保持视觉位置"而把滚动条停在中段
      setTimeout(() => {
        const previewBody = document.querySelector(".pane-preview .pane-body");
        if (previewBody) previewBody.scrollTop = 0;
      }, 300);

      // 启动后检查一次本地存储用量
      checkStorageQuota();

      console.log("[AyayaMarkdown] 初始化完成");
    });
})();
