import type { Resume } from '../../shared/types/resume'

/**
 * 简历 A4 渲染（F-15/#30）：prototype/resume-model 模板的 TS 移植（纯函数，无 IO）。
 * 输出完整 HTML 文档（含 A4 打印样式 @media print），渲染层 iframe srcdoc 预览、
 * 主进程 printToPDF 导出共用。用户字段一律 HTML 转义（防注入/样式破坏）。
 */

export function renderResumeHtml(resume: Resume, photoDataUri?: string): string {
  const body = renderSheet(resume, photoDataUri)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${esc(resume.meta?.title ?? '简历')} — 求职助手</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; background: #e8e8e8; padding: 20px; }
  .sheet { width: 794px; min-height: 1123px; background: #fff; margin: 0 auto; padding: 48px 52px;
    box-shadow: 0 2px 8px rgba(0,0,0,.12); font-size: 14px; line-height: 1.65; color: #222; }
  .sheet h1 { font-size: 24px; letter-spacing: 4px; }
  .sheet .head { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
  .sheet .facts { margin-top: 10px; max-width: 580px; }
  .sheet .fact { display: inline-block; margin: 2px 16px 2px 0; font-size: 13px; }
  .sheet .fact .k { color: #888; margin-right: 4px; }
  .sheet .photo { width: 76px; height: 100px; flex-shrink: 0; border: 1px solid #d8d8d8; background: #f5f5f5; }
  .sheet .photo img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .sheet .links a { color: #2b5ca8; text-decoration: none; margin-right: 12px; font-size: 13px; }
  .sheet .intent { margin-top: 14px; padding: 6px 12px; background: #f4f7fc; border-left: 3px solid #2b5ca8; font-size: 13px; color: #333; }
  .sheet h2 { font-size: 15px; margin: 20px 0 8px; padding-bottom: 5px; border-bottom: 2px solid #2b5ca8; color: #2b5ca8; }
  .sheet .entry { margin-bottom: 12px; }
  .sheet .entry-head { display: flex; justify-content: space-between; font-weight: 600; }
  .sheet .entry-head em { font-style: normal; font-weight: 400; color: #555; }
  .sheet .entry-sub { display: flex; justify-content: space-between; color: #555; font-size: 13px; margin-top: 2px; }
  .sheet .inline { margin-top: 3px; font-size: 13px; }
  .sheet .inline .dot { margin: 0 8px 0 2px; color: #bbb; }
  .sheet .desc { color: #444; margin-top: 4px; }
  .sheet .tags { margin-top: 4px; }
  .sheet .tag { display: inline-block; background: #eef3fb; color: #2b5ca8; border-radius: 3px; font-size: 12px; padding: 1px 8px; margin-right: 6px; }
  .sheet .skill-p { margin-bottom: 6px; }
  .sheet .skill-p .skills-cat { font-weight: 600; }
  @media print {
    body { background: #fff; padding: 0; }
    .sheet { box-shadow: none; width: auto; min-height: 0; }
  }
</style>
</head>
<body>
${body}
</body>
</html>`
}

/** A4 纸张内容（分节渲染；空节省略）。photoDataUri：照片 data URI（服务层注入，缺省不显示照片位）。 */
export function renderSheet(resume: Resume, photoDataUri?: string): string {
  const b = resume.basics ?? {}
  const intent = b.jobIntention ?? {}
  const parts: string[] = ['<div class="sheet">']

  const photoTag =
    photoDataUri !== undefined
      ? `<div class="photo"><img src="${esc(photoDataUri)}" alt="照片" /></div>`
      : ''
  const facts = [
    ['性别', b.gender],
    ['生日', b.birthday],
    ['政治面貌', b.politicalStatus],
    ['生源地', b.hometown],
    ['现居城市', b.location],
    ['电话', b.phone],
    ['邮箱', b.email]
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
  parts.push(`<div class="head"><div><h1>${esc(b.name)}</h1>`)
  if (facts.length > 0) {
    parts.push(`<div class="facts">${facts.map(([k, v]) => `<span class="fact"><span class="k">${esc(k)}</span>${esc(v)}</span>`).join('')}</div>`)
  }
  if ((b.links ?? []).length > 0) {
    parts.push(
      `<div class="links">${(b.links ?? [])
        .filter((l) => l.url !== undefined && l.url !== '')
        .map((l) => `<a href="${esc(l.url ?? '')}">${esc(l.label ?? l.url ?? '')}</a>`)
        .join('')}</div>`
    )
  }
  parts.push('</div>')
  parts.push(photoTag)
  parts.push('</div>')
  if (intent.position !== undefined || (intent.city ?? []).length > 0) {
    const cityText = (intent.city ?? []).join(' / ')
    parts.push(
      `<div class="intent">求职意向：${esc(intent.position ?? '—')}${cityText !== '' ? `　·　期望城市：${esc(cityText)}` : ''}${intent.salary !== undefined && intent.salary !== '' ? `　·　${esc(intent.salary)}` : ''}</div>`
    )
  }

  if ((resume.education ?? []).length > 0) {
    parts.push('<h2>教育背景</h2>')
    for (const e of resume.education ?? []) {
      parts.push(
        `<div class="entry"><div class="entry-head"><span>${esc(e.school)}　${esc(e.degree)} · ${esc(e.major)}</span><span>${esc(dateRange(e.startDate, e.endDate))}</span></div>`
      )
      const bits = [e.gpa !== undefined && e.gpa !== '' ? `GPA ${e.gpa}` : null, e.rank !== undefined && e.rank !== '' ? `排名 ${e.rank}` : null].filter((v): v is string => v !== null)
      if (bits.length > 0) parts.push(`<div class="entry-sub"><span>${esc(bits.join('　·　'))}</span></div>`)
      if ((e.courses ?? []).length > 0) parts.push(`<div class="inline">相关课程：${(e.courses ?? []).map((c) => `<span class="tag">${esc(c)}</span>`).join('')}</div>`)
      if ((e.honors ?? []).length > 0) {
        parts.push(`<div class="inline">荣誉：${(e.honors ?? []).map((h, i) => `${esc(h)}${i < (e.honors ?? []).length - 1 ? '<span class="dot">·</span>' : ''}`).join('')}</div>`)
      }
      parts.push('</div>')
    }
  }

  if ((resume.skills ?? []).length > 0) {
    parts.push('<h2>专业技能</h2>')
    for (const s of resume.skills ?? []) {
      parts.push(`<p class="skill-p"><span class="skills-cat">${esc(s.category)}</span>：${esc(s.text)}</p>`)
    }
  }

  if ((resume.projects ?? []).length > 0) {
    parts.push('<h2>项目经历</h2>')
    for (const p of resume.projects ?? []) {
      parts.push(
        `<div class="entry"><div class="entry-head"><span>${esc(p.name ?? '')}</span><span>${esc(dateRange(p.startDate, p.endDate))}</span></div>`
      )
      if (p.description !== undefined && p.description !== '') parts.push(`<div class="desc">${esc(p.description)}</div>`)
      if ((p.techStack ?? []).length > 0) parts.push(`<div class="tags">${(p.techStack ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`)
      parts.push('</div>')
    }
  }

  if ((resume.experience ?? []).length > 0) {
    parts.push('<h2>实习经历</h2>')
    for (const x of resume.experience ?? []) {
      parts.push(
        `<div class="entry"><div class="entry-head"><span>${esc(x.company ?? '')}　<em>${esc(x.title ?? '')}</em></span><span>${esc(dateRange(x.startDate, x.endDate))}</span></div>`
      )
      if ((x.highlights ?? []).length > 0) parts.push(`<ul>${(x.highlights ?? []).map((h) => `<li>${esc(h)}</li>`).join('')}</ul>`)
      if ((x.techStack ?? []).length > 0) parts.push(`<div class="tags">${(x.techStack ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`)
      parts.push('</div>')
    }
  }

  if (resume.selfAssessment !== undefined && resume.selfAssessment !== '') {
    parts.push('<h2>自我评价</h2>')
    parts.push(`<div class="desc">${esc(resume.selfAssessment)}</div>`)
  }

  parts.push('</div>')
  return parts.join('\n')
}

/** 'YYYY-MM' / 'YYYY-MM-DD' 归一为 'YYYY.MM'；缺省 → '至今' 或 '—'。 */
export function dateRange(start: string | undefined | null, end: string | undefined | null): string {
  const fmt = (v: string | undefined | null): string | null => {
    if (v === undefined || v === null || v === '') return null
    return v.replace(/-/g, '.').slice(0, 7)
  }
  const s = fmt(start)
  const e = end === '至今' || end === '现在' ? '至今' : fmt(end)
  if (s === null && e === null) return ''
  return `${s ?? '—'} ~ ${e ?? '至今'}`
}

/** HTML 转义（用户字段一律经此）。 */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
