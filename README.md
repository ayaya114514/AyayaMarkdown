# AyayaMarkdown

一款优雅的在线 Markdown 编辑器，左编辑右预览，支持代码高亮、Mermaid 图表与 LaTeX 公式。

## ✨ 特性

- **实时预览**：左侧编辑，右侧实时渲染
- **多文档侧边栏**：新建和上传的文档会保存在浏览器本地，可隐藏、切换和拖拽调宽
- **代码高亮**：基于 highlight.js，支持上百种语言
- **编辑器语法着色**：标题、列表、链接、引用、代码块等 Markdown 语法在编辑区直接高亮
- **Mermaid 图表**：流程图、时序图、类图等
- **LaTeX 公式**：基于 KaTeX，支持行内与块级公式
- **文件操作**：新建、上传 `.md`、导出 `.md` / `.html`
- **双主题**：浅色 / 深色一键切换，跟随系统
- **自动保存**：文档列表和内容自动存到浏览器 localStorage
- **可拖拽分栏**：自由调整编辑/预览区宽度
- **快捷键**：`Ctrl/Cmd+S` 导出、`Ctrl/Cmd+O` 上传
- **零构建**：纯静态页面，所有依赖走 CDN

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

## ☁️ 部署到 Vercel

1. 把项目推到 GitHub
2. 在 [vercel.com](https://vercel.com) 点击 **Import Project**，选这个仓库
3. 框架预设选 **Other**（纯静态），其它保持默认
4. 点 **Deploy**，几十秒后即可拿到访问链接

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
├── index.html   # 页面骨架
├── style.css    # 样式（浅色/深色双主题）
├── app.js       # 主逻辑
└── README.md
```

## 📝 License

MIT
