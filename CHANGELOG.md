# Changelog

## v3.1.0 — v2.2 主线维护版

### Fixed

- 修复没有“显示全部答案和解析”全局开关时，答案导出误报“未抓到答案内容”的问题。
- 逐题按 `.exam-item__cnt`、`.wrapper.quesdiv`、题目节点的优先级触发加载，并等待 AJAX DOM 变化。
- 在导出前恢复答案图片的 `data-src`、`data-original`、`data-lazy-src`。
- 单文件答案 HTML 现在也能正确重写相对路径图片为 Data URI。

### Added

- 任务进度、取消、请求超时、任务级资源缓存与失败诊断。
- 本地“页面兼容性检查”和可下载的诊断 JSON。
- 无外部依赖的静态回归检查及逐题懒加载测试夹具。

### Compatibility

- 保留 v2.2 的面板风格、按钮、题目 HTML/ZIP、答案 HTML/ZIP、内置 ZIP 写入器、QID 去重、资源嵌入和跨域图片回退。
- 不引入 3.0 alpha 的黑金界面、任务中心或设置范式。

### Credits

- Reported-by: FloVed
- Suggested-by: FloVed
