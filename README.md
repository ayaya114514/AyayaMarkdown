# AyayaMarkdown

在线链接：https://ayaya114514.github.io/AyayaMarkdown/
一款优雅的在线 Markdown 编辑器，左编辑右预览，支持代码高亮、Mermaid 图表与 LaTeX 公式。

## ✨ 特性

- **实时预览**：左侧编辑，右侧实时渲染
- **多文档侧边栏**：新建和上传的文档会保存在浏览器本地，可隐藏、切换和拖拽调宽
- **代码高亮**：基于 highlight.js，支持上百种语言
- **编辑器语法着色**：标题、列表、链接、引用、代码块等 Markdown 语法在编辑区直接高亮
- **Mermaid 图表**：流程图、时序图、类图等
- **LaTeX 公式**：基于 KaTeX，支持行内与块级公式
- **文件操作**：新建、上传 `.md`、导出 `.md` / `.html` / `.pdf`
- **深色界面**：专注写作的统一深色主题
- **安全预览**：DOMPurify 清理 Markdown HTML，Mermaid 使用 strict security mode
- **自动保存**：文档内容增量保存到浏览器 IndexedDB，界面设置保存到 localStorage
- **可拖拽分栏**：自由调整编辑/预览区宽度
- **快捷键**：`Ctrl/Cmd+S` 导出、`Ctrl/Cmd+O` 上传
- **零构建运行**：纯静态页面，运行时依赖使用带 SRI 校验的固定版本 CDN

## 🚀 本地运行

直接用浏览器打开 `index.html` 即可：

```bash
open index.html      # macOS
xdg-open index.html  # Linux
start index.html     # Windows
```

或者用任意静态服务器：

```bash
python3 -m http.server 8000
# 访问 http://localhost:8000
```

页面运行时需要联网加载固定版本的 CodeMirror、marked、DOMPurify、KaTeX、Mermaid 与 highlight.js。

## ✅ 验证与测试

首次运行测试：

```bash
npm install
npx playwright install chromium
npm test
```

`npm run validate` 执行 JavaScript syntax、HTML asset、SRI 与 security contract 检查；`npm test` 还会运行 Chromium browser tests，覆盖 XSS、即时导出、文档顺序和 responsive layout。

## ☁️ 部署到 GitHub Pages

推送到 `main` 分支后，[GitHub Actions](./.github/workflows/deploy-pages.yml) 会自动构建并发布静态站点。

也可以在仓库的 **Actions → Deploy GitHub Pages → Run workflow** 手动触发部署。

## 🛠 技术栈

| 用途 | 库 |
| ---- | ---- |
| Markdown 解析 | [marked](https://github.com/markedjs/marked) |
| 代码高亮 | [highlight.js](https://highlightjs.org/) |
| 图表渲染 | [Mermaid](https://mermaid.js.org/) |
| 数学公式 | [KaTeX](https://katex.org/) |
| 代码编辑器 | [CodeMirror 5](https://codemirror.net/5/) |
| 字体 | Inter + JetBrains Mono |

## 📁 项目结构

```
markdown-editor/
├── .github/workflows/
│   └── deploy-pages.yml # GitHub Pages 自动部署
├── scripts/validate.mjs # 静态 validation
├── tests/               # Playwright browser tests
├── index.html           # 页面骨架与 CDN dependency pins
├── style.css            # 深色界面与 responsive styles
├── app.js               # 编辑、预览、导出与存储逻辑
├── package.json         # 测试工具配置
└── README.md
```

## 📝 License

[MIT](./LICENSE)
