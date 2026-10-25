# 公开 Demo 部署准备

## 结论

建议首个公开体验版使用 **Render Python Web Service 免费实例**。应用是 Flask 服务端网页，需要常驻 WSGI 进程、SQLite 写入和文件暂存；Render 可直接运行 Flask/Gunicorn 并支持 `/health` 健康检查。Vercel 的 Python 运行方式是函数式，运行文件系统只允许写入临时目录，和当前多路由、会话 SQLite 工作流不匹配，迁移和持久化改造更多。

当前配置将 Render 服务固定为 `free`，不添加磁盘或数据库资源。该方案适合公开体验，不保存访客数据：访客浏览器各自使用独立的临时演示库；服务重启后会重新载入虚构样本，之前的体验修改会清除。

平台限制以部署时官方说明为准：Render 免费服务空闲 15 分钟后会休眠；下次访问会冷启动。免费服务文件系统是临时的，且不支持持久磁盘。Vercel Python Functions 的文件系统只读，仅 `/tmp` 可写。[Render 免费实例说明](https://render.com/docs/free) · [Render 磁盘说明](https://render.com/docs/disks) · [Vercel Python Runtime](https://vercel.com/docs/functions/runtimes/python)

## 项目检查结果

| 项目 | 当前情况 | 部署处理 |
|---|---|---|
| 技术栈 | Python 3.13.14、Flask 3.1.3、Jinja 页面、openpyxl 3.1.5 | 原生 Python Web Service，无需 Node 或前端构建 |
| 前后端 | Flask 同一进程提供页面、表单和下载 | Gunicorn 启动 `app:app` |
| 数据库 | SQLite，原来默认写入项目 `data/` | Demo 模式为每个浏览器会话创建独立 SQLite，放在 `/tmp` |
| 上传 | XLSX/CSV/TSV 暂存在本地目录；确认后保存标准化数据并删除原文件 | 临时文件放入每个会话目录；Demo 限制为 5 MB、5000 行 |
| 导出 | openpyxl 生成 Excel 到 `BytesIO`，通过 HTTP 直接下载 | 不写导出文件到磁盘 |
| 运行方式 | `run.py` 默认只监听 `127.0.0.1:8765` | 支持 `PORT`/`0.0.0.0`；云端使用 Gunicorn |
| 健康检查 | 已有 `/health` | Render Blueprint 配置为 `/health` |
| 环境密钥 | 旧默认值是固定的开发密钥 | 已移除固定密钥；公开 Demo 缺少 `SELLER_MVP_SECRET` 时拒绝启动；Render Blueprint 自动生成随机值 |
| Git | 当前项目目录还没有 `.git` 仓库或远程地址 | 需要先按下方步骤建仓库；尚未推送任何代码 |

应用没有支付 API、平台 API Key、用户密码或其他第三方服务凭据。`.gitignore` 已排除 `.env`、SQLite/WAL 文件、暂存目录、备份、虚拟环境和现有 ZIP 压缩包；虚构的 `data/demo_reports/*.csv` 与说明文件保留在代码库中。不要提交当前本机数据库或 `seller-profit-assistant-source.zip`，压缩包可能带有本地数据库快照。

## 公开 Demo 的数据边界

| 数据 | 存放方式 | 清理方式 |
|---|---|---|
| 六份虚构样本 CSV | 仓库中的 `data/demo_reports/` | 随程序版本发布，不含买家或真实商家数据 |
| 访客上传的原始文件 | `/tmp/seller-profit-assistant-demo/<会话ID>/staging/` | 确认/取消后删除；过期会话清理；服务重启时临时文件系统清空 |
| 导入后的店铺、订单、成本等 | 同一会话目录内独立的 `seller_profit.sqlite3` | 会话 6 小时无活动后可清理；服务重启后全部重建为虚构样本 |
| Excel 报告 | 内存中的 `BytesIO` | 只发送给当前下载请求，不在服务器落盘 |

公开页面会明确提示这是临时 Demo，不要上传真实店铺订单、买家个人信息或其他敏感文件。每个演示空间由 Flask 签名 Cookie 标识，空间互相隔离；最多 50 个活跃空间，达到上限时新体验请求会暂时返回 503。会话隔离是匿名体验边界，不等同于账号认证或生产级租户安全。免费实例没有数据库备份；服务重启、重新部署或休眠恢复后，Demo 修改可能消失，这是预期行为。请不要把它用于保存真实经营数据。

当前没有 IP 级限流、验证码或强身份验证；会话上限和文件大小限制只能减少一般性误用，不能抵御有意的流量攻击。若准备大范围公开宣传，建议先增加边缘限流/WAF，再部署。

如将来需要保留商家数据，需要另行确认预算，并把 SQLite 改造为托管 PostgreSQL、建立用户登录和租户级数据隔离、设计备份与恢复，再决定上传文件是否需要对象存储。Render 持久磁盘仅挂载到单个服务实例且不支持横向扩容；不建议用单机 SQLite 磁盘方案承载正式客户数据。[Render 磁盘限制](https://render.com/docs/disks)

## 环境变量

`render.yaml` 已准备免费服务配置。Render Blueprint 会生成 `SELLER_MVP_SECRET`，其他公开 Demo 参数如下：

| 变量 | 示例值 | 用途 |
|---|---|---|
| `PYTHON_VERSION` | `3.13.14` | 固定 Python 版本，与本机验证环境一致 |
| `SELLER_MVP_DEMO_MODE` | `true` | 开启按会话隔离的公开体验模式 |
| `SELLER_MVP_SECRET` | Render 自动生成 | Flask Cookie 签名；不得写入代码或 GitHub |
| `SELLER_MVP_DEMO_DATA_DIR` | `/tmp/seller-profit-assistant-demo` | 临时演示空间根目录 |
| `SELLER_MVP_DEMO_SESSION_TTL_HOURS` | `6` | 会话无活动后的数据回收期限 |
| `SELLER_MVP_DEMO_MAX_SESSIONS` | `50` | 同时保留的演示空间上限 |
| `SELLER_MVP_COOKIE_SECURE` | `true` | 只通过 HTTPS 发送 Cookie |
| `SELLER_MVP_MAX_UPLOAD_MB` | `5` | 公开 Demo 的文件大小上限 |
| `SELLER_MVP_MAX_ROWS` | `5000` | 公开 Demo 的单表行数上限 |
| `PORT` | Render 自动提供 | Gunicorn 监听端口，不要手动写死 |

`.env.example` 是变量名参考，不会被 Flask 自动加载。公开部署的真实密钥只放在 Render 的环境变量管理中；不要复制回 `.env.example`。

## 本地模拟公开 Demo

PowerShell 示例。密钥只在当前终端环境生成，不写入项目文件：

```powershell
$env:SELLER_MVP_DEMO_MODE = 'true'
$env:SELLER_MVP_SECRET = (& .\.venv\Scripts\python.exe -c 'import secrets; print(secrets.token_urlsafe(48))')
$env:SELLER_MVP_DEMO_DATA_DIR = "$env:TEMP\seller-profit-assistant-demo"
$env:SELLER_MVP_DEMO_SESSION_TTL_HOURS = '6'
$env:SELLER_MVP_DEMO_MAX_SESSIONS = '50'
$env:SELLER_MVP_COOKIE_SECURE = 'false'
$env:SELLER_MVP_MAX_UPLOAD_MB = '5'
$env:SELLER_MVP_MAX_ROWS = '5000'
.\.venv\Scripts\python.exe run.py
```

打开 `http://127.0.0.1:8765`。停止后清除演示环境变量，回到原来的本机数据库模式：

```powershell
'SELLER_MVP_DEMO_MODE','SELLER_MVP_SECRET','SELLER_MVP_DEMO_DATA_DIR','SELLER_MVP_DEMO_SESSION_TTL_HOURS','SELLER_MVP_DEMO_MAX_SESSIONS','SELLER_MVP_COOKIE_SECURE','SELLER_MVP_MAX_UPLOAD_MB','SELLER_MVP_MAX_ROWS' | ForEach-Object { Remove-Item "Env:$($_)" -ErrorAction SilentlyContinue }
```

## GitHub 到 Render 的操作步骤

以下步骤仅供你确认部署后执行；本次准备没有初始化 Git、创建 GitHub 仓库、推送代码或创建 Render 服务。

1. 在 GitHub 新建一个仓库。建议仓库保持 **Private**；网站仍可通过 Render 的公开网址访问，代码不必公开。
2. 打开 PowerShell，进入项目目录：

   ```powershell
   cd C:\Users\90996\Documents\Codex\2026-10-18\files-pasted-by-the-user-codex\seller-profit-assistant
   git init
   git branch -M main
   git add -A
   git status --short
   ```

3. 在提交前检查暂存清单。确认 `.venv`、`.env`、`data/seller_profit.sqlite3`、`data/backups`、`data/staging` 和 `seller-profit-assistant-source.zip` 都没有被加入。若看到它们，先停止提交并检查 `.gitignore` 与 Git 暂存区。
4. 首次提交并关联你刚创建的 GitHub 仓库：

   ```powershell
   git commit -m "Prepare seller profit assistant demo"
   git remote add origin https://github.com/你的账号/你的仓库.git
   git push -u origin main
   ```

5. 登录 Render，选择 **New → Blueprint**，连接刚才的 GitHub 仓库并选择 `main` 分支。Render 会读取仓库根目录的 `render.yaml`。
6. 创建前核对服务计划为 `Free`，并检查账单/用量页面。不要添加付费实例、持久磁盘、自定义域名或数据库；免费方案有休眠、临时文件系统和额度限制。
7. 只有在你确认要创建公开服务后，才点击 Render 的应用/创建按钮。Render 会构建并部署；构建命令为 `pip install -r requirements.txt`，启动命令为 Gunicorn，健康检查路径为 `/health`。
8. 部署成功后打开 Render 显示的 `onrender.com` 地址，访问 `/health` 应返回 `{"status":"ok","mode":"public-demo"}`。
9. 在公开网页中先使用自带虚构店铺和报表体验总览；再新建一间“其他/演示”测试店，下载虚构 CSV，上传、核对字段并确认导入，查看数字变化，最后下载 Excel。不要拿真实店铺文件做公网测试。
10. 休眠后首次访问可能较慢；免费服务重启或重新部署会重置访客演示空间。更新代码时再次推送到 GitHub；部署前先确认免费计划和用量仍符合预期。

## 演示核算标准

首次自动载入的虚构数据覆盖 2026-10-01 至 2026-10-31，人工核算答案在 `data/demo_reports/说明.md`：

| 指标 | 标准值 |
|---|---:|
| 有效商品销售额 | ¥887.36 |
| 已确认退款 | ¥128.00 |
| 净销售额 | ¥759.36 |
| 已匹配成本 | ¥300.00 |
| 平台费用 | ¥36.12 |
| 其他经营费用 | ¥19.50 |
| 已知项目利润估算 | ¥403.74（SKU-C 缺成本，不是完整利润）|
| 订单级简化结算差异 | O-1007 少 ¥3.00 |

演示文件均为虚构通用样本，包含取消订单、部分退款、跨月退款、重复订单、缺失成本、待处理退款、费用和结算差异；不代表任何平台官方导出格式。

## 部署前清单

### 已准备

- [x] 添加 Render 免费 Web Service Blueprint、Gunicorn 启动命令和 `/health` 健康检查。
- [x] 启动端口支持 Render `PORT`，本机运行仍默认监听 `127.0.0.1:8765`。
- [x] 公开 Demo 使用会话独立 SQLite/暂存目录；默认固定密钥已移除。
- [x] 配置 HTTPS Cookie、六小时会话期限、50 会话上限、5 MB 和 5000 行导入限制。
- [x] 上传原文件确认/取消后清理；导出 Excel 在内存生成。
- [x] 六份模拟报表和人工核算答案已随项目提供。
- [x] `.gitignore` 排除数据库、备份、上传、虚拟环境、环境变量和本地 ZIP。
- [x] 自动化测试 14 项通过；公开 Demo 会话隔离、上传、计算、页面显示和 Excel 导出均由端到端测试覆盖。
- [x] 本地公开模式预检：`/health`、经营总览、5 MB 上传提示和 XLSX 下载均返回成功；看板显示人工标准销售额 ¥887.36。

### 等待用户确认或后续处理

- [ ] Git 初始化、GitHub 仓库创建与首次推送。
- [ ] 在 Render 创建公开服务、取得公网网址并验证公网访问。
- [ ] 检查 Render 账户的用量/计费设置；本准备过程未创建资源，也未核实你的账户额度。
- [ ] 若公开推广，评估并添加边缘 IP 限流/WAF；当前会话上限不是完整防攻击措施。
- [ ] 真实平台模板仍需各平台脱敏报表样本，当前没有验证。

