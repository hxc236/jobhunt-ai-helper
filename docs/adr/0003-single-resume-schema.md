# 单一简历 schema 覆盖基准简历与优化稿

基准简历与按 JD 优化的派生稿共用一份 JSON schema（`resume.schema.json`），派生关系记在 `meta.baseResumeId` / `meta.targetJobId`，而不是两套模型。

字段含国企向信息（政治面貌、生源地、排名）；`projects` / `experience` 携带 `techStack`——匹配度计算的数据基础。优化稿必须通过 schema 校验且人工确认后才入库（防幻觉）。原型验证于 `prototype/resume-model` 分支（throwaway）。关联 ticket #7。
