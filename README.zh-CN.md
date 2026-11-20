# Pomme Ri

[English](README.md) | 简体中文

基于 DeepSeek API 的静态聊天示例。无需应用后端，浏览器直接请求配置的 API 服务。

点击 [在线体验](https://YOUR_VERCEL_DOMAIN) 即可使用，也可以前往 [Releases](https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO/releases) 下载压缩包，解压后双击 `index.html` 在本地使用，无需安装或构建。首次使用时，请在设置中填写 API Key。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO.git
cd YOUR_REPO
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 消息列表虚拟化：只挂载视口附近的消息，超长历史仍保持恒定 DOM；上滑后显示「回到底部」悬浮按钮。
- 本地历史全文搜索：独立的全局搜索页检索全部 IndexedDB 会话，支持中文子串、多关键词 AND、按时间倒序平铺结果、命中摘要高亮，点击结果可跳转到原消息。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

API Key 和设置保存在浏览器 localStorage，会话及附件原件保存在 IndexedDB，本地数据按浏览器用户配置和站点源（origin）隔离。全文搜索完全在浏览器本地完成，不会把历史记录发送到任何服务器。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 部署到 Vercel

仓库已包含 [vercel.json](vercel.json)：Vercel 会执行 `pnpm install --frozen-lockfile` 和 `pnpm build`，并把 `dist/` 作为静态站点发布，不需要额外环境变量。

1. 在 GitHub 新建一个空仓库，把本项目推送上去（见下方“推送到 GitHub”）。
2. 打开 [Vercel](https://vercel.com/new)，导入该仓库。
3. 保持默认设置，Vercel 会自动读取 `vercel.json`，点击 Deploy。
4. 部署完成后用手机打开 Vercel 域名，首次使用时在设置里填写 API Key。

也可以使用 CLI：

```sh
pnpm dlx vercel --prod
```

历史对话和 API Key 都按站点源保存在浏览器本地，不同域名、浏览器或设备之间不会自动同步；换用 Vercel 域名后需要重新填写 API Key。手机端建议把页面“添加到主屏幕”，使用时体验更接近原生应用。

## 推送到 GitHub

先在 GitHub 创建一个空仓库（不要勾选 README、.gitignore 或 License），然后在本项目目录执行：

```sh
git remote set-url origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

如果当前在功能分支上，先合并回 main：

```sh
git checkout main
git merge feature/history-search
git push -u origin main
```

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

聊天默认使用 `deepseek-flash`，通过 Anthropic 兼容的 Messages / Files API 通信；语音使用 ASR / TTS 接口。请求使用搜索、链接阅读、标题和 `latest_reminder` 等扩展，接入服务需支持相应能力。附件实际支持的格式以服务端校验为准。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。

本项目基于 [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT）改造，原始版权声明保留在 [LICENSE](LICENSE) 中。
