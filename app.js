/* =============================================================
 * AyayaMarkdown —— 主逻辑
 *
 * 功能模块：
 *   1. 编辑器初始化（CodeMirror）
 *   2. Markdown -> HTML 渲染（marked + highlight.js）
 *   3. LaTeX 公式渲染（KaTeX auto-render）
 *   4. Mermaid 图表渲染
 *   5. 多文档侧边栏 / 文件上传 / 导出 MD / 导出 HTML
 *   6. 主题切换（浅色 <-> 深色）
 *   7. 左右面板宽度可拖拽调整
 *   8. 文档集合本地保存（localStorage）
 *   9. 字数统计 + Toast 通知
 *   10. 快捷键（Ctrl+S / Ctrl+N / Ctrl+O）
 * ============================================================= */

(function () {
  "use strict";

  /* ---------- 顶部声明区：所有共享状态先声明，避免 TDZ 报错 ---------- */
  // 渲染防抖计时器：在 applyTheme 触发的早期 schedulePreview 中也会被读取，
  // 因此必须在第一次 schedulePreview 之前完成声明
  let renderTimer = null;
  let saveTimer = null;
  let isDragging = false;
  let isSidebarResizing = false;
  let documents = [];
  let activeDocId = null;
  let isLoadingDocument = false;
  let storageFailureShown = false;

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
| 新建 | Ctrl+N | ✅ |
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
    const rawWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    const saved = rawWidth === null ? NaN : Number(rawWidth);
    return clampSidebarWidth(Number.isFinite(saved) ? saved : 248);
  }

  function applySidebarWidth(width, shouldPersist = true) {
    const nextWidth = clampSidebarWidth(width);
    document.documentElement.style.setProperty("--sidebar-width", `${nextWidth}px`);
    if (shouldPersist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(nextWidth));
    if (window.cm) {
      requestAnimationFrame(() => window.cm.refresh());
    }
  }

  function isSidebarCollapsed() {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
  }

  function applySidebarState(collapsed) {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "true" : "false");
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
   * 2. 主题管理
   * 把当前主题存到 localStorage，刷新后保持选择
   * ============================================================= */
  const THEME_KEY = "md-editor-theme";

  function getInitialTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
    // 跟随系统
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function applyTheme(theme) {
    document.body.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_KEY, theme);

    // 切换 highlight.js 主题样式表
    document.getElementById("hljs-theme-light").disabled = theme === "dark";
    document.getElementById("hljs-theme-dark").disabled = theme === "light";

    // 切换 CodeMirror 主题（仅在已初始化后）
    if (window.cm) {
      window.cm.setOption("theme", theme === "dark" ? "material-darker" : "default");
    }

    // Mermaid 主题（重新初始化后需要重渲染）
    if (window.mermaid) {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: theme === "dark" ? "dark" : "default",
        securityLevel: "loose",
        fontFamily: "Inter, sans-serif",
      });
      // 让预览刷新一次以重渲染图表
      schedulePreview();
    }
  }

  applyTheme(getInitialTheme());

  $("#btn-theme").addEventListener("click", () => {
    const next = document.body.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
  });

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

  /* ---------- 数学公式扩展 ----------
   * 默认情况下多行 $$...$$ 会被 marked 拆成多个 <p>$$</p>，
   * KaTeX auto-render 跨不过 <p> 边界。
   * 这里注册两个自定义 token，让 marked 把公式作为整体输出，
   * 再交给 KaTeX 在预览阶段渲染。
   */
  const mathBlockExt = {
    name: "mathBlock",
    level: "block",
    start(src) {
      const idx = src.indexOf("$$");
      return idx === -1 ? undefined : idx;
    },
    tokenizer(src) {
      const match = src.match(/^\$\$([\s\S]+?)\$\$\s*(?:\n|$)/);
      if (match) {
        return {
          type: "mathBlock",
          raw: match[0],
          text: match[1].trim(),
        };
      }
    },
    renderer(token) {
      // 公式里可能含 <、>、& 等字符，必须先转义后再拼进 HTML，
      // 否则浏览器会把它当成标签解析，导致 DOM 结构错乱、KaTeX 拿到的也是错的文本。
      // KaTeX auto-render 内部会自动 decode HTML entities，所以这里转义是安全的。
      return `<div class="math-block">$$${escapeHtml(token.text)}$$</div>\n`;
    },
  };

  const mathInlineExt = {
    name: "mathInline",
    level: "inline",
    start(src) {
      const idx = src.indexOf("$");
      return idx === -1 ? undefined : idx;
    },
    tokenizer(src) {
      // 单 $ 行内公式：避开 $$（块级）和未闭合的情况
      const match = src.match(/^\$(?!\$)((?:\\.|[^\$\n])+?)\$(?!\d)/);
      if (match) {
        return {
          type: "mathInline",
          raw: match[0],
          text: match[1],
        };
      }
    },
    renderer(token) {
      // 同上：转义后再拼，避免公式中的 <、>、& 破坏 HTML 结构
      return `<span class="math-inline">$${escapeHtml(token.text)}$</span>`;
    },
  };

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

        // 普通代码块：用 highlight.js 高亮
        let highlighted;
        if (language && hljs.getLanguage(language)) {
          try {
            highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
          } catch (_) {
            highlighted = escapeHtml(text);
          }
        } else {
          // 未指定语言时尝试自动识别
          try {
            highlighted = hljs.highlightAuto(text).value;
          } catch (_) {
            highlighted = escapeHtml(text);
          }
        }

        const langLabel = language || "text";
        const langClass = langLabel.replace(/[^a-z0-9_-]/g, "-") || "text";
        return `<div class="code-block-wrapper">
  <div class="code-block-header">
    <span>${escapeHtml(langLabel)}</span>
    <button class="copy-btn" data-code="${encodeURIComponent(text)}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      复制
    </button>
  </div>
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

    function findClosingDollar(stream) {
      const line = stream.string;
      let pos = stream.pos + 1;
      while (pos < line.length) {
        if (line[pos] === "$" && line[pos - 1] !== "\\") return pos;
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
    extraKeys: {
      Enter: "newlineAndIndentContinueMarkdownList",
      "Ctrl-S": (cm) => {
        exportMarkdown();
        return false;
      },
      "Cmd-S": (cm) => {
        exportMarkdown();
        return false;
      },
    },
  });
  window.cm = cm;
  requestAnimationFrame(() => cm.refresh());

  /* =============================================================
   * 5. 渲染预览（带防抖）
   * ============================================================= */
  function schedulePreview() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderPreview, 120);
  }

  function renderPreview() {
    // 编辑器尚未初始化时直接跳过，避免在启动早期（如主题初始化）误调
    if (!window.cm) return;
    const md = cm.getValue();

    // 统计放最前面、独立 try-catch，
    // 这样即便后续 marked / KaTeX / Mermaid 任何一个抛错，统计都还是会更新
    try {
      updateStats(md);
    } catch (e) {
      console.error("updateStats failed:", e);
    }

    // 1) marked 渲染主体
    let html = "";
    try {
      html = marked.parse(md);
    } catch (e) {
      console.error("marked.parse failed:", e);
      previewEl.innerHTML =
        '<p style="color:#ef4444">渲染失败，请打开浏览器控制台查看详情。</p>';
      return;
    }
    previewEl.innerHTML = html;

    // 2) KaTeX 渲染数学公式（auto-render 会扫描 $...$ 与 $$...$$）
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(previewEl, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\(", right: "\\)", display: false },
            { left: "\\[", right: "\\]", display: true },
          ],
          throwOnError: false,
        });
      } catch (e) {
        console.warn("KaTeX 渲染失败:", e);
      }
    }

    // 3) Mermaid 渲染图表
    if (window.mermaid) {
      const mermaidNodes = previewEl.querySelectorAll(".mermaid");
      // mermaid v10 需要每个节点 removeAttribute('data-processed') 才能重新渲染
      mermaidNodes.forEach((node) => node.removeAttribute("data-processed"));
      try {
        const result = window.mermaid.run({ nodes: mermaidNodes });
        if (result && typeof result.catch === "function") {
          result.catch((e) => console.warn("Mermaid 渲染失败:", e));
        }
      } catch (e) {
        console.warn("Mermaid 渲染失败:", e);
      }
    }

    // 4) 给代码块的复制按钮绑定事件
    previewEl.querySelectorAll(".copy-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const code = decodeURIComponent(btn.dataset.code || "");
        copyToClipboard(code);
        const original = btn.innerHTML;
        btn.innerHTML = "✓ 已复制";
        setTimeout(() => (btn.innerHTML = original), 1500);
      });
    });
  }

  /* =============================================================
   * 6. 字数 / 行数 / 字符数统计
   * ============================================================= */
  function updateStats(text) {
    statChars.textContent = text.length.toLocaleString();
    statLines.textContent = (text ? text.split("\n").length : 0).toLocaleString();
    // 单词数：按空白分隔（中文按字符算；这里只统计英文/数字单词，简单实现）
    const words = text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0;
    statWords.textContent = words.toLocaleString();
  }

  /* =============================================================
   * 7. 多文档管理：保存到 localStorage，支持新建/上传/切换
   * ============================================================= */
  const DOCUMENTS_KEY = "md-editor-documents";
  const ACTIVE_DOCUMENT_KEY = "md-editor-active-document";
  const LEGACY_DRAFT_KEY = "md-editor-draft";

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

  function inferDocumentTitle(md, fallback = "未命名文档") {
    const firstHeading = String(md || "").match(/^#\s+(.+)$/m);
    if (firstHeading) {
      return cleanTitle(firstHeading[1]) || fallback;
    }

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

  function readStoredDocuments() {
    try {
      const raw = localStorage.getItem(DOCUMENTS_KEY);
      if (!raw) return [];

      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed.documents;
      if (!Array.isArray(list)) return [];

      return list
        .filter((doc) => doc && typeof doc === "object" && doc.id)
        .map((doc) => createDocumentRecord(doc));
    } catch (e) {
      console.warn("读取文档列表失败:", e);
      return [];
    }
  }

  function initializeDocuments() {
    documents = readStoredDocuments();

    if (!documents.length) {
      const legacyDraft = localStorage.getItem(LEGACY_DRAFT_KEY);
      const content = legacyDraft && legacyDraft.length > 0 ? legacyDraft : DEFAULT_DOC;
      documents = [
        createDocumentRecord({
          title: legacyDraft ? inferDocumentTitle(legacyDraft) : "欢迎文档",
          content,
          source: legacyDraft ? "created" : "sample",
        }),
      ];
      localStorage.removeItem(LEGACY_DRAFT_KEY);
    }

    const storedActiveId = localStorage.getItem(ACTIVE_DOCUMENT_KEY);
    activeDocId = documents.some((doc) => doc.id === storedActiveId)
      ? storedActiveId
      : documents[0].id;
    persistDocuments();
  }

  function getActiveDocument() {
    return documents.find((doc) => doc.id === activeDocId) || documents[0] || null;
  }

  function persistDocuments(showError = false) {
    try {
      localStorage.setItem(DOCUMENTS_KEY, JSON.stringify({ version: 1, documents }));
      if (activeDocId) localStorage.setItem(ACTIVE_DOCUMENT_KEY, activeDocId);
      storageFailureShown = false;
      return true;
    } catch (e) {
      console.warn("保存文档列表失败:", e);
      if (showError || !storageFailureShown) {
        showToast("文档保存失败，可能是浏览器本地空间不足", "error");
      }
      storageFailureShown = true;
      return false;
    }
  }

  function updateDocumentSnapshot(doc, content) {
    const previousTitle = doc.title;
    doc.content = content;
    doc.updatedAt = Date.now();

    if (doc.source !== "uploaded") {
      doc.title = inferDocumentTitle(content);
    }

    return doc.title !== previousTitle;
  }

  function queueCurrentDocumentSave(content) {
    const doc = getActiveDocument();
    if (!doc) return;

    const titleChanged = updateDocumentSnapshot(doc, content);
    if (titleChanged) renderDocumentList();

    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      persistDocuments();
      renderDocumentList();
    }, 500);
  }

  function flushCurrentDocument() {
    clearTimeout(saveTimer);
    if (!window.cm || !activeDocId || isLoadingDocument) return;

    const doc = getActiveDocument();
    if (!doc) return;

    updateDocumentSnapshot(doc, cm.getValue());
    persistDocuments(true);
    renderDocumentList();
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
    schedulePreview();
    renderDocumentList();
    requestAnimationFrame(() => cm.refresh());
  }

  function switchDocument(docId) {
    if (!docId || docId === activeDocId) return;

    const next = documents.find((doc) => doc.id === docId);
    if (!next) return;

    flushCurrentDocument();
    activeDocId = next.id;
    persistDocuments(true);
    loadActiveDocumentIntoEditor();
  }

  function deleteDocument(docId) {
    const index = documents.findIndex((doc) => doc.id === docId);
    if (index === -1) return;

    const doc = documents[index];
    if (!confirm(`删除“${doc.title}”？`)) return;

    flushCurrentDocument();
    const wasActive = doc.id === activeDocId;
    documents.splice(index, 1);

    if (!documents.length) {
      documents.push(createDocumentRecord({ title: "未命名文档", content: "" }));
    }

    if (wasActive) {
      const next = documents[Math.min(index, documents.length - 1)];
      activeDocId = next.id;
      persistDocuments(true);
      loadActiveDocumentIntoEditor();
    } else {
      persistDocuments(true);
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

    documentList.innerHTML = documents
      .map((doc) => {
        const isActive = doc.id === activeDocId;
        const title = escapeHtml(doc.title || "未命名文档");
        const meta = escapeHtml(`${getSourceLabel(doc.source)} · ${formatUpdatedAt(doc.updatedAt)}`);
        const id = escapeHtml(doc.id);

        return `<div class="document-item${isActive ? " active" : ""}">
  <button class="document-switch" data-doc-id="${id}" role="option" aria-selected="${isActive}">
    <svg class="document-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
    <span class="document-info">
      <span class="document-title">${title}</span>
      <span class="document-meta">${meta}</span>
    </span>
  </button>
  <button class="document-delete" data-delete-doc="${id}" title="删除文档" aria-label="删除 ${title}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  </button>
</div>`;
      })
      .join("");
  }

  documentList.addEventListener("click", (e) => {
    const deleteButton = e.target.closest("[data-delete-doc]");
    if (deleteButton) {
      deleteDocument(deleteButton.dataset.deleteDoc);
      return;
    }

    const switchButton = e.target.closest("[data-doc-id]");
    if (switchButton) switchDocument(switchButton.dataset.docId);
  });

  window.addEventListener("beforeunload", flushCurrentDocument);

  /* =============================================================
   * 8. 文件操作：新建 / 上传 / 导出
   * ============================================================= */
  function newDocument() {
    flushCurrentDocument();

    const doc = createDocumentRecord({ title: "未命名文档", content: "" });
    documents.unshift(doc);
    activeDocId = doc.id;
    persistDocuments(true);
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

      flushCurrentDocument();
      documents.unshift(doc);
      activeDocId = doc.id;
      persistDocuments(true);
      loadActiveDocumentIntoEditor();
      showToast(`已添加 ${file.name}`, "success");
    };
    reader.onerror = () => showToast("文件读取失败", "error");
    reader.readAsText(file, "utf-8");
    // 重置 input 以便同一文件可以再次选择
    fileInput.value = "";
  });

  function exportMarkdown() {
    flushCurrentDocument();
    const md = cm.getValue();
    if (!md.trim()) {
      showToast("内容为空，无法导出", "error");
      return;
    }
    const filename = inferFilename(md, getActiveDocument()?.title) + ".md";
    downloadBlob(md, filename, "text/markdown;charset=utf-8");
    showToast(`已导出 ${filename}`, "success");
  }

  function exportHtml() {
    flushCurrentDocument();
    const md = cm.getValue();
    if (!md.trim()) {
      showToast("内容为空，无法导出", "error");
      return;
    }
    // 把当前预览区的 HTML 嵌入一个完整的、自包含的 HTML 文档
    // CDN 引入 KaTeX/highlight.js 的样式，这样导出的文件双击打开就能直接看
    const bodyHtml = previewEl.innerHTML;
    const title = inferFilename(md, getActiveDocument()?.title);
    const fullHtml = buildExportableHtml(title, bodyHtml);
    downloadBlob(fullHtml, title + ".html", "text/html;charset=utf-8");
    showToast(`已导出 ${title}.html`, "success");
  }

  function stripFileExtension(filename) {
    return String(filename || "").replace(/\.(md|markdown|txt)$/i, "");
  }

  // 从 markdown 第一行（一级标题）推断文件名，没有就用当前文档名或时间戳
  function inferFilename(md, fallbackTitle = "") {
    const firstHeading = md.match(/^#\s+(.+)$/m);
    if (firstHeading) {
      return firstHeading[1].trim().replace(/[\\/:*?"<>|]/g, "-").slice(0, 50) || "document";
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

  // 构建可独立打开的 HTML 文档（自包含样式）
  function buildExportableHtml(title, bodyHtml) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github.min.css">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
         max-width: 860px; margin: 40px auto; padding: 0 24px; line-height: 1.75; color: #1f2328; }
  h1, h2 { padding-bottom: .3em; border-bottom: 1px solid #eee; }
  pre { background: #f6f8fa; padding: 16px; border-radius: 8px; overflow-x: auto; }
  code { font-family: "JetBrains Mono", monospace; font-size: .9em; }
  :not(pre) > code { background: #f6f8fa; padding: 2px 6px; border-radius: 4px; }
  blockquote { border-left: 4px solid #4f46e5; background: #f0f0ff;
               padding: .4em 1em; margin: 1em 0; color: #555; border-radius: 0 6px 6px 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid #ddd; padding: 8px 14px; }
  th { background: #f6f8fa; }
  img { max-width: 100%; }
  .mermaid { text-align: center; margin: 1em 0; }
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

  function copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (_) {}
    document.body.removeChild(ta);
  }

  /* =============================================================
   * 10. 拖拽分割线调整左右宽度
   * ============================================================= */
  sidebarResizer.addEventListener("mousedown", (e) => {
    if (window.matchMedia("(max-width: 768px)").matches) return;
    isSidebarResizing = true;
    documentSidebar.classList.add("resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
    e.stopPropagation();
  });

  splitter.addEventListener("mousedown", (e) => {
    isDragging = true;
    splitter.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (isSidebarResizing) {
      const rect = workspace.getBoundingClientRect();
      applySidebarWidth(e.clientX - rect.left);
      return;
    }

    if (!isDragging) return;
    const rect = workspace.getBoundingClientRect();
    const sidebarWidth = documentSidebar ? documentSidebar.getBoundingClientRect().width : 0;
    const resizableWidth = rect.width - sidebarWidth - splitter.offsetWidth;
    let leftWidth = e.clientX - rect.left - sidebarWidth;
    // 最小 200px，避免拖到看不见
    const min = 200;
    if (resizableWidth <= min * 2) return;
    const max = resizableWidth - min;
    leftWidth = Math.max(min, Math.min(max, leftWidth));
    const percent = (leftWidth / resizableWidth) * 100;
    editorPane.style.flex = `0 0 ${percent}%`;
    previewPane.style.flex = "1";
  });

  document.addEventListener("mouseup", () => {
    if (isSidebarResizing) {
      isSidebarResizing = false;
      documentSidebar.classList.remove("resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      cm.refresh();
      return;
    }

    if (!isDragging) return;
    isDragging = false;
    splitter.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    cm.refresh();
  });

  /* =============================================================
   * 11. 全局快捷键
   * ============================================================= */
  document.addEventListener("keydown", (e) => {
    const isMod = e.ctrlKey || e.metaKey;
    if (!isMod) return;

    // Ctrl/Cmd + S: 导出 MD
    if (e.key === "s" || e.key === "S") {
      e.preventDefault();
      exportMarkdown();
    }
    // Ctrl/Cmd + N: 新建（注意：浏览器原生 Ctrl+N 通常不可拦截，但我们仍尝试）
    else if (e.key === "n" || e.key === "N") {
      // 浏览器一般不允许覆盖，因此仅在能拦截时生效
      e.preventDefault();
      newDocument();
    }
    // Ctrl/Cmd + O: 上传
    else if (e.key === "o" || e.key === "O") {
      e.preventDefault();
      openFile();
    }
  });

  /* =============================================================
   * 12. 工具栏按钮绑定
   * ============================================================= */
  $("#btn-new").addEventListener("click", newDocument);
  $("#btn-open").addEventListener("click", openFile);
  $("#btn-new-sidebar").addEventListener("click", newDocument);
  $("#btn-open-sidebar").addEventListener("click", openFile);
  $("#btn-export-md").addEventListener("click", exportMarkdown);
  $("#btn-export-html").addEventListener("click", exportHtml);

  /* =============================================================
   * 13. 启动：加载文档列表，开始监听编辑事件
   * ============================================================= */
  initializeDocuments();
  loadActiveDocumentIntoEditor();

  // change 事件触发两条独立路径：
  //   - 统计立即更新（无防抖，输入时数字实时跳动）
  //   - 当前文档写入内存并防抖保存到 localStorage
  //   - 预览走防抖（120ms 后渲染，避免大文档卡顿）
  cm.on("change", () => {
    const value = cm.getValue();
    try {
      updateStats(value);
    } catch (e) {
      console.error("updateStats failed:", e);
    }
    if (!isLoadingDocument) {
      queueCurrentDocumentSave(value);
    }
    schedulePreview();
  });

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

  console.log("[AyayaMarkdown] 初始化完成");
})();
