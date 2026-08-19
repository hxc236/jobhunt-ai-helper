## Agent skills

### 卡片实现工作流（强制规则）

任何改动需求（bug、性能、功能、调研建议落地）→ 先在 GitHub 创建 Issue（含需求背景、验收标准、关联规格）；
标 ready-for-agent 后按 implement 工作流执行

当 agent 选择一张卡片（GitHub issue，含 ready-for-agent 等标签的 ticket）来实现时，必须遵守以下规则：

- 必须使用 git worktree 隔离开发：不得在默认分支（main）上直接修改代码。先 `git worktree add` 一个隔离工作目录（例如 `.agents/worktrees/<card-id>`，并创建对应分支）再动手。
- 只有测通的才允许合入：该卡片的实现必须在隔离 worktree 中跑通相关测试且无回归后，才允许合入到 main。未通过测试的变更禁止合并。
- 合入方式：在 worktree 分支上完成实现与验证 → 切回 main 执行合并（fast-forward 或 merge）→ 合入后清理该 worktree。
- 上述规则同样适用于多 agent / 并行实现多张卡片的情形：每张卡片各占一个 worktree，互不干扰，各自测通后再合入。

### Issue tracker

Issues and specs for this repo live as GitHub issues, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles map to the default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.
