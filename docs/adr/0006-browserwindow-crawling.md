# 爬虫用隐藏 BrowserWindow 而非 Playwright

试点采集器（牛客校招日程 + 猎聘校招）用 Electron 隐藏 BrowserWindow 加载源 URL + `executeJavaScript` 提取 DOM——复用内置 Chromium，零额外依赖、零打包体积，分页 XHR 自然执行。

**考虑过的方案**：Playwright——功能强但打包 +150MB，MVP 手动低频采集不值。反爬升级（指纹/滑块）时二期换 Playwright 或 Computer Use 通道（ADR 见 ticket #11 结论）。采集手动触发 + 预览确认入库。关联 ticket #12、#4。
