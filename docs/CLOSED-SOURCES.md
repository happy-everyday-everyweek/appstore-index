# 闭源应用采集管道（WF8）

本管道为承载仓库持续搜集闭源 Android 应用，收录产物流入与人工提交流程完全一致的标准索引（app.json → WF1 校验 → WF2 核验 → merge-settle 落盘 → WF4 聚合分发），客户端无需任何改造。

## 工作原理

每个闭源应用在机器人账号下自动创建一个镜像仓库（`mirror-<包名>`），把 APK 上传到该仓库的 Releases（tag 用版本号），应用简介写成仓库 README，图标写入 icon.png。承载仓库里的 app.json 的 `repo` 字段指向这个镜像仓库，因此 WF2 核验（Release 含 APK、README 可拉取）与 WF4 聚合下载天然复用。

- 镜像仓库归属：机器人账号 `happy-happy-all-the-day`（secrets: `MIRROR_OWNER` / `MIRROR_TOKEN`），绝不进入主账号
- 收录一律走 PR（workflow 自动创建），不直接提交 main
- 已收录 / 已处理应用通过 `closed-sources/state.json` 幂等去重，不重复建库、不重复开 PR

## 采集源（当前）

APKVision（https://apkvision.org/）：纯 HTTP 抓取 + 正则解析（`closed-sources/scraper_apkvision.py`），不依赖无头浏览器，规避反爬挑战。实现四类目录全量巡扫：应用 / 游戏 / 最近更新 / 最佳新作，分页推进直到翻完。单字母搜索方案不可用（源脚本强制搜索词 ≥ 2 字符），分类目录翻页可以达到同样"扫全库"效果且更彻底。

## 关键文件

| 路径 | 作用 |
| --- | --- |
| `closed-sources/collect_closed.py` | 采集主控：巡扫游标、详情、下载、建镜像仓、上传 Release、批量 PR、状态回写 |
| `closed-sources/scraper_apkvision.py` | APKVision HTTP 采集引擎（列表分页 / 详情 / 下载直链解析 / APK 下载） |
| `closed-sources/sources/` | ApkMesh 源脚本备份（MIT，vendored，预留后续源扩展） |
| `closed-sources/debugger/` | ApkMesh 官方 Python 调试器（MIT，QuickJS 沙盒执行源脚本，备用引擎） |
| `closed-sources/state.json` | 扫描状态：每个目录页游标 + 已处理应用 id + 失败记录 |
| `.github/workflows/wf8-collect-closed.yml` | 定时（每日 03:23 UTC）+ 手动触发（支持干跑/限量/指定目录） |

## 运行方式

- 定时：每日一轮，每轮默认上限 10 个新应用
- 手动：仓库 Actions → WF8 → Run workflow，可设 `dry_run=true` 只看候选、调 `limit`、指定 `tab` 起始页
- 干跑只巡扫 + 拉详情并打印候选，不下载 APK、不建仓库、不开 PR

## Secrets

- `MIRROR_TOKEN`：机器人账号 PAT（建仓库 + 上传 Release 权限）
- `MIRROR_OWNER`：机器人账号 login（`happy-happy-all-the-day`）

## 安全与运维

- 下载仅允许源站白名单域名（apkvision.org / dl.apkvision.org）
- 单个 APK 大小上限默认 200MB，超出自动跳过并记录
- 失败项记录在 state.json 的 failed 段（上限 500 条），避免同一应用反复重试
- 源脚本升级：替换 `closed-sources/sources/` 后走 PR 即可