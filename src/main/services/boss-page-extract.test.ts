import { describe, expect, it } from 'vitest'
import { toBossPageDraft, type BossPageRaw } from './boss-page-extract'

/**
 * BOSS 岗位详情页 body innerText fixture（调研实录形状：docs/research/boss-zhipin-crawlability.md
 * 详情字段 jobName/positionName/salaryDesc/postDescription/brandName/locationName；
 * 页面渲染形态为标题行 + 职位描述节 + 公司介绍节 + 工作地址节）。
 * 采集脚本只读 innerText，识别逻辑全在主进程纯函数（本文件被测对象）。
 */
const DETAIL_BODY = [
  '前端开发工程师',
  '20-40K·14薪',
  '上海·浦东新区·临港 3-5年 本科',
  '职位描述',
  '工作职责',
  '负责自动驾驶数据平台、标注平台、仿真平台的前端架构设计与开发。',
  '负责海量点云、图像、视频、地图等数据的 Web3D 可视化与交互开发。',
  '任职要求',
  '1. 本科及以上学历，计算机相关专业；',
  '2. 熟悉 Vue/React 技术栈。',
  '公司介绍',
  '深圳市法本信息技术股份有限公司（以下简称：法本信息）是全国领先的软件技术服务提供商。',
  '工作地址',
  '上海浦东新区中国(上海)自由贸易试验区临港新片区环湖西三路1199号'
].join('\n')

function raw(overrides: Partial<BossPageRaw> = {}): BossPageRaw {
  return {
    title: '前端开发工程师招聘-法本-BOSS直聘',
    h1: '前端开发工程师',
    bodyText: DETAIL_BODY,
    url: 'https://www.zhipin.com/job_detail/35GxeybE2quwd.html',
    ...overrides
  }
}

describe('toBossPageDraft（BOSS 详情页 DOM 文本 → 职位卡草稿）', () => {
  it('完整详情页：公司/岗位/城市/薪资/JD 全字段映射', () => {
    const result = toBossPageDraft(raw())
    expect(result.draft).not.toBeNull()
    const draft = result.draft as NonNullable<typeof result.draft>
    expect(draft.company).toBe('法本')
    expect(draft.title).toBe('前端开发工程师')
    expect(draft.city).toBe('上海')
    expect(draft.salary_min).toBe(20)
    expect(draft.salary_max).toBe(40)
    expect(draft.salary_text).toBe('20-40K·14薪')
    expect(draft.channel).toBe('BOSS直聘')
    expect(draft.channel_url).toContain('job_detail/35GxeybE2quwd')
    expect(draft.hire_type).toBe('社招')
    // JD 只取职位描述节：含职责分节，不含公司介绍/工作地址；保留段落行结构
    expect(draft.jd).toContain('工作职责')
    expect(draft.jd).toContain('Web3D 可视化')
    expect(draft.jd).toContain('任职要求')
    expect(draft.jd).not.toContain('公司介绍')
    expect(draft.jd).not.toContain('工作地址')
    expect(draft.jd).not.toContain('法本信息')
    expect(draft.jd.split('\n').length).toBeGreaterThan(3)
  })

  it('「」包裹标题 + 无后续节：JD 取到文末', () => {
    const body = ['前端开发工程师', '15-25K', '北京·朝阳区', '职位描述', '负责 xyz。'].join('\n')
    const result = toBossPageDraft(
      raw({ title: '「前端开发工程师招聘」-某科技-BOSS直聘', bodyText: body })
    )
    expect(result.draft).not.toBeNull()
    const draft = result.draft as NonNullable<typeof result.draft>
    expect(draft.company).toBe('某科技')
    expect(draft.title).toBe('前端开发工程师')
    expect(draft.jd).toContain('负责 xyz。')
    expect(draft.jd).not.toContain('职位描述')
    expect(draft.city).toBe('北京')
  })

  it('薪资只有下限（30K以上）→ min 30 / max null；薪资面议 → 数值 null 文本保留', () => {
    const minOnly = toBossPageDraft(
      raw({ bodyText: ['前端开发工程师', '30K以上', '职位描述', '负责 abc。'].join('\n') })
    )
    expect(minOnly.draft?.salary_min).toBe(30)
    expect(minOnly.draft?.salary_max).toBeNull()
    expect(minOnly.draft?.salary_text).toBe('30K以上')

    const negotiable = toBossPageDraft(
      raw({ bodyText: ['前端开发工程师', '薪资面议', '职位描述', '负责 abc。'].join('\n') })
    )
    expect(negotiable.draft?.salary_min).toBeNull()
    expect(negotiable.draft?.salary_max).toBeNull()
    expect(negotiable.draft?.salary_text).toBe('薪资面议')
  })

  it('无薪资文本 → 薪资字段全空', () => {
    const result = toBossPageDraft(
      raw({ bodyText: ['前端开发工程师', '上海·浦东新区', '职位描述', '负责 abc。'].join('\n') })
    )
    expect(result.draft?.salary_min).toBeNull()
    expect(result.draft?.salary_max).toBeNull()
    expect(result.draft?.salary_text).toBeUndefined()
  })

  it('招聘类型猜测：标题含实习 → 实习；含校招/应届/届 → 校招；否则社招', () => {
    const intern = toBossPageDraft(raw({ title: '前端实习生招聘-法本-BOSS直聘', h1: '前端实习生' }))
    expect(intern.draft?.hire_type).toBe('实习')

    const campus = toBossPageDraft(
      raw({ title: '2026届校招前端-法本-BOSS直聘', h1: '2026届校招前端' })
    )
    expect(campus.draft?.hire_type).toBe('校招')
  })

  it('非详情页（无职位描述/工作职责节）→ draft null + 可读错误', () => {
    const result = toBossPageDraft(
      raw({ bodyText: 'BOSS直聘\n首页 职位 公司\n北京上海广州深圳'.repeat(5) })
    )
    expect(result.draft).toBeNull()
    expect(result.error).toContain('详情页')
  })
})
