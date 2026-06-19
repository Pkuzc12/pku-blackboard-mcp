#!/usr/bin/env node
// pku-course-dl — download PKU course replays (课堂实录 / 课程回放, lecture
// recordings) from course.pku.edu.cn. Self-contained: native HLS download +
// AES-128 decrypt,
// project-local Playwright browser, ffmpeg-static remux. Nothing touches the
// system environment.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  runLogin,
  captureReplay,
  listLessons,
  downloadLessons,
} from "./capture.js";
import { startDownload, getJob, listJobs, setProgressNotifier } from "./jobs.js";
import { hasSession, pkuCookieCount } from "./session.js";
import { DATA_DIR, DOWNLOAD_DIR, STATE_FILE } from "./config.js";

const server = new McpServer(
  {
    name: "pku-course-dl",
    version: "0.1.0",
  },
  // Declare the logging capability so we can push live download progress to the
  // client's log panel via notifications/message.
  { capabilities: { logging: {} } }
);

function text(obj) {
  return {
    content: [
      {
        type: "text",
        text:
          typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
      },
    ],
  };
}

server.registerTool(
  "pku_status",
  {
    title: "Status / 查看登录与配置状态",
    description:
      "Report whether a session is valid, plus the data and download dirs. Does not open a browser. / 查看当前会话是否有效、数据目录与下载目录位置。不打开浏览器。",
    inputSchema: {},
  },
  async () => {
    return text({
      loggedIn: hasSession(),
      pkuCookies: pkuCookieCount(),
      stateFile: STATE_FILE,
      dataDir: DATA_DIR,
      downloadDir: DOWNLOAD_DIR,
      hint: hasSession()
        ? "Session ready; run pku_list_lessons or pku_capture_replay. / 已有会话，可直接 pku_list_lessons 或 pku_capture_replay。"
        : "Not logged in; run pku_login first. / 尚未登录，请先运行 pku_login。",
    });
  }
);

server.registerTool(
  "pku_login",
  {
    title: "Login (IAAA) / 登录北大教学网",
    description:
      "Open a browser window at course.pku.edu.cn for you to complete IAAA login (2FA / WeChat supported); the session is saved once you land back on the course site. Prefers system Chrome/Edge. / 打开一个浏览器窗口到 course.pku.edu.cn，由你手动完成 IAAA 登录(可含双因子/微信)，检测到回到教学网后自动保存会话。优先使用系统 Chrome/Edge。",
    inputSchema: {
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(900)
        .optional()
        .describe("Max seconds to wait for manual login (default 300). / 等待手动登录的最长秒数，默认 300。"),
    },
  },
  async ({ timeoutSeconds }) => {
    const res = await runLogin({
      timeoutMs: (timeoutSeconds || 300) * 1000,
    });
    return text(res);
  }
);

server.registerTool(
  "pku_capture_replay",
  {
    title: "Capture replay m3u8 / 抓取回放的 m3u8 地址",
    description:
      "Open a browser window (reusing the saved session); as you navigate to a course recording and press play, the tool sniffs the network for the m3u8 playlist URL. Optionally pass a direct replay-page URL. / 打开浏览器窗口(复用已保存会话)。在窗口里导航到目标课程的课堂实录/回放并点击播放，本工具会监听网络抓取 m3u8 播放列表地址。可选传入直达回放页 URL。",
    inputSchema: {
      url: z
        .string()
        .url()
        .optional()
        .describe("Optional direct replay-page URL; omit to open the course home and navigate yourself. / 可选：直接打开的回放页面 URL；不填则打开教学网首页由你导航。"),
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(900)
        .optional()
        .describe("Max seconds to wait for an m3u8 (default 240). / 等待捕获 m3u8 的最长秒数，默认 240。"),
      autoplay: z
        .boolean()
        .optional()
        .describe(
          "Auto-play: play videos across iframes, click play buttons, open the first watch link. Default true; set false to click manually. / 是否自动播放：自动跨 iframe 播放视频、点击播放按钮、打开第一个观看链接。默认 true，设为 false 则等你手动点击。"
        ),
      course: z
        .string()
        .optional()
        .describe(
          "Course name (e.g. '实验原子物理进展'); used to auto-open course -> recordings -> watch from the home page. Fuzzy-matched. Also settable via PKU_COURSE_NAME. / 课程名（如 '实验原子物理进展'）。从首页启动时用它自动点进对应课程→课堂实录→观看，支持模糊匹配。也可用环境变量 PKU_COURSE_NAME。"
        ),
    },
  },
  async ({ url, timeoutSeconds, autoplay, course }) => {
    const res = await captureReplay({
      url,
      timeoutMs: (timeoutSeconds || 240) * 1000,
      autoplay: autoplay !== false,
      course,
    });
    return text(res);
  }
);

server.registerTool(
  "pku_list_lessons",
  {
    title: "List lessons / 列出课程的全部课次",
    description:
      "Open a browser (reusing the session), navigate to the course's recordings list, and return every lesson (index + title) without playing or downloading. Pick indices from the result, then call pku_download_lessons. / 打开浏览器(复用会话)，导航到目标课程的课堂实录/回放列表，列出全部课次(序号+标题)，不播放、不下载。拿到列表后挑选序号，再调用 pku_download_lessons。",
    inputSchema: {
      course: z
        .string()
        .optional()
        .describe("Course name (e.g. '实验原子物理进展'); auto-opens the matching course from the home page. Fuzzy-matched. Also PKU_COURSE_NAME. / 课程名(如 '实验原子物理进展')。从首页启动时用它自动点进对应课程，支持模糊匹配。也可用环境变量 PKU_COURSE_NAME。"),
      url: z
        .string()
        .url()
        .optional()
        .describe("Optional direct recordings-list URL; omit to navigate from home by course name. / 可选：直接打开的课堂实录列表页 URL；不填则从首页按课程名导航。"),
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(900)
        .optional()
        .describe("Max seconds to reach the lesson list (default 120). / 到达课次列表的最长等待秒数，默认 120。"),
    },
  },
  async ({ course, url, timeoutSeconds }) => {
    const res = await listLessons({
      course,
      url,
      timeoutMs: (timeoutSeconds || 120) * 1000,
    });
    return text(res);
  }
);

server.registerTool(
  "pku_download_lessons",
  {
    title: "Download lessons (background) / 批量下载所选课次(后台任务)",
    description:
      "Pass the lesson `indices` from pku_list_lessons. Opens one browser window, plays each lesson in turn, captures its m3u8, and starts a background download immediately. Returns a jobId per lesson; poll with pku_download_status. / 传入 pku_list_lessons 返回的课次序号数组 indices。打开一个浏览器窗口，依次播放每节课、抓取其 m3u8 并立即起后台下载任务。返回每节课的 jobId，用 pku_download_status 查询进度。",
    inputSchema: {
      indices: z
        .array(z.number().int().min(1))
        .min(1)
        .describe("1-based lesson indices from pku_list_lessons, e.g. [1, 3, 5]. / 要下载的课次序号数组(1 起)，来自 pku_list_lessons，如 [1, 3, 5]。"),
      course: z
        .string()
        .optional()
        .describe("Course name; same as in pku_list_lessons. Also PKU_COURSE_NAME. / 课程名；与 pku_list_lessons 用法一致。也可用环境变量 PKU_COURSE_NAME。"),
      url: z
        .string()
        .url()
        .optional()
        .describe("Optional direct recordings-list URL; use the same one as pku_list_lessons. / 可选：直接打开的课堂实录列表页 URL；建议与 pku_list_lessons 用同一个。"),
      namePrefix: z
        .string()
        .optional()
        .describe("Output filename prefix (default: course name); files look like '<prefix>-03'. / 输出文件名前缀，默认课程名。最终文件名形如 '<前缀>-03'。"),
      format: z
        .enum(["mp4", "ts"])
        .optional()
        .describe("Output format; default mp4 (needs ffmpeg-static), ts is raw concatenated segments. / 输出格式，默认 mp4(需 ffmpeg-static)；ts 为原始分片拼接。"),
      outDir: z
        .string()
        .optional()
        .describe("Optional output dir; default project downloads/ or PKU_DOWNLOAD_DIR. / 可选输出目录，默认项目 downloads/ 或 PKU_DOWNLOAD_DIR。"),
      timeoutSeconds: z
        .number()
        .int()
        .min(30)
        .max(900)
        .optional()
        .describe("Max seconds to capture each lesson's m3u8 (default 180). / 每节课抓取 m3u8 的最长等待秒数，默认 180。"),
    },
  },
  async ({ indices, course, url, namePrefix, format, outDir, timeoutSeconds }) => {
    const res = await downloadLessons({
      indices,
      course,
      url,
      namePrefix,
      format,
      outDir,
      timeoutMs: (timeoutSeconds || 180) * 1000,
    });
    return text(res);
  }
);

server.registerTool(
  "pku_download",
  {
    title: "Download replay (background) / 下载回放(后台任务)",
    description:
      "Natively download and AES-128-decrypt the HLS segments from an m3u8 URL, remuxing to .mp4 by default. Returns a jobId immediately; poll with pku_download_status. / 根据 m3u8 地址原生下载并 AES-128 解密 HLS 分片，默认封装为 .mp4。立即返回 jobId，用 pku_download_status 查询进度。",
    inputSchema: {
      m3u8: z.string().url().describe("The replay's m3u8 playlist URL. / 回放的 m3u8 播放列表地址。"),
      name: z
        .string()
        .optional()
        .describe("Output filename without extension, e.g. 'lesson-01-2026-03-03'. / 输出文件名(不含扩展名)，例如 'lesson-01-2026-03-03'。"),
      referer: z
        .string()
        .url()
        .optional()
        .describe("Optional Referer header (some resource servers check it). / 可选 Referer 头(部分资源服务器校验)。"),
      outDir: z
        .string()
        .optional()
        .describe("Optional output dir; default project downloads/ or PKU_DOWNLOAD_DIR. / 可选输出目录，默认项目 downloads/ 或 PKU_DOWNLOAD_DIR。"),
      format: z
        .enum(["mp4", "ts"])
        .optional()
        .describe("Output format; default mp4 (needs ffmpeg-static), ts is raw concatenated segments. / 输出格式，默认 mp4(需 ffmpeg-static)；ts 为原始分片拼接。"),
    },
  },
  async ({ m3u8, name, referer, outDir, format }) => {
    const job = startDownload({ m3u8, name, referer, outDir, format });
    return text({
      jobId: job.id,
      status: job.status,
      message: `Started download job ${job.id}; poll with pku_download_status. / 已开始下载任务 ${job.id}。用 pku_download_status 查询进度。`,
    });
  }
);

server.registerTool(
  "pku_download_status",
  {
    title: "Download status / 查询下载任务进度",
    description: "Query one download job (pass jobId) or list all jobs with their progress and results. / 查询单个下载任务(传 jobId)或列出全部任务的进度与结果。",
    inputSchema: {
      jobId: z
        .string()
        .optional()
        .describe("Job ID; omit to list all jobs. / 任务 ID；不填则列出所有任务。"),
    },
  },
  async ({ jobId }) => {
    if (jobId) {
      const j = getJob(jobId);
      return text(j || { error: `Job not found / 未找到任务 ${jobId}` });
    }
    return text({ jobs: listJobs() });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

// Push live download progress to the client as logging notifications. Wrapped
// in catch so a client that ignores logging never breaks a download.
setProgressNotifier((message) => {
  server.server
    .sendLoggingMessage({ level: "info", logger: "pku-download", data: message })
    .catch(() => {});
});

// stderr is safe for logging on stdio transport (stdout is the protocol channel).
console.error("[pku-course-dl] server ready");
