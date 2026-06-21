# pku-blackboard-mcp

[English](README.md)

`pku-blackboard-mcp` 是一个用于北大教学网 Blackboard（`course.pku.edu.cn`）
的 MCP 服务器。它可以帮助你列出并下载自己有权访问的课程回放、课堂实录
以及 Blackboard 课程资料。

本项目是自包含的：

- 会话、缓存和默认下载目录都放在项目内。
- 不依赖系统级 `yt-dlp` 或系统级 `ffmpeg`。
- HLS/直连媒体下载由 Node.js 完成；HLS 封装 mp4 使用 npm 包 `ffmpeg-static`。
- 登录和解析真实播放地址时优先复用系统 Chrome 或 Edge；必要时才使用项目内
  Playwright Chromium。

> 仅用于访问和下载你本人有权限获取的课程内容。请遵守学校、课程、版权和传播规则。

## 环境要求

- Node.js 20 或更新版本
- 推荐安装 Chrome 或 Edge
- 能访问 `course.pku.edu.cn` 及相关北大回放/资源域名

## 安装

```bash
cd pku-blackboard-mcp
npm install
```

`npm install` 不会下载浏览器。只有在需要浏览器且找不到系统 Chrome/Edge 时，
才会按需下载 Playwright Chromium 到项目缓存目录。

## 工具一览

| 工具 | 用途 |
| --- | --- |
| `pku_status` | 检查保存的会话、cookie 数量和数据/下载路径。 |
| `pku_login` | 打开浏览器完成 IAAA 登录并保存会话。 |
| `pku_list_courses` | 不打开浏览器，列出你的 Blackboard 课程。 |
| `pku_list_lessons` | 列出某课程的回放/课堂实录课次。 |
| `pku_download_lessons` | 打开浏览器解析所选课次的真实媒体地址，并后台下载。 |
| `pku_capture_replay` | 手动兜底：抓取单节回放媒体地址。 |
| `pku_download` | 直接下载一个明确的 m3u8 地址。 |
| `pku_download_status` | 查询回放或资料下载任务状态。 |
| `pku_list_materials` | 列出 Blackboard 菜单栏目中的附件和可见文本。 |
| `pku_download_materials` | 下载课程附件，并可把文本保存为 Markdown。 |

## 回放下载流程

1. 运行 `pku_login`。

   浏览器会打开 `course.pku.edu.cn`。完成 IAAA 登录后，服务会把会话保存到
   `.cache/session-state.json`。

2. 运行 `pku_list_courses`，或直接运行 `pku_list_lessons`。

   ```json
   {
     "course": "量子多体理论"
   }
   ```

   `pku_list_lessons` 通常通过已保存 cookie 直接 HTTP 解析，不打开浏览器。
   返回结果包含课次序号、标题、录制时间，以及可用时的内部播放页地址。

3. 选择课次序号，运行 `pku_download_lessons`。

   ```json
   {
     "course": "量子多体理论",
     "indices": [1],
     "namePrefix": "量子多体理论-2024-12-27"
   }
   ```

   这一步会打开一个浏览器窗口，这是正常现象：Blackboard 只有在回放 SSO/播放器
   前端逻辑运行后，才会暴露真实媒体地址。解析完成后，服务会为 HLS（m3u8）
   或直连 MP4 启动后台下载任务。

4. 运行 `pku_download_status` 查询进度。

   ```json
   {
     "jobId": "job-1"
   }
   ```

   完成后的结果会包含 `outFile`。

## 课程资料流程

1. 运行 `pku_list_materials`。

   ```json
   {
     "course": "量子多体理论",
     "types": ["content", "announcements", "grades", "staff"]
   }
   ```

   返回内容包括：

   - `files`：可下载的 Blackboard 附件，通常是 `bbcswebdav` URL
   - `texts`：公告、成绩、教师信息等可见文本摘要
   - `sections`：每个菜单栏目的提取详情

2. 运行 `pku_download_materials`。

   ```json
   {
     "course": "量子多体理论",
     "fileUrls": ["https://course.pku.edu.cn/bbcswebdav/..."],
     "saveText": "md"
   }
   ```

   不传 `fileUrls` 时，会下载匹配范围内的全部附件。设置
   `downloadFiles: false` 且 `saveText: "md"` 时，可以只保存文本。

## 配置

所有配置都由 MCP 客户端以进程级环境变量传入。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PKU_DATA_DIR` | `<project>/.cache` | 会话、浏览器缓存和临时数据。 |
| `PKU_DOWNLOAD_DIR` | `<project>/downloads` | 默认下载目录。 |
| `PKU_CONCURRENCY` | `6` | HLS 分片下载并发数。 |
| `PKU_COURSE_HOME` | `https://course.pku.edu.cn` | Blackboard 入口。 |
| `PKU_COURSE_NAME` | 空 | 工具默认课程名。 |
| `PLAYWRIGHT_BROWSERS_PATH` | `<PKU_DATA_DIR>/browsers` | 项目内 Playwright 浏览器缓存目录。 |

输出目录优先级：

```text
工具参数 outDir
> PKU_DOWNLOAD_DIR
> <project>/downloads
```

## 接入 Claude Code

把 `/path/to/pku-blackboard-mcp` 替换为你的本地项目路径。

```bash
claude mcp add pku-blackboard-mcp -- node "/path/to/pku-blackboard-mcp/src/index.js"
```

带环境变量：

```bash
claude mcp add pku-blackboard-mcp \
  -e PKU_DOWNLOAD_DIR="/path/to/downloads" \
  -e PKU_COURSE_NAME="量子多体理论" \
  -- node "/path/to/pku-blackboard-mcp/src/index.js"
```

### Windows PowerShell

PowerShell 可能会错误处理 `--` 分隔符和 JSON 引号。通常 `add-json` 更可靠：

```powershell
claude mcp add-json pku-blackboard-mcp '{\"command\":\"node\",\"args\":[\"D:/path/to/pku-blackboard-mcp/src/index.js\"],\"env\":{\"PKU_DOWNLOAD_DIR\":\"D:/path/to/downloads\"}}'
```

更新已有配置：

```powershell
claude mcp remove pku-blackboard-mcp
claude mcp add-json pku-blackboard-mcp '{\"command\":\"node\",\"args\":[\"D:/path/to/pku-blackboard-mcp/src/index.js\"]}'
claude mcp get pku-blackboard-mcp
```

## 通用 MCP 配置

```json
{
  "mcpServers": {
    "pku-blackboard-mcp": {
      "command": "node",
      "args": ["/path/to/pku-blackboard-mcp/src/index.js"],
      "env": {
        "PKU_DOWNLOAD_DIR": "/path/to/downloads"
      }
    }
  }
}
```

## 测试

```bash
npm test
node --check src/index.js
node --check src/capture.js
node --check src/jobs.js
node --check src/materials.js
```

完整离线和 live 测试清单见 [TESTING.md](TESTING.md)。

## 说明与限制

- 下载回放时可能会打开浏览器，用于解析 SSO/播放器中的真实媒体地址。
- 有些回放暴露的是直连 MP4，而不是 HLS；`pku_download_lessons` 已支持两者。
- `pku_download` 只用于明确的 m3u8 URL；课程课次下载请使用 `pku_download_lessons`。
- `.cache/` 含登录 cookie，不要提交或分享。
