# pku-course-dl

[English](README.md)

下载北大教学网（`course.pku.edu.cn`）课堂实录 / 课程回放的 MCP 服务器。

参考 [pku-learner skill](https://github.com/pku-skills/curated/tree/main/skills/pku-learner)
的「浏览器手动登录 → 抓取 m3u8 → HLS 下载」思路，做成一个**自包含、不污染系统环境**的 MCP：

- **不改系统环境变量**：所有配置由 MCP 客户端以进程级 env 传入，会话/缓存/下载全部放在项目目录内。
- **不依赖系统 yt-dlp / ffmpeg**：用 Node 原生实现 HLS 下载 + AES-128 解密；封装 mp4 用 npm 包
  `ffmpeg-static`（装在 `node_modules` 内）。
- **优先复用系统浏览器**：登录优先用系统已装 Chrome → Edge，都没有才回退到项目内置 Chromium
  （约 150MB，仅首次，下到项目 `.cache/browsers`，不写全局 `~/.cache`）。

> 仅用于下载**你本人有权访问**的课程回放，请遵守学校规定与版权。

## 环境要求

- Node.js ≥ 20
- 建议系统已装 Chrome 或 Edge；否则首次登录会按需下载项目内置 Chromium。

## 安装

```bash
cd pku-course-dl
npm install
```

`npm install` 不会下载浏览器。只有在既没有 Chrome 也没有 Edge 时，首次登录才会按需下载内置 Chromium。

## 工具一览

| 工具 | 作用 |
|------|------|
| `pku_status` | 查看登录状态、数据/下载目录位置（不开浏览器）。 |
| `pku_login` | 打开浏览器，手动完成 IAAA 登录，自动保存会话。 |
| `pku_list_lessons` | 列出某课程课堂实录里的**全部课次**（序号 + 标题），不播放、不下载。 |
| `pku_download_lessons` | 传入挑好的课次**序号数组**，在一个窗口里依次抓取并后台批量下载。 |
| `pku_capture_replay` | 打开浏览器，播放回放，抓取单个 m3u8 地址。 |
| `pku_download` | 按 m3u8 后台下载 + AES-128 解密 + 封装 mp4，返回 jobId。 |
| `pku_download_status` | 查询单个任务进度或列出全部任务。 |

## 典型流程（按课程批量下载，推荐）

一门课往往有很多节课，推荐先看列表、挑序号、再批量下载：

1. **`pku_login`** — 弹出浏览器，用账号 / 微信 / 双因子完成 IAAA 登录。回到
   `course.pku.edu.cn` 后会话自动保存到 `.cache/session-state.json`。
2. **`pku_list_lessons`** — 弹出浏览器（复用会话），自动导航 `课程列表 → 点进课程 → 课堂实录`，
   **停在课次列表**，返回全部课次：
   ```json
   { "ok": true, "count": 12, "lessons": [
     { "index": 1, "title": "第1讲 …" },
     { "index": 2, "title": "第2讲 …" }
   ] }
   ```
   - 传 `course`（课程名）或设环境变量 `PKU_COURSE_NAME`，从首页自动点进目标课。课程名是**模糊匹配**
     （先子串、再按顺序匹配），漏字或小笔误也能命中最贴近的那门课。
   - 传 `url` 可直接打开课堂实录列表页，跳过导航。
   - 没找到列表时返回里带 `diagnostics`（当前页面真实的链接/按钮快照），便于定位选择器。
3. **挑序号** — 从列表里确认想要哪几节，比如第 1、3、5 讲。
4. **`pku_download_lessons`** — 传 `indices: [1, 3, 5]`（建议 `course`/`url` 与上一步一致）。在
   **一个窗口**里依次播放每节、抓到各自的 m3u8 后**立即起后台下载任务**，返回每节的 `jobId`：
   ```json
   { "ok": true, "results": [
     { "index": 1, "jobId": "job-1", "name": "course-01", "m3u8": "https://…" },
     { "index": 3, "jobId": "job-2", "name": "course-03", "m3u8": "https://…" }
   ], "skipped": [] }
   ```
   - 抓不到某节会进 `skipped`（带原因），其余照常下载。
   - 输出文件名形如 `<前缀>-03.mp4`，可用 `namePrefix` 自定义前缀。
5. **`pku_download_status`** — 不传参数列出全部任务，或传 `jobId` 看单个进度。返回里有进度条、速度、剩余时间：
   `[██████████░░░░░░░░░░░░] 46%  120/260 segs  248.6MB  3.1MB/s  ETA 0:48`
   完成后 `outFile` 即 mp4 路径（默认在 `downloads/`）。下载过程中还会通过 MCP 日志通知实时推送进度。

> 一节课的回放可能上 GB、下载耗时数分钟，所以下载是后台任务，不会卡住对话。

## 只下单节（备用流程）

只想抓某一个回放、或自动导航没生效时：

1. **`pku_capture_replay`** — 弹出浏览器（复用会话），**默认自动播放**，监听抓取 `playlist.m3u8`。
   窗口有头，可手动点击兜底，或传 `autoplay: false`。注意它**只会抓列表里的第一节** —— 要选具体哪节
   请用 `pku_list_lessons` + `pku_download_lessons`。
2. **`pku_download`** — 把拿到的 `m3u8` 传进来（建议给 `name`），返回 `jobId`。
3. **`pku_download_status`** — 传 `jobId` 查看进度。

## 配置（可选，全部为进程级 env，不写系统）

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `PKU_DATA_DIR` | `<项目>/.cache` | 会话、浏览器缓存、临时文件 |
| `PKU_DOWNLOAD_DIR` | `<项目>/downloads` | 视频输出目录 |
| `PKU_CONCURRENCY` | `6` | HLS 分片并发数 |
| `PKU_COURSE_HOME` | `https://course.pku.edu.cn` | 教学网首页 |
| `PKU_COURSE_NAME` | （空） | 课程名，用于自动导航（也可在工具里传 `course`） |
| `PLAYWRIGHT_BROWSERS_PATH` | `<PKU_DATA_DIR>/browsers` | 内置 Chromium 缓存位置（默认指向项目内） |

## 接入 MCP 客户端

把 `/path/to/pku-course-dl` 换成你的实际项目路径（Windows 用正斜杠或双反斜杠）。

### Claude Code

```bash
claude mcp add pku-course-dl -- node "/path/to/pku-course-dl/src/index.js"
```

如需传入配置（见[配置](#配置可选全部为进程级-env不写系统)），在 `--` 分隔符**之前**
加一个或多个 `-e KEY=value`：

```bash
claude mcp add pku-course-dl \
  -e PKU_COURSE_NAME="实验原子物理进展" \
  -e PKU_DOWNLOAD_DIR="/path/to/downloads" \
  -- node "/path/to/pku-course-dl/src/index.js"
```

默认以 `local` 作用域添加（仅当前项目）。用 `-s user` 对所有项目生效，或用 `-s project`
通过提交 `.mcp.json` 共享给团队。

> **Windows / PowerShell：** `claude mcp add … -- node …` 这种写法会失败——PowerShell 吞掉
> `--` 分隔符，导致变长选项 `-e` 把 `node` 和脚本路径一起当成环境变量值
> （报 `error: missing required argument 'commandOrUrl'`）。改用 `add-json`；但 PowerShell
> 在把 JSON 字符串传给原生程序时还会剥掉内部的双引号，所以必须把每个内部的 `"` 转义成
> `\"`（外层仍用单引号）。路径用正斜杠可省去反斜杠转义：
>
> ```powershell
> claude mcp add-json pku-course-dl '{\"command\":\"node\",\"args\":[\"D:/path/to/pku-course-dl/src/index.js\"],\"env\":{\"PKU_DOWNLOAD_DIR\":\"D:/path/to/downloads\"}}'
> ```
>
> 修改已存在的配置需先删除（`add-json` 不会覆盖）：先 `claude mcp remove pku-course-dl`，
> 再重跑上面的命令。用 `claude mcp get pku-course-dl` 核对。

### 通用 stdio 配置

```json
{
  "mcpServers": {
    "pku-course-dl": {
      "command": "node",
      "args": ["/path/to/pku-course-dl/src/index.js"],
      "env": {
        "PKU_DOWNLOAD_DIR": "/path/to/downloads"
      }
    }
  }
}
```

## 说明与限制

- 仅用于下载**你本人有权访问**的课程回放，请遵守学校规定与版权。
- 会话 cookie 通常几小时～几天过期；过期后工具会提示重新 `pku_login`。
- 目前支持标准 HLS（含 AES-128）。若某课程用 polyv / 超星 / ClassIn 等非 HLS 平台，可能抓不到 m3u8，需另行适配。
- `.cache/` 含登录 cookie，已在 `.gitignore` 中，不要提交或外传。
