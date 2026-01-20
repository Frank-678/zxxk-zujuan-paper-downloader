# `zxxk-zujuan-paper-downloader`
> 一个基于 **Tampermonkey (篡改猴)** 的用户脚本，专为优化“学科网组卷网”试卷的下载与打印体验而设计。

### 项目简介
本项目通过重构网页 `DOM` 结构，解决组卷网页面直接打印时出现的空白页、布局错乱等问题。它能自动剔除页面中的干扰元素（如广告、知识点标签、组卷信息等），生成纯净的试卷预览并调用系统打印功能。

### 主要功能
* **强力打印排版**：采用页面重构技术，彻底解决因 `CSS` 限制导致的打印预览空白问题。
* **纯净版面优化**：自动隐藏“知识点”、“题目来源”、“组卷次数”及各类广告导航。
* **自动恢复**：打印完成后自动刷新页面，不影响网页原始功能的后续操作。

### 安装方法
1. 首先在浏览器中安装 **Tampermonkey** 插件。
2. 点击本项目中的 `学科网下载打印试卷.js` 查看源码。
3. 复制全文，在 **Tampermonkey** 控制面板中点击“添加新脚本”，粘贴并保存。
4. 访问 **学科网组卷网** 的试卷详情页，点击右上角工具栏新出现的 **“纯净打印”** 按钮即可。
<img width="938" height="373" alt="image" src="https://github.com/user-attachments/assets/97f83b58-7b99-4251-afcf-52f98b2bb2b8" />
<img width="214" height="298" alt="image" src="https://github.com/user-attachments/assets/d9dd0e68-db7c-49de-997a-fc08a82837eb" />

### 技术原理
脚本执行时会执行以下严谨逻辑：
* **定向提取**：锁定 `.exam-cnt` 核心容器。
* **深度清理**：删除所有匹配 `junkSelectors` 的干扰节点。
* **上下文隔离**：通过清空 `document.body.innerHTML` 消除全局 `CSS` 布局（如 `overflow: hidden`）对打印机的干扰。
* **注入优化**：向重构后的页面注入专用的 `@media print` 样式，强制纯黑字体输出以提升纸质版清晰度。

### 开源协议
本项目采用 `GNU Affero General Public License v3.0` 协议。
