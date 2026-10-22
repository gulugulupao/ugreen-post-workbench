# 绿联社区发帖工作台（UGREEN Post Workbench）

给绿联 NAS 社区写帖子的**本地辅助工具**：帮你把图文混排的帖子写得舒服，再稳稳当当地发到社区。
纯本地运行 —— 不联网收集数据，帖子内容、图片、登录凭证全部存在你自己电脑上。

- 下载：[Releases 页面](https://github.com/gulugulupao/ugreen-post-workbench/releases/latest)（Windows 安装包 / 便携 zip）
- 许可：MIT（作者署名保留，禁止冒名与商用冒用，见 `ATTRIBUTION.txt`）

## 它解决什么问题

官方编辑器写长帖时最常见的几件事：插图要一张张传、插错位置只能清空重来、
写一半切窗口内容没了、发不出去只给一句看不懂的报错、同样的开头结尾每次都要重打一遍。
这个工具把这些机械劳动全自动化，让你把时间留给内容本身。

## 主要功能

| 能力 | 说明 |
| --- | --- |
| 写与排版 | 加粗/标题/列表/引用/代码块，另有字号、首行缩进、清除格式 |
| 插图 | 截图 Ctrl+V 直接粘贴，或拖入图片文件；插错可上移/下移/删除，支持拖拽排序 |
| 片段库 | 常用段落一键插入；「高频统计」扫描本机文本找出你写得最多的句子（可关闭） |
| 发布记录 | 发过的帖子自动存档，可载入再发一次；带 ✅已发布 / ⏳待审核 / ❌未过审 状态与手动检测 |
| 导入导出 | Markdown（连配图）与 HTML（图片内嵌单文件）双向 |
| 排错 | 体检检查官方发帖页的 10 个结构锚点；发布前检查清单；失败可复制全文手动发；一键诊断包 |
| 多账号 | 账号柜切换身份，自动按该账号重扫各版块权限 |

## 安装

1. 到 [Releases](https://github.com/gulugulupao/ugreen-post-workbench/releases/latest) 下载 `绿联发帖工作台_安装版_V*.exe`
2. 双击安装（Windows 可能提示"未知发布者"，点「更多信息 → 仍要运行」—— 个人开发者未做代码签名）
3. 启动后按提示登录绿联社区账号

便携版 zip 仅作应急备份，日常用安装版。

## 开发

```bash
node webpost/server.js          # 本地跑起来，浏览器打开 http://127.0.0.1:8791
node build/build_exe.js         # 打安装包（Inno Setup 6，需 build/tools/innosetup）
node build/build_zip.js         # 打便携 zip
```

版本号唯一源头：`webpost/package.json`。

发布链路依赖绿联社区的 Discuz! X5.1 发帖页 DOM，全部选择器集中在
`webpost/lib/forum_adapter.js`（每个锚点多套候选写法），论坛改版时只改这一个文件。

## 隐私

不联网上传、不云同步、不收集使用数据。只有登录与发帖时才访问绿联社区，
用的还是你自己的浏览器和登录态。诊断包三无：无账号密码、无昵称、无本机路径。

## 反馈

微信搜一搜「很多问题的小明同学」，或在仓库开 Issue。

---

Copyright (c) 2026 很多问题的小明同学（GitHub @gulugulupao）· MIT License
