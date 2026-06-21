# pku-blackboard-mcp 功能与测试清单

本文用于接手开发和验收当前 MCP server。它分为两类测试：

- **离线测试**：不访问 `course.pku.edu.cn`，不需要登录，主要验证解析逻辑、模块加载和 MCP 启动。
- **Live 测试**：需要先运行 `pku_login` 获取有效 session，访问北大教学网真实页面，只测试你有权访问的课程资料和回放。

> 只下载你本人有权访问的课程内容。`.cache/session-state.json` 含登录 cookie，不要提交或分享。

## 功能总览

### 登录与状态

| 工具 | 功能 | 是否开浏览器 |
| --- | --- | --- |
| `pku_status` | 检查是否有 session、session 是否仍有效、数据/下载目录位置 | 否 |
| `pku_login` | 打开浏览器，手动完成 IAAA 登录，并保存 session | 是 |

### 课程与回放

| 工具 | 功能 | 说明 |
| --- | --- | --- |
| `pku_list_courses` | 列出账号下课程 | 复用 cookie，HTTP 解析，不开浏览器 |
| `pku_list_lessons` | 列出某课程课堂实录/课程回放的课次 | 优先 HTTP 解析，必要时回退浏览器 |
| `pku_download_lessons` | 按课次序号解析真实媒体地址并启动后台下载 | 会打开浏览器运行回放 SSO/播放器逻辑；支持 HLS 和直连 MP4 |
| `pku_capture_replay` | 手动兜底抓单个回放媒体地址 | 单节课 fallback |
| `pku_download` | 直接按 m3u8 后台下载 HLS，默认封装 mp4 | 不负责找课，只负责下载 |
| `pku_download_status` | 查询回放下载或资料附件下载 job 状态 | 统一 job 状态入口 |

### 课程资料

| 工具 | 功能 | 说明 |
| --- | --- | --- |
| `pku_list_materials` | 列出课程菜单下的资料 | 返回统一 `{ files, texts }`，不下载 |
| `pku_download_materials` | 下载课程资料附件，可选保存文本为 Markdown | 后台 job 下载附件；文本可用 `saveText: "md"` 保存 |

资料解析覆盖范围：

- `content`：内容文件夹、附件、子文件夹递归、下一页分页。
- `announcements`：公告标题和正文。
- `grades`：成绩区域文本。
- `staff`：教师/联系人信息文本。
- `discussion` / `mail` / `tool`：尽力抓可见文本和附件。
- 外部链接：只列为不可抓取链接，不主动访问非 PKU 域名。

## 当前已实现的本地测试

### 运行全部离线测试

PowerShell 上建议使用 `npm.cmd`，避免 `npm.ps1` 被执行策略拦截：

```powershell
npm.cmd test
```

预期：

```text
3 tests passed
```

当前测试文件：

```text
test/materials.test.js
```

覆盖内容：

- content 页面可解析 `bbcswebdav` 附件。
- content 页面可解析 item 标题和正文。
- content 页面可发现子文件夹和“下一页”分页。
- announcements 页面可解析公告标题和正文。
- grades 页面可解析成绩区域文本。

### 语法检查

```powershell
node --check src/materials.js
node --check src/jobs.js
node --check src/portal.js
node --check src/index.js
```

预期：无输出，退出码为 0。

### MCP 入口启动检查

```powershell
node -e "import('./src/index.js')"
```

预期输出：

```text
[pku-blackboard-mcp] server ready
```

## Live 测试前置条件

先确认 session 状态：

```powershell
node -e "import('./src/session.js').then(async s => console.log(JSON.stringify(await s.checkSessionValid(), null, 2)))"
```

有效 session 预期：

```json
{
  "valid": true
}
```

如果返回：

```json
{
  "valid": false,
  "reason": "expired"
}
```

需要通过 MCP 客户端运行：

```text
pku_login
```

完成 IAAA 登录后再测下面的 live 场景。

## Live 测试矩阵

以下示例使用报告里提到的课程 key：

```text
_86050_1
```

也可以改成你当前账号有权访问的课程名：

```json
{ "course": "课程名" }
```

### 1. 状态测试

MCP 调用：

```json
{
  "tool": "pku_status",
  "arguments": {}
}
```

验收点：

- `loggedIn` 为 `true`。
- `sessionValid` 为 `true`。
- 返回 `dataDir`、`downloadDir`、`stateFile`。

### 2. 列课程

MCP 调用：

```json
{
  "tool": "pku_list_courses",
  "arguments": {}
}
```

验收点：

- `ok: true`。
- `count > 0`。
- `courses` 中能看到当前账号课程。
- 不应打开浏览器。

### 3. 列回放课次

注意：当前 `pku_list_lessons` 工具接受 `course` 或 `url`，不直接接受 `courseKey`。如果只知道 `courseKey`，先用 `pku_list_courses` 找课程名，或传课堂实录列表页 URL。

推荐调用：

```json
{
  "tool": "pku_list_lessons",
  "arguments": {
    "course": "量子力学"
  }
}
```

验收点：

- `ok: true`。
- `lessons` 是数组。
- 每项有 `index`、`title`，最好还有 `recordTime`。
- 默认优先不开浏览器。

### 4. 下载选定回放

先从 `pku_list_lessons` 结果里选 1-2 个序号。

MCP 调用：

```json
{
  "tool": "pku_download_lessons",
  "arguments": {
    "course": "量子力学",
    "indices": [1],
    "format": "mp4"
  }
}
```

验收点：

- 返回 `ok: true` 或部分成功。
- 每个成功课次返回 `jobId`。
- 下载任务不阻塞 MCP 调用。

继续查状态：

```json
{
  "tool": "pku_download_status",
  "arguments": {
    "jobId": "job-1"
  }
}
```

验收点：

- `status` 从 `running` 变为 `done`。
- `outFile` 指向实际 `.mp4` 或 `.ts` 文件。
- 文件存在且大小合理。

### 5. 列课程资料

MCP 调用：

```json
{
  "tool": "pku_list_materials",
  "arguments": {
    "courseKey": "_86050_1"
  }
}
```

也可以按类型缩小范围：

```json
{
  "tool": "pku_list_materials",
  "arguments": {
    "courseKey": "_86050_1",
    "types": ["content", "announcements", "grades", "staff"]
  }
}
```

验收点：

- 有效 session 下应返回 `ok: true`。
- 返回 `files`、`texts`、`sections`。
- `files` 中附件 URL 应为 `course.pku.edu.cn` 或 PKU 相关域名下的 `bbcswebdav`。
- `texts` 中公告/成绩/教师信息应被截断到约 1500 字以内。
- 外部链接不应被下载。

如果 session 过期，预期返回：

```json
{
  "ok": false,
  "reason": "expired",
  "message": "Session expired. Run pku_login again."
}
```

### 6. 下载课程资料附件

先用 `pku_list_materials` 看清楚 `files`，建议先只选一个小附件。

MCP 调用：

```json
{
  "tool": "pku_download_materials",
  "arguments": {
    "courseKey": "_86050_1",
    "fileUrls": [
      "https://course.pku.edu.cn/bbcswebdav/..."
    ],
    "saveText": "md"
  }
}
```

验收点：

- 返回 `jobs`，每个文件一个 `jobId`。
- `textFile` 存在时，应是保存出的 Markdown。
- 用 `pku_download_status` 查询附件 job，最终应为 `done`。
- 附件扩展名应尽量来自 `Content-Disposition`、URL、magic bytes 或 `Content-Type`。
- 同名文件应自动去重，不覆盖已有文件。

### 7. 只保存文本，不下载附件

MCP 调用：

```json
{
  "tool": "pku_download_materials",
  "arguments": {
    "courseKey": "_86050_1",
    "types": ["announcements", "grades", "staff"],
    "downloadFiles": false,
    "saveText": "md"
  }
}
```

验收点：

- `jobs` 为空数组。
- `textFile` 非空。
- Markdown 内容包含各 text item 的标题、来源 URL、正文。

## 建议补充的测试

这些还没有全部自动化，建议后续补：

1. 附件下载 job 单元测试：mock `httpGetBuffer`，验证文件名、扩展名、同名去重、状态从 `running` 到 `done/error`。
2. `listCourseTabsHttp` fixture 测试：覆盖 `launchLink.jsp` 302 后重新分类。
3. content 递归测试：多层 `listContent.jsp` 子文件夹、分页去重、循环链接防护。
4. MCP 工具 schema smoke test：启动 server 后检查工具注册名完整。
5. live 小文件下载测试：重新 `pku_login` 后，选一个很小的课程附件跑完整下载链路。

## 当前已知限制

- 当前环境里的 saved session 已过期，真实站点 list/download 无法完成验收，需要先 `pku_login`。
- `pku_list_lessons` 目前没有直接暴露 `courseKey` 参数，常规用法是传 `course` 或 `url`。
- Blackboard 页面 HTML 结构可能因课程/工具不同变化；未知工具页走 best-effort 文本抓取。
- 附件下载会复用保存的 cookie，只应访问授权课程资料。

## 推荐验收顺序

1. 跑离线测试：`npm.cmd test`。
2. 跑语法和入口检查。
3. `pku_login` 刷新 session。
4. `pku_status` 确认 session 有效。
5. `pku_list_courses` 找目标课程名。
6. `pku_list_materials` 先只列，不下载。
7. 选一个小附件跑 `pku_download_materials`。
8. 用 `pku_download_status` 确认附件 job 完成。
9. 再测试回放链路：`pku_list_lessons` -> `pku_download_lessons` -> `pku_download_status`。
10. 所有 live 测试通过后，再整理 README 并提交 git。
