# SQLite 单文件存储与五表模型

better-sqlite3 主进程直连、单文件本地库（本机单用户，无服务器）。表：`positions`（职位卡）、`applications`（投递记录）、`topics`（学习条目）、`interviews`（面试记录）、`crawl_runs`（采集留痕）。

去重：`source_url` 部分唯一索引优先（爬虫），`dedupe_key`（company|title|recruit_season）兜底（手动录入）。投递状态机 `planned → applied → interviewing → offer/rejected`，`withdrawn` 任意态可入；状态变更时间戳是复盘数据来源。采集 upsert 不自动关闭消失岗位。关联 ticket #5、#8、#10、#12。
