# chat-demo（Pomme Ri）前端安全审计报告

- 审计对象：`chat-demo`，版本 `0.1.2`，当前工作树（含未提交改动），上游为 `deepseek-ai/chat-demo`
- 审计时间：2026-11-20
- 审计范围：`src/`（175 个文件）、`rspack.config.ts`、`package.json`、`pnpm-lock.yaml`、`vercel.json`、`.github/`、README、LICENSE、`.gitignore`、Git 全部历史、`dist/` 构建产物
- 审计方法：静态代码审计、数据流追踪、全历史密钥扫描、`pnpm audit --prod`、构建产物检查
- 审计结论：**未发现硬编码 API Key，未发现向非 DeepSeek 域名的运行时外发，未发现恶意代码。** 但存在 **2 个必须先处理的高危项**（PDF 原件在“发送”前被完整上传、Git 提交身份泄露个人邮箱/机器名）和 **1 组依赖漏洞**（1 high + 9 moderate），另有若干中低风险项。

---

## 0. 结论速览

| 编号 | 检查项 | 结论 | 等级 | 关键位置 |
|---|---|---|---|---|
| K-1 | 硬编码 API Key / Token | **通过** | — | 全仓库 + 全历史 + dist 均未发现 |
| K-2 | API Key 存储 | **有条件通过** | 中 | `src/services/settings.ts:24-34,99-100,139-142` |
| K-3 | 请求鉴权方式（Header vs URL） | **通过** | — | `src/services/api/client.ts:85-99`，`speech.ts:24-29,55-59` |
| K-4 | 向第三方/自建服务器外发 Key | **通过** | — | 唯一 `fetch` 封装 `client.ts:69-83` |
| D-1 | IndexedDB 仅本地存储 | **通过** | — | `src/services/chat/db.ts` |
| D-2 | PDF 文本本地解析 | **通过** | — | `src/services/documents/chunkDocument.ts:66-102` |
| D-3 | PDF 原件是否本地处理 | **不通过** | **高** | `drafts.ts:80` → `attachments.ts:167-206` → `client.ts:105-123` |
| D-4 | PDF 页面图片外发 | **部分不通过（需披露）** | 中 | `chunkDocument.ts:49-64,82-91`，`documentJob.ts:89-106` |
| D-5 | Map-Reduce 分块元数据 | **通过** | — | `documentJob.ts:108-156` |
| D-6 | 位置/日期提醒外发 | **设计如此，建议披露** | 中 | `latestReminder.ts:19-30`，`reply.ts:327` |
| D-7 | 历史导出/导入 | **通过** | — | `history/exportArchive.ts`，`history/importArchive.ts` |
| S-1 | 源码/配置个人隐私 | **通过** | — | 无邮箱、姓名、绝对路径 |
| S-2 | Git 提交身份 | **不通过** | **高** | 提交作者/提交者邮箱 |
| S-3 | `.gitignore` 敏感文件 | **通过（建议补充）** | 低 | `.gitignore:1-11` |
| S-4 | README/仓库元数据残留 | **建议修改** | 低 | `README.md:7,14`，`package.json:2` |
| L-1 | LICENSE 与版权声明 | **通过** | — | `LICENSE:3`，`rspack.config.ts` 复制 LICENSE |
| L-2 | 源文件版权头 | **通过（上游无）** | — | 无需补充 |
| X-1 | 依赖漏洞 | **不通过** | 高/中 | `mermaid 11.10.1`，`katex 0.16.22`，`lodash-es 4.17.21` |
| X-2 | CSP / 安全响应头 | **建议加固** | 中 | `vercel.json`，`src/index.html` |
| X-3 | XSS 注入面 | **通过（有前提）** | — | Mermaid/KaTeX/Prism/Markdown |

> **发布前必须处理（P0）**：D-3（PDF 完整上传）、S-2（Git 邮箱）、X-1（依赖漏洞升级）。
> **建议发布前处理（P1）**：K-2（Key 存储与 CSP）、D-4/D-6（隐私披露）、S-3/S-4。
> **可发布后跟进（P2）**：孤儿文件清理、第三方图标 `referrerpolicy`、README 仓库地址。

---

## 1. API Key 泄露风险

### K-1 硬编码密钥：通过 ✅

对 `src/`、`rspack.config.ts`、`package.json`、README、`.github/`、`dist/` 以及 **Git 全部历史的所有 blob** 做了以下模式扫描：

- `sk-[A-Za-z0-9]{20,}`（DeepSeek/OpenAI 风格）
- `ghp_...`、`AKIA...`、`-----BEGIN ... PRIVATE KEY-----`
- `Authorization`、`Bearer`、`apiKey`、`token` 等上下文

**结果：0 命中。** 历史中唯一匹配 `sk-` 的字符串是 `ds-markdown-task-list-item`（`src/components/markdown/MarkdownAstRenderer.tsx:32`），属于 CSS 类名，不是密钥。`dist/` 中也没有源码映射（`devtool: false`），未泄露源码或密钥。

**结论：通过。**

### K-2 API Key 存储：有条件通过 ⚠️（中风险）

**事实：**

- Key 以**明文**存放在 `localStorage`：键名 `chat-demo:api-key`
  - `src/services/settings.ts:24-34`（键定义）
  - `src/services/settings.ts:99-100`（启动时 `apiKey: read(KEYS.apiKey)`）
  - `src/services/settings.ts:139-142`（`setApiKey` 直接 `write`）
- UI 层做了掩码与 `type="password"`，不会在界面明文回显：
  - `src/components/settings/ApiKeyField.tsx:31-33`（`'*'.repeat(apiKey.length)`）
  - `src/components/settings/ApiKeyField.tsx:43-44`（`type="password"`）
- Key 没有被写入日志：全仓库唯一 `console.error` 在 `src/services/chat/db.ts:279`，只打印存储错误对象，不含 Key。
- Key 没有进入历史导出：`src/services/chat/history/exportArchive.ts` 明确“没有账号信息，不写 user.json”。

**风险：**

`localStorage` 对**同源的所有 JavaScript** 可见，也可被浏览器扩展读取。纯前端架构下无法做到“绝对安全”，但当前项目同时存在两个放大因素：

1. 没有 CSP（见 X-2），一旦出现 XSS，攻击者可直接 `localStorage.getItem('chat-demo:api-key')` 外传。
2. Mermaid 通过 `dangerouslySetInnerHTML` 注入 SVG（`src/components/markdown/MermaidDiagram.tsx:91`），而当前 `mermaid@11.10.1` 存在已知 HTML/CSS 注入类漏洞（见 X-1）。

**结论：不是“漏洞”，但属于“可被 XSS 直接利用的高价值目标”。**

**修复建议（按成本从低到高）：**

1. **最低成本（推荐先做）**：保留 `localStorage`，但补 CSP + 升级 Mermaid，并在 README/设置页明确提示“Key 以明文保存在浏览器，请勿在公共电脑使用”。
2. **中等成本**：增加“仅本次会话”选项，使用 `sessionStorage` 或纯内存，关闭标签页即清除：

```ts
// src/services/settings.ts（示意）
const SESSION_KEY = 'chat-demo:api-key:session'

const readApiKey = (): string | null => {
  try {
    return sessionStorage.getItem(SESSION_KEY) ?? localStorage.getItem(KEYS.apiKey)
  } catch {
    return null
  }
}

export const setApiKey = (
  apiKey: string | null,
  options: { persist?: boolean } = {}
) => {
  const persist = options.persist ?? true
  try {
    if (!apiKey) {
      localStorage.removeItem(KEYS.apiKey)
      sessionStorage.removeItem(SESSION_KEY)
    } else if (persist) {
      localStorage.setItem(KEYS.apiKey, apiKey)
      sessionStorage.removeItem(SESSION_KEY)
    } else {
      localStorage.removeItem(KEYS.apiKey)
      sessionStorage.setItem(SESSION_KEY, apiKey)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
  useSettings.setState({ apiKey })
}
```

3. **高成本**：WebCrypto + 用户口令加密后再存 `localStorage`。对“免登录演示应用”而言收益有限，不建议优先做。

### K-3 请求鉴权方式：通过 ✅

**DeepSeek 原生接口（Chat / 语音）使用 `Authorization: Bearer`：**

- `src/services/api/client.ts:93-99`：`GET /models` 校验 Key，`headers: { Authorization: \`Bearer ${apiKey}\` }`
- `src/services/api/speech.ts:17-29`：ASR，`Authorization: Bearer`
- `src/services/api/speech.ts:49-60`：TTS，`Authorization: Bearer`

**Anthropic 兼容接口（Messages / Files）使用 `x-api-key`：**

- `src/services/api/client.ts:85-90`：`anthropicHeaders` 返回 `{'x-api-key': apiKey}`
- `src/services/api/client.ts:116-121`：`POST /anthropic/v1/files`
- `src/services/api/client.ts:149-158`：`POST /anthropic/v1/messages`

这是 Anthropic 兼容协议要求的鉴权头，和 Bearer 一样属于 **Header 方式**，没有把 Key 放进 URL 查询参数。全仓库未发现 `?api_key=`、`?key=`、`?token=` 之类的拼接。

**结论：通过。** 如果希望统一为 Bearer，需要确认 DeepSeek 的 Anthropic 兼容端点是否同时接受 `Authorization`；不要为了“统一”而破坏 Files API。

### K-4 第三方/自建服务器外发：通过 ✅

**运行时网络出口只有一个：**

- `src/services/api/client.ts:69-83` 是唯一封装 `fetch` 的函数；`src/` 内没有其他 `fetch`、`XMLHttpRequest`、`sendBeacon`、`WebSocket`、`EventSource`。
- `API_ORIGIN` 由构建期注入，默认 `https://api.deepseek.com`：
  - `rspack.config.ts:27-30`（默认值）
  - `rspack.config.ts:83`（`DefinePlugin`）
  - `src/services/api/client.ts:13`（`__API_ORIGIN__`）
- 全仓库 `https?://` 扫描结果只有 DeepSeek API/文档、W3C SVG 命名空间、Vercel schema、HTML 规范链接，没有分析、埋点、错误上报 SDK：
  - 无 `gtag` / `analytics` / `sentry` / `posthog` / `mixpanel` / `umami` / `beacon` / `reportError`
  - `dist/index.html` 只有一个同源 `<script defer src="static/js/main.*.js">`
  - `package.json` 没有 `postinstall` / `prepare` 脚本

**结论：通过。** 未发现任何把 Key 或聊天内容发往非 DeepSeek 域名的代码。

> 附注（非运行时）：`git remote -v` 指向 `https://ghproxy.net/https://github.com/deepseek-ai/chat-demo.git`。这是第三方 Git 代理，不会接触运行时 API Key，但发布前建议改为你自己的仓库直连地址，避免代码经过第三方代理。

---

## 2. 数据隐私与合规风险

### D-1 IndexedDB 仅本地存储：通过 ✅

`src/services/chat/db.ts` 定义了纯本地库 `chat-demo`（`DB_VERSION = 12`）：

- `sessions` / `sessionSummaries`：会话与摘要
- `files`：附件原件 Blob
- `sessionsStaging` / `filesStaging`：导入暂存
- `documentJobs`：长文档任务（含 `sourceFile: File`，解析完成后置空）

所有读写都通过 `idb` 的 `openDB`，没有同步/云备份逻辑；`loadAllSessions`、`saveSession`、`loadFile` 等都是本地操作。全文检索 `src/services/chat/search.ts` 也只遍历 IndexedDB，不发网络请求。

**结论：通过。** 数据按浏览器 profile + 站点 origin 隔离。

### D-2 PDF 文本本地解析：通过 ✅

`src/services/documents/chunkDocument.ts:66-102`：

```ts
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', document.baseURI).toString()
const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
```

- 通过 `file.arrayBuffer()` 把文件读入内存，交给 PDF.js 解析，**没有 `FormData`、没有 `fetch`**。
- Worker 是本地文件：`rspack.config.ts` 的 `CopyRspackPlugin` 把 `pdf.worker.min.mjs` 复制到 `dist/`；运行时用 `document.baseURI` 定位。
- 文本按页提取、按段落/句子切块，全部在浏览器内完成（`chunkDocument.ts:104-235`）。

**结论：PDF 的“文本解析与切块”完全本地，通过。**

### D-3 PDF 原件是否本地处理：不通过 ❌（高危）

**这是本次审计最重要的发现：你描述的“PDF 完全在本地内存中处理、不通过 FormData 发送”与代码实际行为不符。**

**数据流（选中文件即触发，不需要点“发送”）：**

1. 用户选择/拖拽/粘贴 PDF → `ChatInput.tsx` 的 `acceptFiles`（`src/components/chatInput/ChatInput.tsx:96-104`）
2. → `addDraftFiles`（`src/services/chat/drafts.ts:60-82`）
3. → 第 80 行 `added.forEach((attachment) => upload(attachment, apiKey))`，**对所有附件无条件上传，包括 PDF**
4. → `upload`（`drafts.ts:48-57`）→ `uploadAttachment`（`src/services/attachments.ts:167-206`）
5. → `enqueueUpload`（`attachments.ts:120-141`）→ `uploadFile`（`src/services/api/client.ts:105-123`）
6. → `POST https://api.deepseek.com/anthropic/v1/files`，`FormData` 中包含 **完整 PDF 文件**，`purpose = rich_layout_recognition`（`attachments.ts:28-37`）

**更关键的是：**

- PDF 的消息体并不使用这个 `serverId`。`startDocumentSession` 创建的用户消息是 `files: []`（`src/services/chat/store.ts:665-671`）。
- 真正发送时，PDF 分支会把这个已经上传的远端文件删掉：
  - `src/components/chatInput/ChatInput.tsx:194-200`：`void deleteFile(...).catch(() => {})`
- 如果用户在选中 PDF 后**移除附件、刷新页面或关闭标签页**，`removeDraftAttachment` / `clearDraft` 只做客户端 `cancelUpload`（`drafts.ts:120-148`），**不会调用 `deleteFile`**，已上传的完整 PDF 会留在 DeepSeek 服务端（官方 Files API 默认不设过期时间）。
- 即使点了发送，`deleteFile` 是 fire-and-forget，失败被 `.catch(() => {})` 吞掉，也可能残留。

**影响：**

- 与“PDF 只在本地处理”的隐私承诺直接冲突；
- 用户可能以为“还没点发送，文件没出去”，实际上选中文件时就已经完整上传；
- 上传发生在 PDF.js 解析之前/并行，属于纯多余的外发，没有功能收益。

**修复方案（推荐，改动最小）：在 `upload` 入口统一跳过 PDF，覆盖 `addDraftFiles` 和 `retryDraftAttachment` 两个调用点。**

```diff
--- a/src/services/chat/drafts.ts
+++ b/src/services/chat/drafts.ts
@@
 export const setDraftText = (sessionId: string | null, text: string) =>
   updateDraft(sessionId, (draft) => ({ ...draft, text }))
 
+/** PDF 走本地 PDF.js 解析 + Map-Reduce，原件不应离开浏览器。 */
+const isPdf = (file: File) =>
+  file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf'
+
 const upload = (attachment: DraftAttachment, apiKey: string) => {
+  // 提前上传会让整份 PDF 在用户点“发送”前就发到 Files API；
+  // 文档任务只需要本地 File，不需要 serverId。
+  if (isPdf(attachment.file)) {
+    return
+  }
   // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
   void uploadAttachment(
     apiKey,
     attachment.id,
     attachment.file,
     attachment.file.name,
     attachment.isImage
   ).catch(() => {})
 }
```

修复后：

- `addDraftFiles` 第 80 行对 PDF 调用 `upload` 会直接返回，不再创建上传任务；
- `retryDraftAttachment` 也不会误传 PDF；
- `ChatInput` 的 PDF 分支不依赖 `prepareDraftMessage`，因此不会因为缺少 `serverId` 而无法发送；
- `ChatInput.tsx:199` 的 `deleteFile` 可以保留作为防御性清理（对旧草稿仍有效），也可以删除。

**建议同时修正 README 的隐私描述**：如果保留任何 PDF 上传行为，必须明确写出“哪些内容会离开浏览器”；如果按上述修复，则可以写“PDF 原件不上传，仅文本分块与含图页面的渲染图会发送给 DeepSeek”。

### D-4 PDF 页面图片外发：部分不通过（需披露）⚠️（中风险）

`chunkDocument.ts:49-64` 的 `renderPageImage` 会把**含图片的 PDF 页面整页渲染成 JPEG**；`buildChunks` 把这些图片挂在对应 chunk 上（`chunkDocument.ts:200-231`）。发送分块时：

- `documentJob.ts:89-106` `uploadChunkImage` 把每张页面图通过 `uploadFile` 上传到 Files API；
- 请求体里用 `{ type: 'image', source: { type: 'file', file_id } }` 引用（`documentJob.ts:134-147`）。

因此，**含图片的 PDF 页面（包括页面上的文字渲染结果）会以图片形式离开浏览器**。这不是恶意行为，但必须在隐私说明中披露，否则“PDF 不出本地”同样不成立。

**建议：**

- 在 README/隐私说明中明确：“PDF 文本在本地解析；含图片的页面会渲染为 JPEG 并发送给 API 以理解版面。”
- 如果希望更严格，可增加“仅发送文本，不发送页面图”的开关；代价是扫描件/图表页无法被理解。
- `renderPageImage` 使用 `canvas.toBlob(..., 'image/jpeg', 0.72)`，只发送图像，不包含本地路径；`fileName` 固定为 `document-page-${pageNumber}.jpg`，不泄露原文件名（`documentJob.ts:100-102`）。

### D-5 Map-Reduce 分块元数据：通过 ✅

`documentJob.ts:108-156` 构造的分块请求只包含：

- `state.instruction`（用户指令）
- `state.rollingSummary`（滚动摘要）
- `state.chunks[index].text`（分块文本）
- `第 part/total 部分`（序号）

**没有** `state.fileName`、没有原始文件的本地路径、没有 `File` 对象、没有绝对路径。`fileName` 只用于本地持久化和 UI 展示：

- `summaryReducer.ts:9,37,70`（状态字段）
- `DocumentChunkPanel.tsx:100-101`（界面展示）

`startDocumentSession` 创建的消息 `files: []`（`store.ts:669`），也不会把原文件元数据带入上下文。

**结论：通过。** 分块只发送文本（以及 D-4 所述的页面图），不泄露本地文件路径。

> 唯一例外是用户自己在指令里写了路径（例如“总结 /Users/me/secret.pdf”），那属于用户输入，代码无法也不应自动过滤。

### D-6 位置/日期提醒外发：设计如此，建议披露 ⚠️（中风险）

`src/services/chat/latestReminder.ts:19-30` 会生成：

```ts
return [
  formatDate(now),                         // 日期
  weekday,                                 // 星期
  locationName(location, locale),          // 省/市（用户设置）
  'Web',                                   // 平台
  translate('latestReminderLanguage'),     // 语言
].join(',')
```

并通过 `reply.ts:303-328` 的 `toRequestMessages` 以 `{ role: 'latest_reminder' }` 插入到每次聊天请求中（`store.ts:1304`）。这是官方 demo 的协议扩展，不是漏洞，但：

- 用户的**粗粒度位置**（省/市）会随每次请求发送给 DeepSeek；
- 文档分块的 `requestForChunk` 不包含 reminder（`documentJob.ts:148-155`），但最终回答 `answerDocumentInstruction` 走 `streamReply`，会包含 reminder（`store.ts:796-805`）。

**建议：** 在 README/隐私说明中明确“日期、星期、你选择的地区、平台和语言会作为 latest_reminder 发送”；如果用户未设置位置，`locationName` 返回空字符串，不会发送位置。

### D-7 历史导出/导入：通过 ✅

- 导出：`history/exportArchive.ts` 只写 `manifest.json`、会话 JSON、`chat_session_index.json` 和本地图片；明确“没有账号信息，不写 user.json”，不包含 API Key、设置、非图片附件原件。
- 导入：`history/importArchive.ts` + `zipReader.ts` 流式读取，先写 `sessionsStaging` / `filesStaging`，校验通过后在一个事务里替换正式数据；失败只清空暂存。
- 路径处理：`history/paths.ts:17-24` 的 `safeName` 把 `/`、`\` 映射为 `_`，空值/`.`/`..` 映射为 `unnamed`，且导入只写 IndexedDB，不写文件系统，**不存在 Zip Slip**。
- 归档里的 URL 经过 `isWebUrl` 过滤（`history/toLocal.ts:137,154,181`）。

**结论：通过。**

### D-8 其他外发面（低风险）

| 位置 | 行为 | 评估 |
|---|---|---|
| `src/components/search/SiteLogo.tsx` + `FallbackImage.tsx` | 搜索结果站点图标直接 `src` 到第三方 URL | 会向来源站点/CDN 暴露用户 IP 和 `Referer`（应用地址），不涉及 Key。建议加 `referrerPolicy="no-referrer"` 和 `loading="lazy"`。 |
| `src/components/search/SourceCard.tsx:17` | `<a href={source.url}>` 打开外部网页 | URL 已由 `view.ts:119` 的 `isWebUrl` 过滤为 http/https；`rel="noreferrer"` 已加。 |
| `src/components/search/CitationLink.tsx:14` | `window.open(source.url, '_blank', 'noopener,noreferrer')` | 同上，URL 已过滤。 |
| `src/components/markdown/Link.tsx` | Markdown 图片渲染为链接而非 `<img>` | 避免模型输出触发第三方追踪像素，**设计正确**。 |

---

## 3. 敏感信息泄漏

### S-1 源码/配置个人隐私：通过 ✅

对 `src/`、README、`package.json`、`rspack.config.ts`、`vercel.json`、`.github/` 扫描：

- **无** `@xxx.com` 邮箱（`w3.org` 命名空间除外）
- **无** 真实姓名
- **无** `/Users/`、`/home/`、`C:\` 等本地绝对路径
- **无** 个人域名（README 中只有 `deepseek-ai.github.io`、`github.com/deepseek-ai/...`、`vercel.com` 等通用地址）
- `src/index.html:7` 的 `<title>Pomme Ri</title>` 与 `i18n` 中的 `appName: 'Pomme Ri'` 是你的产品名，不是隐私信息

**结论：通过。**

### S-2 Git 提交身份：不通过 ❌（高危隐私）

Git 历史中的作者/提交者信息会随仓库公开：

```
407dd88 | 钱多多 <qianduoduo@qianduoduodeMacBook-Air.local>
4b6ce2a | 钱多多 <qianduoduo@qianduoduodeMacBook-Air.local>
429af5a | brickmaker <zhaoxiaodong@zju.edu.cn>   ← 上游作者
783829d | brickmaker <zhaoxiaodong@zju.edu.cn>   ← 上游作者
```

其中 `brickmaker <zhaoxiaodong@zju.edu.cn>` 来自上游 `deepseek-ai/chat-demo`，本来已公开；**风险在于你自己的两个提交**：

- 暴露真实邮箱（如果 `qianduoduo@...` 与你的常用邮箱一致）；
- `@qianduoduodeMacBook-Air.local` 泄露设备名和用户名；
- 一旦推送到 GitHub，即使之后删除，也可能被 fork、缓存、GitHub Archive 留存。

**修复（在首次公开推送前做）：**

```bash
# 1) 只改写你自己的提交，保留上游作者归属
cat > /tmp/mailmap.txt <<'EOF'
Your Name <you@users.noreply.github.com> <qianduoduo@qianduoduodeMacBook-Air.local>
EOF

git filter-repo --mailmap /tmp/mailmap.txt --force
# 如果没装 git-filter-repo：
#   brew install git-filter-repo
#   或 pip install git-filter-repo

# 2) 设置后续提交使用 noreply 邮箱
git config user.name "Your Name"
git config user.email "you@users.noreply.github.com"
```

> 注意：`git filter-repo` 会重写提交哈希。当前还没有公开推送，代价最小；如果已经推送，需要 `git push --force` 并通知协作者。不要用 `git rebase -i` 手工改，容易漏掉 committer。

### S-3 `.gitignore`：通过（建议补充）✅

当前 `.gitignore:1-11`：

```
node_modules/
dist/
build/
.pnpm-store/
.cache/
*.log
.DS_Store
.env
.env.*
!.env.example
tmp/
```

已覆盖：`node_modules`、`dist`、`.env`/`.env.*`、`.DS_Store`、日志、缓存。实际检查：

- `src/components/.DS_Store` 存在于磁盘，但被 `.gitignore:7` 忽略（`git check-ignore -v` 已确认），未被跟踪；
- 没有 `.env`、`.env.local`、私钥、`*.pem`、`*.key` 被跟踪；
- `git ls-files` 共 174 个文件，无 zip/db/sqlite/证书。

**建议补充：**

```gitignore
.vercel/
*.tsbuildinfo
.vscode/
.idea/
```

理由：`.vercel/` 含项目元数据；`*.tsbuildinfo` 可能含本地绝对路径（当前 `tsconfig.json` 没有 `incremental`，但未来开启会泄露 `/Users/...`）；编辑器目录不属于项目。

### S-4 README/仓库元数据残留：建议修改（低风险）

- `README.md:7` / `README.zh-CN.md:7` 仍链接上游在线 demo 和 Releases；
- `README.md:14` / `README.zh-CN.md:14` 仍 `git clone https://github.com/deepseek-ai/chat-demo.git`；
- `package.json:2` 的 `name` 仍是 `chat-demo`，与上游同名，容易混淆；
- `README.md:70` 已经有 `git remote set-url origin https://github.com/<your-name>/<repository>.git` 的提示，但没有替换第 7、14 行。

这些不是安全漏洞，但开源后会让读者误以为这是官方仓库。建议改为你自己的仓库地址，并保留一段“基于 DeepSeek chat-demo”的说明（见 L-3）。

---

## 4. 开源协议合规

### L-1 LICENSE：通过 ✅

`LICENSE:1-21` 是标准 MIT，保留了：

```
Copyright (c) 2026 DeepSeek
```

`rspack.config.ts` 的 `CopyRspackPlugin` 会把 `LICENSE` 复制到 `dist/LICENSE`（`rspack.config.ts:84-97`），分发构建产物时不会丢失许可声明。`package.json:5` 的 `"license": "MIT"` 与此一致。

**结论：通过。** MIT 要求“在软件的所有副本或主要部分中保留版权声明和许可声明”，你已经满足。

### L-2 源文件版权头：通过（无需补充）✅

对 `src/` 全量扫描，没有发现 `Copyright` / `SPDX-License-Identifier` / `@license` 头。上游 `deepseek-ai/chat-demo` 本身也没有逐文件版权头，因此你**不需要**为了合规额外添加；LICENSE 文件已经覆盖整个项目。

### L-3 建议：增加“衍生作品”归属说明（非强制）

虽然 MIT 只要求保留 LICENSE，但作为 fork，建议在 README 的 License 段增加一句，既合规也更体面：

```markdown
## License

[MIT](LICENSE). This project is based on [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT).
The original copyright notice is retained in [LICENSE](LICENSE).
```

中文版：

```markdown
## 许可证

[MIT](LICENSE)。本项目基于 [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT）改造，
原始版权声明保留在 [LICENSE](LICENSE) 中。
```

可选：在 LICENSE 中追加你自己的版权行（**不要删除 DeepSeek 的行**）：

```
Copyright (c) 2026 DeepSeek
Copyright (c) 2026 <Your Name>
```

### L-4 依赖许可证（提示）

`package.json` 的依赖以 MIT / Apache-2.0 / ISC 为主，但 `pdfjs-dist`（Apache-2.0）、`mermaid`（MIT）、`katex`（MIT）等在分发 `dist/` 时也应保留其许可信息。当前构建只复制了项目 LICENSE，没有聚合第三方 LICENSE。对纯前端静态站点，通常通过 `node_modules`/源码仓库满足；如果你要发布压缩包，建议用 `license-checker` 生成 `THIRD_PARTY_LICENSES`，或在 README 注明“第三方依赖遵循各自许可证”（当前 README 已有这句，基本够用）。

---

## 5. 额外发现：依赖漏洞与 XSS 链路

### X-1 依赖漏洞：不通过 ❌

`pnpm audit --prod` 结果：**12 个漏洞（1 high / 9 moderate / 2 low）**。

| 等级 | 包 | 漏洞 | 影响版本 | 修复版本 |
|---|---|---|---|---|
| **High** | `lodash-es` | `_.template` imports 代码注入（GHSA-r5fr-rjxr-66jc） | `<=4.17.23` | `>=4.18.1` |
| Moderate | `mermaid` | state diagram `classDef` HTML 注入（GHSA-ghcm-xqfw-q4vr） | `<=11.14.0` | `>=11.15.0` |
| Moderate | `mermaid` | `classDefs` CSS 注入（GHSA-xcj9-5m2h-648r） | `<=11.14.0` | `>=11.15.0` |
| Moderate | `mermaid` | Gantt 无限循环 DoS（GHSA-6m6c-36f7-fhxh） | `<=11.14.0` | `>=11.15.0` |
| Moderate | `mermaid` | 配置 CSS 注入（GHSA-87f9-hvmw-gh4p） | `<=11.14.0` | `>=11.15.0` |
| Moderate | `mermaid` | CSS 注入影响兄弟元素（GHSA-6x64-9x62-f2gx） | `<11.16.1` | `>=11.16.1` |
| Moderate | `mermaid` | Architecture 原型污染（GHSA-3rrr-jr9j-h3q3） | `>=11.5.0 <11.16.1` | `>=11.16.1` |
| Moderate | `mermaid` | XY Chart 无限循环 DoS（GHSA-2v8p-3f2j-5mp7） | `<11.16.1` | `>=11.16.1` |
| Moderate | `mermaid` | Radar 图 DoS（GHSA-rhh3-jpg6-66xh） | `>=11.6.0 <11.16.1` | `>=11.16.1` |
| Low | `mermaid` | 配置 API 原型污染（GHSA-c4c3-pg64-4m4v） | `<11.16.1` | `>=11.16.1` |
| Low | `katex` | 原型污染绕过 trust 限制（GHSA-238p-pmpm-9mq7） | `<0.18.2` | `>=0.18.2` |
| Moderate | `lodash-es` | `_.unset`/`_.omit`/`_.pullAt` 原型污染（GHSA-xxjr-mmjv-4gpg） | `<4.17.23` | `>=4.17.23` |

**为什么这在本项目里值得重视：**

- 当前 `mermaid@11.10.1`（`package.json:32`）落在多个 HTML/CSS 注入区间；
- 应用把 Mermaid 渲染结果直接注入 DOM：`MermaidDiagram.tsx:91` 的 `dangerouslySetInnerHTML={{ __html: result.svg }}`；
- 虽然 `src/services/markdown/mermaid.ts:31-38` 设置了 `securityLevel: 'strict'`，并做了 `sanitizeMermaid`（转义 `<img`/`<image`），但这只能降低风险，不能修复库本身的注入漏洞；
- 一旦形成 XSS，结合 K-2 的 `localStorage` API Key，攻击者可以直接读取并外传 Key。

`katex@0.16.22` 的 low 风险需要“原型污染 + trust 开启”才能利用；当前 `MathFormula.tsx:38` 没有传 `trust: true`，实际可利用性低，但升级成本也不高。

**修复：**

```bash
# 升级到修复版本（按 lockfile 解析为准）
pnpm add mermaid@^11.16.1 katex@^0.18.2

# 如果 lodash-es 仍被解析到 4.17.x，加 overrides：
# package.json
# "pnpm": { "overrides": { "lodash-es": ">=4.18.1" } }

pnpm install
pnpm audit --prod
pnpm type && pnpm lint && pnpm build
```

升级后重点回归：Mermaid 各类图表、KaTeX 行内/块级公式、`mermaid` 的 `securityLevel: 'strict'` 行为。

### X-2 CSP / 安全响应头：建议加固 ⚠️

当前 `vercel.json` 只有构建配置，没有安全头；`src/index.html` 没有 CSP meta。对于一个把 API Key 放在 `localStorage` 的纯前端应用，CSP 是降低 XSS 影响的关键纵深防御。

**建议的 `vercel.json`：**

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm build",
  "outputDirectory": "dist",
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "Content-Security-Policy",
          "value": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https://api.deepseek.com; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
        },
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
        { "key": "X-Frame-Options", "value": "DENY" },
        { "key": "Permissions-Policy", "value": "camera=(), geolocation=(), microphone=(self)" }
      ]
    }
  ]
}
```

注意事项：

- `connect-src` 必须包含你实际使用的 `apiOrigin`；如果通过 `createConfig({ apiOrigin })` 改成别的域名，要同步修改。
- `style-src 'unsafe-inline'` 是因为 React 内联样式、KaTeX 输出需要；不要因此再加 `script-src 'unsafe-inline'`。
- PDF.js 在严格 CSP 下会自动关闭 `eval` 路径（`isEvalSupported`），一般可用；建议先用 `Content-Security-Policy-Report-Only` 观察一周再强制。
- GitHub Pages 不支持自定义响应头；如果同时部署 Pages，可在 `index.html` 加 `<meta http-equiv="Content-Security-Policy" content="...">`（`frame-ancestors` 在 meta 中无效）。

### X-3 XSS 注入面：通过（有前提）✅

逐一检查了所有 `dangerouslySetInnerHTML` / `innerHTML` / `eval`：

| 位置 | 输入 | 防护 | 结论 |
|---|---|---|---|
| `MermaidDiagram.tsx:91` | 模型输出的 Mermaid SVG | `securityLevel: 'strict'` + `sanitizeMermaid` | 依赖库安全；受 X-1 漏洞影响，升级后通过 |
| `MathFormula.tsx:56,66` | KaTeX `renderToString` | `throwOnError: true`，未开启 `trust` | 通过；`strict: false` 只影响警告，不放开 `\href` |
| `CodeBlock.tsx:119` | Prism `highlight` | Prism 对代码做 HTML 转义 | 通过 |
| `parse.ts` | Markdown | 未启用 `allowDangerousHtml`，原始 HTML 不解析 | 通过 |
| `Link.tsx` | 模型输出链接 | `sanitizeUrl` 只允许 http/https/mailto | 通过 |
| `FallbackImage.tsx` | 搜索结果图标 | `<img src>`，不执行脚本 | 通过（有第三方请求，见 D-8） |
| `useFileView.ts:5-17` | 本地 SVG 附件 | SVG 用 `data:` + `download`，不 `openInTab` | **通过，设计正确**（避免 blob: 同源脚本执行） |

全仓库没有 `eval(`、`new Function`、`srcdoc`、`insertAdjacentHTML`。`target="_blank"` 的链接都带 `rel="noreferrer"`（`Link.tsx:42`、`SourceCard.tsx:17`、`ReplyArea.tsx:291`、`AssistantMessage.tsx:118`、`Toast.tsx:31`）。

**结论：通过。** 在升级 Mermaid/KaTeX 并加 CSP 后，XSS 面可接受。

---

## 6. 修复优先级清单

### P0 — 公开推送前必须完成

- [ ] **D-3**：在 `src/services/chat/drafts.ts` 的 `upload()` 入口跳过 PDF，禁止选中即完整上传；确认移除附件时不会再上传。
- [ ] **S-2**：用 `git filter-repo --mailmap` 改写你自己的提交邮箱/设备名；设置 `user.email` 为 GitHub noreply。
- [ ] **X-1**：升级 `mermaid >= 11.16.1`、`katex >= 0.18.2`，处理 `lodash-es` 传递依赖；重新 `pnpm audit --prod` 到 0 high。

### P1 — 建议发布前完成

- [ ] **K-2 + X-2**：加 CSP/安全响应头；评估“仅本次会话保存 Key”选项；README 明确 Key 明文存储的风险。
- [ ] **D-4**：在隐私说明中披露“含图片的 PDF 页面会渲染为 JPEG 上传”。
- [ ] **D-6**：在隐私说明中披露 `latest_reminder` 会发送日期/地区/平台/语言。
- [ ] **S-3**：`.gitignore` 增加 `.vercel/`、`*.tsbuildinfo`、`.vscode/`、`.idea/`。
- [ ] **S-4**：README 的 clone/在线 demo 链接改为自己的仓库；`package.json` 的 `name` 改为自己的包名。

### P2 — 可发布后跟进

- [ ] **孤儿文件清理**：`removeDraftAttachment` / `clearDraft` 对已上传完成的附件调用 `deleteFile`，避免用户移除附件后服务端残留。
  - `ChatInput.tsx` 已经导入了 `deleteFile` 和 `useUploads`，可以在 `removeFile` 里补：

```ts
const removeFile = useCallback(
  (id: string) => {
    if (useChatStore.getState().importingHistory) {
      return
    }
    const task = useUploads.getState().tasks[id]
    if (task?.status === 'done') {
      void deleteFile(useSettings.getState().apiKey ?? '', task.serverId).catch(() => {})
    }
    removeDraftAttachment(sessionId, id)
  },
  [sessionId]
)
```

- [ ] **D-8**：`FallbackImage` 的 `<img>` 增加 `referrerPolicy="no-referrer"`、`loading="lazy"`。
- [ ] **L-3**：README License 段增加“基于 DeepSeek chat-demo（MIT）”的归属说明。
- [ ] **L-4**：如果发布压缩包，生成 `THIRD_PARTY_LICENSES`。

---

## 7. 复核命令

修复后建议按以下顺序复核：

```bash
# 1) 确认 PDF 不再上传：选中 PDF 后看 Network，应没有 /anthropic/v1/files 请求
pnpm dev

# 2) 全仓库/全历史密钥扫描（应无输出）
for c in $(git rev-list --all); do
  git grep -I -nE '(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY)' "$c" -- . 2>/dev/null
done

# 3) 依赖漏洞（应无 high）
pnpm audit --prod

# 4) 构建与类型
pnpm type && pnpm lint && pnpm build

# 5) 构建产物密钥扫描（应无输出）
grep -rnoE 'sk-[A-Za-z0-9]{20,}' dist

# 6) 确认敏感文件未被跟踪
git ls-files | grep -iE '\.env|\.ds_store|\.pem|\.key|secret|token'
```

---

## 8. 最终结论

**合规项（明确“通过”）：**

- 无硬编码 API Key，全历史无密钥泄露；
- 所有 API 请求使用 Header 鉴权（`Authorization: Bearer` / `x-api-key`），Key 从未进入 URL；
- 运行时只访问 `https://api.deepseek.com`，无第三方/自建服务器外发，无埋点；
- IndexedDB 数据仅本地，历史导出不含 Key/设置；
- PDF 文本解析与 Map-Reduce 切块完全本地，分块提示词不泄露本地路径；
- LICENSE（MIT + DeepSeek 版权）完整保留并随 `dist/` 分发；
- `.gitignore` 已覆盖 `.env`、`.DS_Store`、`dist/`、`node_modules` 等。

**不合规项（必须先修复）：**

1. **PDF 原件在选中时被完整上传**（`drafts.ts:80`），与“PDF 只在本地处理”的承诺冲突，且移除附件时服务端文件可能残留；
2. **Git 提交身份泄露个人邮箱和设备名**（`钱多多 <qianduoduo@...MacBook-Air.local>`）；
3. **依赖存在 1 high + 9 moderate 漏洞**，其中 Mermaid 的 HTML 注入与 `dangerouslySetInnerHTML` + `localStorage` Key 形成可被利用的链路。

**总体评价：** 代码没有恶意行为，架构上的数据流是“浏览器 ↔ DeepSeek”的单向直连，这一点是干净的；主要问题集中在 **一个未被披露的 PDF 上传副作用**、**Git 元数据隐私** 和 **依赖/纵深防御**。完成 P0 三项后，可以安全开源；P1 完成后，隐私说明与你的实际行为一致，审计结论可从“有条件通过”提升为“通过”。

---

## 附：修复记录（2026-11-20）

已按 P0/P1 落地以下修改：

| 任务 | 对应项 | 状态 | 变更位置 |
|---|---|---|---|
| PDF 选中即上传 | D-3 | ✅ 已修复 | `src/services/attachments.ts` 新增 `isPdfFile`；`src/services/chat/drafts.ts` 的 `upload()` 入口拦截 PDF；`src/components/chatInput/DraftAttachments.tsx` 将无上传任务的 PDF 视为就绪，避免一直显示“上传中” |
| Vercel 安全头 | X-2 | ✅ 已修复 | `vercel.json` 增加 CSP、`X-Content-Type-Options`、`Referrer-Policy`、`X-Frame-Options`、`Permissions-Policy` |
| `.gitignore` | S-3 | ✅ 已修复 | 追加 `.vercel/`、`*.tsbuildinfo`、`.vscode/`、`.idea/` |
| README / 包名 | S-4、L-3 | ✅ 已修复 | 标题改为 `Pomme Ri`；clone/在线体验/Releases 改为 `YOUR_...` 占位符；License 段增加基于 DeepSeek chat-demo 的归属；`package.json` 的 `name` 改为 `pomme-ri` |
| 依赖升级 | X-1 | ✅ 已升级 | `mermaid 11.17.2`、`katex 0.18.10`；`pnpm audit --prod` 从 1 high + 9 moderate 降为 **1 low**（`mermaid`/`micromark-extension-llm-math` 仍各带一个 katex 0.16.x 传递副本，未开 `trust`，风险可接受） |

**验证结果：**

- `pnpm type`：通过
- `pnpm lint`：0 warnings / 0 errors（135 files）
- `pnpm build`：Rspack compiled successfully
- `pnpm install --frozen-lockfile`：Already up to date
- `pnpm audit --prod`：1 low

**仍未完成（需要你决定 / 手工执行）：**

- **S-2 Git 邮箱改写**：需在首次公开推送前执行 `git filter-repo --mailmap`，属于不可逆历史操作，未自动执行。
- **K-2 Key 存储**：仍为 `localStorage` 明文；若需要“仅本次会话”模式，按 K-2 的示意代码改。
- **D-4 / D-6 隐私披露**：含图 PDF 页面图、`latest_reminder` 的外发仍需在 README 隐私说明中写明。
- **P2 孤儿文件清理**：移除已上传完成的非 PDF 附件时，调用 `deleteFile` 清理服务端文件。
