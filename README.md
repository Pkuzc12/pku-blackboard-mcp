# pku-blackboard-mcp

[中文文档](README.zh.md)

`pku-blackboard-mcp` is an MCP server for PKU Blackboard (`course.pku.edu.cn`).
It helps you list and download course recordings, replay videos, and Blackboard
course materials that your account is authorized to access.

The server is self-contained:

- It stores session state, cache, and default downloads inside the project.
- It does not require system `yt-dlp` or system `ffmpeg`.
- It uses Node.js for HLS/direct-media downloads; HLS remuxing uses the npm
  package `ffmpeg-static`.
- It reuses a system Chrome or Edge for login and media URL resolution, falling
  back to project-local Playwright Chromium only when needed.

> Use this only for courses and files you are authorized to access. Follow PKU,
> course, copyright, and redistribution rules.

## Requirements

- Node.js 20 or newer
- Chrome or Edge recommended
- Network access to `course.pku.edu.cn` and related PKU replay/resource domains

## Install

```bash
cd pku-blackboard-mcp
npm install
```

`npm install` does not download a browser. Playwright Chromium is downloaded
only if no usable system Chrome/Edge is available when a browser is needed.

## Capabilities

| Tool | Purpose |
| --- | --- |
| `pku_status` | Check saved session, cookie count, and data/download paths. |
| `pku_login` | Open a browser for manual IAAA login and save the session. |
| `pku_list_courses` | List your Blackboard courses without opening a browser. |
| `pku_list_lessons` | List recording/replay lessons for a course. |
| `pku_download_lessons` | Resolve selected lesson media URLs in a browser, then download in background. |
| `pku_capture_replay` | Manual fallback for capturing one replay media URL. |
| `pku_download` | Download one explicit m3u8 URL as a background job. |
| `pku_download_status` | Query background recording/material download jobs. |
| `pku_list_materials` | List course attachments and visible text from Blackboard menu tabs. |
| `pku_download_materials` | Download selected course attachments and optionally save text as Markdown. |

## Recording Workflow

1. Run `pku_login`.

   A browser opens at `course.pku.edu.cn`. Complete IAAA login. The server saves
   the session to `.cache/session-state.json` after Blackboard is reached.

2. Run `pku_list_courses` or directly run `pku_list_lessons`.

   ```json
   {
     "course": "量子多体理论"
   }
   ```

   `pku_list_lessons` usually replays saved cookies over HTTP and does not open a
   browser. It returns lesson indices, titles, record times, and internal player
   URLs when available.

3. Pick lesson indices and run `pku_download_lessons`.

   ```json
   {
     "course": "量子多体理论",
     "indices": [1],
     "namePrefix": "quantum-many-body-2024-12-27"
   }
   ```

   This step opens one browser window. That is expected: Blackboard only exposes
   the real media URL after its replay SSO/player logic runs. The server then
   starts background downloads for either HLS (`m3u8`) or direct MP4 media.

4. Run `pku_download_status`.

   ```json
   {
     "jobId": "job-1"
   }
   ```

   Completed jobs include `outFile`.

## Materials Workflow

1. Run `pku_list_materials`.

   ```json
   {
     "course": "量子多体理论",
     "types": ["content", "announcements", "grades", "staff"]
   }
   ```

   The result contains:

   - `files`: downloadable Blackboard attachments, usually `bbcswebdav` URLs
   - `texts`: visible text snippets such as announcements, grades, and staff info
   - `sections`: per-menu-tab extraction details

2. Run `pku_download_materials`.

   ```json
   {
     "course": "量子多体理论",
     "fileUrls": ["https://course.pku.edu.cn/bbcswebdav/..."],
     "saveText": "md"
   }
   ```

   Omit `fileUrls` to download all matched files. Set `downloadFiles: false` and
   `saveText: "md"` to save text only.

## Configuration

All configuration is process-scoped environment passed by your MCP client.

| Env var | Default | Description |
| --- | --- | --- |
| `PKU_DATA_DIR` | `<project>/.cache` | Session state, browser cache, temp data. |
| `PKU_DOWNLOAD_DIR` | `<project>/downloads` | Default output directory. |
| `PKU_CONCURRENCY` | `6` | HLS segment download concurrency. |
| `PKU_COURSE_HOME` | `https://course.pku.edu.cn` | Blackboard entry point. |
| `PKU_COURSE_NAME` | empty | Default course name for tools that accept `course`. |
| `PLAYWRIGHT_BROWSERS_PATH` | `<PKU_DATA_DIR>/browsers` | Project-local Playwright browser cache. |

Output directory priority:

```text
tool argument outDir
> PKU_DOWNLOAD_DIR
> <project>/downloads
```

## Connect to Claude Code

Replace `/path/to/pku-blackboard-mcp` with your local project path.

```bash
claude mcp add pku-blackboard-mcp -- node "/path/to/pku-blackboard-mcp/src/index.js"
```

With environment variables:

```bash
claude mcp add pku-blackboard-mcp \
  -e PKU_DOWNLOAD_DIR="/path/to/downloads" \
  -e PKU_COURSE_NAME="量子多体理论" \
  -- node "/path/to/pku-blackboard-mcp/src/index.js"
```

### Windows PowerShell

PowerShell may mishandle the `--` separator and JSON quoting for native
commands. `add-json` is often more reliable:

```powershell
claude mcp add-json pku-blackboard-mcp '{\"command\":\"node\",\"args\":[\"D:/path/to/pku-blackboard-mcp/src/index.js\"],\"env\":{\"PKU_DOWNLOAD_DIR\":\"D:/path/to/downloads\"}}'
```

To update an existing entry:

```powershell
claude mcp remove pku-blackboard-mcp
claude mcp add-json pku-blackboard-mcp '{\"command\":\"node\",\"args\":[\"D:/path/to/pku-blackboard-mcp/src/index.js\"]}'
claude mcp get pku-blackboard-mcp
```

## Generic MCP Config

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

## Testing

```bash
npm test
node --check src/index.js
node --check src/capture.js
node --check src/jobs.js
node --check src/materials.js
```

See [TESTING.md](TESTING.md) for the full offline and live testing checklist.

## Notes and Limitations

- Recording downloads may open a browser to resolve SSO/player media URLs.
- Some recordings expose direct MP4 media instead of HLS; both are supported by
  `pku_download_lessons`.
- `pku_download` is for explicit m3u8 URLs only; use `pku_download_lessons` for
  course lessons.
- `.cache/` contains login cookies and must not be committed or shared.
