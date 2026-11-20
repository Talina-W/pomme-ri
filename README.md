# Pomme Ri

English | [简体中文](README.zh-CN.md)

A static chat demo powered by the DeepSeek API. No application backend is required: the browser connects directly to the configured API service.

You can [try the app online](https://YOUR_VERCEL_DOMAIN) or download the archive from [Releases](https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO/releases), extract it, and double-click `index.html` to use it locally without installation or a build. Enter your API key in Settings before your first chat.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/YOUR_GITHUB_USERNAME/YOUR_REPO.git
cd YOUR_REPO
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Virtualized message list: only messages near the viewport stay mounted, so long histories keep a bounded DOM and a scroll-to-bottom control appears after scrolling up.
- Local full-text history search: a dedicated global search page searches every IndexedDB conversation, with Chinese substring matching, multi-word AND queries, newest-first results, highlighted snippets, and jump-to-message results.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

Your API key and settings are stored in the browser's localStorage. Conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Full-text search runs entirely in the browser and never uploads chat history. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Deploy to Vercel

This repository includes [vercel.json](vercel.json): Vercel runs `pnpm install --frozen-lockfile` and `pnpm build`, then publishes `dist/` as a static site. No environment variables are required.

1. Create an empty GitHub repository and push this project to it (see “Push to GitHub” below).
2. Open [Vercel](https://vercel.com/new) and import the repository.
3. Keep the defaults; Vercel reads `vercel.json` automatically. Click Deploy.
4. Open the Vercel URL on your phone and enter your API key in Settings on first use.

Or use the CLI:

```sh
pnpm dlx vercel --prod
```

Chats and API keys are stored per site origin in the browser; they do not sync across domains, browsers, or devices. You will need to enter the API key again on the Vercel domain. On mobile, “Add to Home Screen” gives a more app-like experience.

## Push to GitHub

Create an empty GitHub repository (do not initialize it with a README, .gitignore, or license), then run:

```sh
git remote set-url origin https://github.com/<your-name>/<repository>.git
git push -u origin main
```

If you are on the feature branch, merge it into main first:

```sh
git checkout main
git merge feature/history-search
git push -u origin main
```

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.

This project is based on [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo) (MIT). The original copyright notice is retained in [LICENSE](LICENSE).
