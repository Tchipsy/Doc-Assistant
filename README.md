# Doc-Assistant

本地优先的文档知识库助手：把 PDF 讲义、书籍、网页导入为结构化的 Markdown 知识库，支持流式整理、插件式内容生成与带引用的 RAG 问答。

> v1.0 · 本地全链路可用（导入 → 解析 → 整理 → 入库 → 问答 → 导出）

## 功能特性

- **文档导入与解析** — PDF 上传后经 PyMuPDF 直抽或 OCR（PaddleOCR / MinerU，OCR 地址可指向本地部署）转为 Markdown，图片一并落盘；支持网页导入。
- **智能整理** — 按整理预设（课件、书籍、题目、知乎页等）做两阶段（pass1/pass2）窗口化整理，支持检查点与续传；预设与文档内容参与生成指纹，变更自动标记失效。
- **实时流式渲染** — 服务端权威组件树 + 树操作事件流（SSE），LLM 输出逐字直达浏览器；前端事件溯源折叠器 + 水位线机制防重放污染。
- **插件式内容生成** — `@@块` 协议，按位置预设（如"未证明命题处"）在文档指定位置生成内容；插件以结构化表单编辑，内置作业解答、论文解析、详细讲解等预设。
- **知识库与 RAG 问答** — 编号叶子节分块（带面包屑）→ 嵌入（自适应批次）→ SQLite BLOB + NumPy 余弦检索（向量库实现可替换）→ 可选重排；聊天三模式：chat（默认，引用回答）/ query（阈值不足拒答）/ automatic（工具循环，可联网搜索）。
- **引用跳转** — 块级锚点 + 文本高亮，点击回答中的引用直达原文位置。
- **多标签界面** — 标签=视图=路由，App 壳层 keep-alive 多标签 + 滚动位置记忆；KaTeX 数学公式渲染。
- **导出** — 整理产物与生成内容可导出 Markdown / PDF。
- **联网搜索** — Tavily / Exa / Jina 可配置，异常自动降级为错误文本。

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Python · FastAPI + uvicorn（单进程 + SSE）· SQLite（WAL）· PyMuPDF · OpenAI 兼容 SDK · NumPy |
| 前端 | React 18 · TypeScript · Vite · Zustand · Tailwind CSS 4 · KaTeX · pdf.js |

## 架构

```
React SPA (webui)
   │ REST + multipart            │ GET /api/events (SSE, Last-Event-ID 重放)
   ▼                             ▼
FastAPI (uvicorn 127.0.0.1:8000)
   routers → services ──→ jobs（线程池）
                 │            └─ engine（LLM/OCR/pass1/pass2/assemble/md2pdf）
                 ├─ liveview（StreamParser → LiveTree → render.op）
                 ├─ rag（chunker → embeddings → SQLite+NumPy → rerank）
                 └─ EventBus（全局 _id、环形缓冲、每客户端队列）──► SSE
   │
   └─ SQLite app.db（设置/预设/插件/会话/消息/chunks）+ data/work 工件目录
```

```
backend/
├── app/            # 路由、服务层、liveview 流式渲染、RAG
├── engine/         # 算法层：LLM 流式、pass1/pass2、OCR、导出、提示词装配
├── prompts/        # 内置提示词模板（首次启动播种进 SQLite）
├── tests/
└── run_server.py
webui/
├── src/            # React SPA：live 事件折叠器、LiveView、页面与组件
├── scripts/        # 构建 / 示例生成脚本
└── public/         # 程序生成的示例 PDF
```

## 快速开始

```bash
# 后端（FastAPI，127.0.0.1:8000）
cd backend
python -m pip install -r requirements.txt
python run_server.py

# 前端（Vite dev，localhost:5173，/api 已代理到后端）
cd webui
npm install
npm run dev
```

生产形态：`cd webui && npm run build`，后端检测到 `webui/dist` 存在即自动托管。
数据库为 `backend/data/app.db`（SQLite/WAL），首次启动自动建表并播种内置预设与插件。

## 模型服务配置

在设置页配置 OpenAI 兼容服务商（Base URL + API Key）与各模型槽位（整理/生成、助手、嵌入、重排），并按需配置解析服务商与联网搜索密钥。

**所有密钥仅保存在本地 SQLite 数据库中**，不经过任何第三方服务；界面读回时密钥打码显示。

## 安全说明

本项目为本地单用户设计，服务绑定 `127.0.0.1` 且无鉴权，请勿直接暴露到公网。

## License

暂未附带开源许可证，保留所有权利。
