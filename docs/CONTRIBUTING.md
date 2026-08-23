# 收录指南（Contributing）

通过 PR 将你的 Android 应用收录进本商店。整个过程只需要提交一个 JSON 文件。

## 前提

你的应用仓库必须满足（由工作流 2 自动核验，任一不满足即拒绝）：

1. 仓库公开可访问，未被归档
2. 最新 Release 存在，且资产中包含 APK 文件
3. 仓库存在 README 且可拉取
4. 若声明开源：存在有效 LICENSE、源码真实非占位

## app.json 字段

```json
{
  "repo": "yourname/your-repo",
  "openSource": true,
  "specialPermissions": ["adb"],
  "summary": "一句话简介，让人一看就明白应用是做什么的",
  "upstream": 1001
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| repo | 是 | 你的 GitHub 仓库全名 owner/repo，必须与所在目录 apps/<owner>/<repo>/ 一致 |
| openSource | 是 | 是否开源（将独立核验真开源） |
| specialPermissions | 否 | 最低特殊权限，取值 none / adb / root，可多选，缺省 none；Shizuku 依赖 ADB 通道归入 adb |
| summary | 是 | 一句话简介（列表页展示用） |
| upstream | 否 | 当本应用是某个已收录开源项目的分支/Fork 时，填上游应用的系统 ID（应用详情页可见） |

注意：不要填写 id——应用系统 ID 由工作流 2 在合并时自动分配，用户无法编辑。

## 目录结构

```
apps/<你的仓库Owner>/<仓库名>/
└── app.json
```

## 流程

1. Fork 本仓库，新建上述目录与 app.json
2. 提交 PR。工作流 1 自动校验：只允许动 app.json、目录必须与 repo 字段一致、upstream 必须指向已存在的系统 ID、已有应用只有初始上传者或其仓库 Owner 可改
3. 校验通过后工作流 2 核验并采集元数据；合并时自动生成 app-info.json 与 README.md 落盘，并分配应用系统 ID
4. 后续发布新版本不需要重新提 PR：工作流 5 会定期扫描你的 Release，发现新版本自动更新商店元数据

## 更新已有应用

直接修改你的 app.json（例如调整简介）后重提 PR 即可；修改权限与首次收录相同（只能改自己的条目）。