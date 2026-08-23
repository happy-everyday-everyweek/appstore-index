# AppStore Index · 承载仓库

GitHub 驱动的开源应用市场——唯一的应用分发索引源头。

本仓库按 `apps/<owner>/<repo>/` 两级目录收录 Android 开源（及优质闭源）应用，每个应用独占一个文件夹，内含三个文件：

| 文件 | 类型 | 说明 |
|---|---|---|
| app.json | 用户文件（PR 提交） | 开发者手写：仓库地址、是否开源、最低特殊权限、一句话简介、可选 upstream |
| app-info.json | 自动生成 | 完整采集元数据：应用系统 ID、包名、名称、图标、权限、版本、来源、评级等 |
| README.md | 自动生成 | 从开发者仓库拉取的原 README |

## 收录流程

1. Fork 本仓库
2. 新建 `apps/<你的仓库Owner>/<仓库名>/app.json`（参见 [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) 与 [schema](docs/app.json.schema.json)）
3. 提交 PR，工作流 1 自动校验文件范围、目录结构、upstream 引用与修改权限
4. 工作流 2 核验真开源 / Release / README，采集元数据并分配应用系统 ID，合并时落盘 app-info.json 与 README.md

## 分发

工作流 4 每日 5 次定时检查变更，以 Release 三件套分发聚合包（全量包 + 增量包 + patch.json）；工作流 5 定期扫描收录应用的新版本并自动更新元数据。APK 二进制始终留在开发者自己的 Release 中，本仓库不存放任何 APK。

## 收录状态

当前为空：未有任何收录应用。首个合集将通过标准 PR 流程收录。

## 相关仓库

- 客户端：happy-everyday-everyweek/appstore
- 推荐页内容：happy-everyday-everyweek/appstore-discover