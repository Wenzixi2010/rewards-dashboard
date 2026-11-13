# Rewards Dashboard（简体中文版）

这是 [microsoft-rewards-script](https://github.com/thenetsky/microsoft-rewards-script) 的配套积分面板，界面和使用说明已汉化为简体中文。面板通过 HTTP 连接脚本的[控制 API](https://github.com/thenetsky/microsoft-rewards-script/tree/v4/scripts/api)（`API_MODE=true`），在 `http://<host-ip>:8890` 展示账号状态、积分余额和变化趋势，并支持启动、停止和定时运行，以及编辑脚本配置。

## 截图

以下截图来自原项目，用于展示桌面端和移动端布局。

| 桌面端 | 移动端 |
| --- | --- |
| ![桌面端截图](./docs/Screenshot-dash.png) | ![移动端截图](./docs/Screenshot-mobile.png) |

## 功能

- **本地存储**：所有数据都保存在本地，账号数据由你自行掌握。
- **账号概览**：查看各账号的积分、运行状态和错误提示。
- **积分累计条**：按账号展示每日积分块，并用分隔线区分每周；悬停即可查看准确日期、当日所得积分和总积分。
- **免密登录验证码**：显示两位数登录确认码和实时 60 秒倒计时，避免在日志中错过确认码。
- **历史记录**：解析后的事件保存在本地 SQLite 数据库中，重启后仍可查看，不依赖脚本自身的内存日志缓冲区。
- **多种主题**：支持 Nord、Dracula、Catppuccin、Gruvbox、Tokyo Night 等主题。
- **响应式布局**：提供适合移动端使用的精简视图。

## 快速开始（Docker）

1. 在 `microsoft-rewards-script` 服务中启用控制 API：设置 `API_MODE=true` 和 `API_TOKEN=<some-long-random-string>`，并开放端口 `3010`。

> [!CAUTION]
> 以下权限在脚本侧配置，均为可选：`API_ALLOW_CONFIG_WRITE=true` 允许修改配置，`API_ALLOW_CONFIG_REVEAL=true` 允许显示敏感配置值，`API_ALLOW_SCHEDULE_WRITE=true` 允许修改脚本容器的定时任务。仅启用需要的功能；启动面板不需要这些权限。

2. 检查本仓库的 `compose.yaml`，在其同级 `.env` 文件中将 `API_TOKEN` 设置为上述令牌。示例中的 `CONTROL_API_TOKEN: "${API_TOKEN}"` 会将该值传给面板。
3. 使用本地汉化源码构建并启动容器：`docker compose up -d --build`。仓库示例保留了上游镜像地址，`--build` 用于确保使用当前源码。
4. 在浏览器中访问 `http://<host-ip>:8890`。

> [!WARNING]
> 两个服务需要共享 Docker 网络，面板才能通过容器名访问控制 API。
> 可以将完整的 `rewards-dashboard` 服务配置复制到脚本的 `compose.yaml` 中，参考 [sample-stack-compose.yaml](sample-stack-compose.yaml)。
> 也可以先创建一个 Docker 网络（例如 `rewards`），再将以下配置分别加入脚本和面板的 `compose.yaml`。

```yaml
  networks:
    - rewards

networks:
  rewards:
    driver: bridge
    external: true
```

## 快速开始（直接运行）

需要 Node 22.13 或更新版本，使用内置的 `node:sqlite`，无需安装 npm 依赖包。

```bash
# 在脚本仓库中运行
API_TOKEN=some-long-random-string node scripts/api/server.js
```

然后在本仓库的 `rewards-dashboard` 子目录中配置并启动面板。`CONTROL_API_TOKEN` 必须与控制 API 的 `API_TOKEN` 一致：

```bash
cd rewards-dashboard
cp env.example .env      # 编辑 CONTROL_API_URL 和 CONTROL_API_TOKEN
npm start                # 访问 http://localhost:8890
```

## 身份验证

面板的浏览器登录保护通过 `DASHBOARD_USERNAME` 和 `DASHBOARD_PASSWORD` 单独配置。只有两项都非空时才会启用 HTTP Basic 身份验证；任意一项留空，访问面板时就不会出现浏览器登录提示。这不会关闭面板与控制 API 之间的身份验证，`CONTROL_API_TOKEN` 仍需与 API 的 `API_TOKEN` 一致。

## 可选 API 权限

以下两项功能需要在 **API 侧**启用权限，默认均为关闭：

| 控制 API 配置项 | 启用的功能 |
| --- | --- |
| `API_ALLOW_CONFIG_WRITE=true` | 允许在**配置**页保存修改。未启用时配置为只读，保存会返回 403，页面也会给出提示。 |
| `API_ALLOW_CONFIG_REVEAL=true` | 允许使用**配置**页的“显示敏感信息”开关。未启用时，Webhook URL 和令牌仍显示为 `***REDACTED***`。 |

---

## 页面说明

**概览**：展示账号数量、总积分余额、上次运行、异常账号和下次定时运行等统计卡片。脚本运行时，还会显示实时进度条、各账号的运行进度和最近活动。

**账号**：结合已配置账号和日志中观测到的数据，展示当前余额、每日累计积分、今日所得、成功或错误状态、连续签到天数、连续签到保护状态及剩余保护天数。详情面板还包含账号序号、地区、语言、TOTP、恢复邮箱、代理和累计获得积分。账号配置保存在脚本的 `.env` 中，本页用于查看数据。

**日志**：通过 SSE 实时查看日志，支持按级别筛选、文本搜索、暂停、自动滚动、加载更多、下载和清空。暂停显示期间仍会缓存日志。

**运行记录**：展示每日获得积分（可选 14、30 或 90 天视图）和运行历史表格，还可以展开查看 API 提供的进程退出记录，以发现未输出 `RUN-END` 日志就崩溃的运行。中途异常退出的运行会被结束并标记为**已崩溃**，同时显示退出码。

**定时任务**：提供面板自身的 Cron 调度。支持预设时间、实时校验的 Cron 表达式及中文说明、排除账号、补跑错过的任务、运行中跳过、下次和上次运行时间，以及最近结果。定时任务保存在面板数据库中，到点后通过控制 API 自动启动运行。

**配置**：查看和编辑脚本的 `config.json`，既有常用布尔选项的快捷开关，也有原始 JSON 编辑器。保存时**仅通过 PATCH 提交修改过的字段**，这样页面中已隐藏的 Webhook 密钥不会覆盖真实值。如果修改了已隐藏的字段，面板会拒绝保存并说明原因。脚本自身的配置校验错误也会直接显示在页面中。

**诊断**：查看脚本捕获的错误信息、截图和 HTML 转储文件，这些内容通过面板转发显示。

页面顶部始终显示运行控制栏，包含**开始运行**、**停止**和**重启**；⋮ 菜单中还有**强制停止**和**关闭控制 API**。日志中出现登录确认码后，页面顶部会立即显示确认码及倒计时。

---

## 工作原理

**共享 SSE 连接**：服务器只维护一条到控制 API 的事件流，再通过 `lib/eventHub.js` 广播到所有打开的浏览器页面，支持使用 `Last-Event-ID` 恢复事件和退避重连。即使同时打开十个页面，到脚本的连接仍只有一条。

**实时日志与持久化数据**：日志会实时发送到浏览器，同时经解析后写入 SQLite（`lib/store.js`）。API 只保留 2,000 行内存日志缓冲，进程退出后会丢失；面板保存的积分历史、运行记录、活动和定时任务在面板或脚本重启后仍然存在。

**实时积分**：脚本在获得积分时会输出当前余额和每次增量，API 将这些日志合并为实时统计（`GET /points`）。因此，概览页可在运行过程中显示积分增长。账号运行结束后，实时统计会替换为 `ACCOUNT-END` 输出的最终数据。

**独立身份验证**：`CONTROL_API_TOKEN` 只由面板作为 Bearer 令牌发送给控制 API，必须与 API 的 `API_TOKEN` 一致。浏览器访问面板则使用可选的 `DASHBOARD_USERNAME` 和 `DASHBOARD_PASSWORD`。

**无第三方运行依赖**：图表由内嵌 SVG 绘制（`public/charts.js`），从 CSS 变量读取颜色，因此可随主题变化并离线使用。保留了原面板的 14 种主题。

---

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CONTROL_API_URL` | `http://microsoft-rewards-script:3010` | 控制 API 的访问地址。 |
| `CONTROL_API_TOKEN` | - | 发送给控制 API 的 Bearer 令牌，必须与 API 的 `API_TOKEN` 一致。 |
| `DASHBOARD_USERNAME` | - | 可选的 HTTP Basic 登录用户名；用户名和密码都设置后才启用验证。 |
| `DASHBOARD_PASSWORD` | - | 可选的 HTTP Basic 登录密码；任意一项登录凭据留空都会关闭浏览器登录验证。 |
| `PORT` | `8890` | 面板监听端口。 |
| `TZ` | `UTC` | 用于按日统计积分和计算定时任务的时区，请按实际需要设置。 |
| `DASHBOARD_TITLE` | `Microsoft Rewards` | 页面顶部标题。 |
| `POLL_MS` | `5000` | 状态轮询间隔，单位为毫秒；日志通过事件流传输。 |
| `LOG_REPLAY` | `300` | 事件流连接建立时回放的日志行数。 |
| `DATA_DIR` | `./data` | `dashboard.sqlite` 所在目录，积分历史、运行记录、活动和定时任务均写入此目录。Docker 中为 `/data`。 |

---

## 故障排查

**无法连接控制 API（Control API unreachable）**：面板无法建立 TCP 连接，请检查 `CONTROL_API_URL`。在 Docker 中，`localhost` 指的是面板自身的容器；请使用 API 的服务名，或使用 `host.docker.internal` 并配置 `extra_hosts`。

**控制 API 拒绝令牌（Control API rejected our token）**：`CONTROL_API_TOKEN` 与 `API_TOKEN` 不一致。

**浏览器未显示登录提示**：`DASHBOARD_USERNAME` 和 `DASHBOARD_PASSWORD` 必须都非空；任意一项为空都会关闭浏览器登录验证。

**保存配置返回 403**：控制 API 启动时未设置 `API_ALLOW_CONFIG_WRITE=true`。

**每日积分条在错误的时间切换日期**：检查是否正确设置了 `TZ`。

**定时任务未运行**：检查定时任务页的错过任务处理策略、排除账号和“最近结果”。

## 支持原作者

如果这个项目对你有帮助，欢迎通过原作者提供的以下渠道支持后续开发。感谢你的支持：

[![通过 PayPal 捐赠](https://img.shields.io/badge/PayPal-00457C?logo=paypal&logoColor=white)](https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=R4QX73RWYB3ZA)
[![Liberapay](https://img.shields.io/badge/Liberapay-F6C915?logo=liberapay&logoColor=black)](https://liberapay.com/cammarata.m/)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-FF5E5B?logo=ko-fi&logoColor=white)](https://www.ko-fi.com/mgrimace)
[![Buy Me A Coffee](https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?logo=buymeacoffee&logoColor=black)](https://www.buymeacoffee.com/cammaratam)
