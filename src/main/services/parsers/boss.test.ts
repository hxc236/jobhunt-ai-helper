import { describe, expect, it } from 'vitest'
import { BossParser, parseSalary } from './boss'

/**
 * 列表接口 fixture（调研实录形状，见 docs/research/boss-zhipin-crawlability.md：
 * /wapi/zpgeek/search/joblist.json 响应，49 字段；salaryDesc 匿名会话为空）。
 * job1：法本 前端（匿名薪资空、lid 页码 1）；job2：某公司 后端（20-40K·14薪）。
 */
const LIST_JSON = JSON.stringify({
  code: 0,
  message: 'Success',
  zpData: {
    hasMore: true,
    jobList: [
      {
        securityId: '35GxeybE2quwd-k1xAvSxMF_TzJ-YFIJyHkt5EGuxDl_91q2VkgK6eexPx6Dltre5Xu2IKgBGtEIQQlRvO1tld5JbibilUkp7hasGArnO6gYhAAhStzazq_NvICCcj8zHRu6rLDo7MT43hC5_wCWEpTqGuMuDUIrUeX9Pgge1yTjZbhpNnAXRuY9vZBwaZVCti0ZwaNx0bbDwgHYTUwYlI',
        encryptJobId: '3b7ea4648f5e69900nJ509y9F1NQ',
        jobName: '前端',
        salaryDesc: '',
        jobLabels: ['3-5年', '本科'],
        skills: ['CSS', 'HTML5', 'threejs'],
        jobExperience: '3-5年',
        jobDegree: '本科',
        cityName: '上海',
        areaDistrict: '浦东新区',
        businessDistrict: '临港',
        gps: { lon: 121.9175, lat: 30.9033 },
        brandName: '法本',
        brandStageName: '已上市',
        brandIndustry: '计算机软件',
        brandScaleName: '10000人以上',
        welfareList: ['五险一金', '带薪年假'],
        bossName: '王女士',
        bossTitle: 'HR',
        bossOnline: true,
        jobValidStatus: 1,
        lid: 'abcdef123.search.1'
      },
      {
        securityId: 'SECOND_SECURITY_ID_2',
        encryptJobId: 'abc123def456ghi789',
        jobName: '后端工程师',
        salaryDesc: '20-40K·14薪',
        jobLabels: ['5-10年', '本科'],
        skills: ['Java', 'Spring'],
        jobExperience: '5-10年',
        jobDegree: '本科',
        cityName: '上海',
        areaDistrict: '徐汇区',
        businessDistrict: '漕河泾',
        gps: { lon: 121.43, lat: 31.18 },
        brandName: '某公司',
        brandStageName: 'C轮',
        brandIndustry: '互联网',
        brandScaleName: '500-999人',
        welfareList: [],
        bossName: '李先生',
        bossTitle: '技术总监',
        bossOnline: false,
        jobValidStatus: 1,
        lid: 'xyz789.search.1'
      }
    ]
  }
})

/** 详情接口 fixture（probe6 实录：jobInfo.postDescription JD 全文、positionName 全名）。 */
const DETAIL_JSON = JSON.stringify({
  code: 0,
  message: 'Success',
  zpData: {
    pageType: 0,
    selfAccess: false,
    securityId: '35GxeybE2quwd-k1xAvSxMF_TzJ-YFIJyHkt5EGuxDl_91q2VkgK6eexPx6Dltre5Xu2IKgBGtEIQQlRvO1tld5JbibilUkp7hasGArnO6gYhAAhStzazq_NvICCcj8zHRu6rLDo7MT43hC5_wCWEpTqGuMuDUIrUeX9Pgge1yTjZbhpNnAXRuY9vZBwaZVCti0ZwaNx0bbDwgHYTUwYlI',
    jobInfo: {
      encryptId: '3b7ea4648f5e69900nJ509y9F1NQ',
      jobName: '前端',
      positionName: '前端开发工程师',
      locationName: '上海',
      experienceName: '3-5年',
      degreeName: '本科',
      salaryDesc: '20-40K·14薪',
      postDescription:
        '工作职责\n负责自动驾驶数据平台、标注平台、仿真平台的前端架构设计与开发。\n负责海量点云、图像、视频、地图等数据的 Web3D 可视化与交互开发。\n负责激光雷达点云、BEV、三维框、轨迹、地图元素等场景的渲染与编辑能力建设。',
      showSkills: ['CSS', 'HTML5', 'threejs', '架构师经验'],
      address: '上海浦东新区临港新片区环湖西三路1199号'
    },
    brandComInfo: { brandName: '法本', stageName: '已上市', scaleName: '10000人以上', industryName: '计算机软件' },
    bossInfo: { name: '王女士', title: 'HR', onlineStatus: 1 }
  }
})

/** 无更多页（hasMore=false）。 */
const LIST_JSON_LAST_PAGE = LIST_JSON.replace('"hasMore":true', '"hasMore":false')

function makeContext(extra: Record<string, string | undefined> = {}): { mode: 'filter'; filter: string | undefined; hire_type?: '校招' | '社招' | '实习'; keyword?: string; city?: string } {
  return { mode: 'filter', filter: undefined, ...extra }
}

describe('parseSalary 薪资解析（issue #53）', () => {
  it('空值/面议/日薪 → 数值为空，原文本保留', () => {
    expect(parseSalary('')).toEqual({ min: null, max: null, text: null })
    expect(parseSalary('薪资面议')).toEqual({ min: null, max: null, text: '薪资面议' })
    expect(parseSalary('200-300元/天')).toEqual({ min: null, max: null, text: '200-300元/天' })
  })

  it('K 区间（含 14薪/13薪 后缀、无 K 后缀、以上）→ min/max', () => {
    expect(parseSalary('20-40K·14薪')).toEqual({ min: 20, max: 40, text: '20-40K·14薪' })
    expect(parseSalary('15-20K·13薪')).toEqual({ min: 15, max: 20, text: '15-20K·13薪' })
    expect(parseSalary('30K以上')).toEqual({ min: 30, max: null, text: '30K以上' })
    expect(parseSalary('20K-30K')).toEqual({ min: 20, max: 30, text: '20K-30K' })
  })
})

describe('BossParser 列表解析（issue #53）', () => {
  it('buildUrls：采集条件 → 搜索页 URL（关键词/城市/页码；实习入口带 jobType=1902）', () => {
    const parser = new BossParser()
    // 社招：query + city，jobType=1901（全职，字典实测）
    expect(
      parser.buildUrls('full', undefined, { mode: 'full', filter: undefined, hire_type: '社招', keyword: '前端', city: '101020100' })
    ).toEqual(['https://www.zhipin.com/web/geek/job?query=%E5%89%8D%E7%AB%AF&city=101020100&page=1&jobType=1901'])
    // 实习：jobType=1902（字典实测）
    expect(
      parser.buildUrls('full', undefined, { mode: 'full', filter: undefined, hire_type: '实习', keyword: '前端', city: '101020100' })
    ).toEqual(['https://www.zhipin.com/web/geek/job?query=%E5%89%8D%E7%AB%AF&city=101020100&page=1&jobType=1902'])
    // 无条件：基础页（BOSS 默认推荐）
    expect(parser.buildUrls('full', undefined, { mode: 'full', filter: undefined })).toEqual([
      'https://www.zhipin.com/web/geek/job'
    ])
  })

  it('joblist.json → 候选行：公司/岗位/城市/薪资/详情入口/去重 URL', () => {
    const parser = new BossParser()
    const candidates = parser.parseList(LIST_JSON, makeContext({ hire_type: '社招', keyword: '前端', city: '101020100' }))

    expect(candidates).toHaveLength(2)
    const [frontend, backend] = candidates

    expect(frontend).toMatchObject({
      company: '法本',
      title: '前端',
      jd: '',
      city: '上海',
      channel: null,
      channel_url: null,
      hire_type: '社招',
      recruit_season: '',
      salary_min: null,
      salary_max: null,
      salary_text: null,
      source_url: 'https://www.zhipin.com/job_detail/3b7ea4648f5e69900nJ509y9F1NQ.html',
      detailUrl:
        'https://www.zhipin.com/wapi/zpgeek/job/detail.json?securityId=35GxeybE2quwd-k1xAvSxMF_TzJ-YFIJyHkt5EGuxDl_91q2VkgK6eexPx6Dltre5Xu2IKgBGtEIQQlRvO1tld5JbibilUkp7hasGArnO6gYhAAhStzazq_NvICCcj8zHRu6rLDo7MT43hC5_wCWEpTqGuMuDUIrUeX9Pgge1yTjZbhpNnAXRuY9vZBwaZVCti0ZwaNx0bbDwgHYTUwYlI',
      end_date: null
    })
    expect(frontend?.batch).toBeNull()

    // 薪资解析落位
    expect(backend).toMatchObject({ salary_min: 20, salary_max: 40, salary_text: '20-40K·14薪' })
  })

  it('校招入口（keyword 含届数）→ hire_type 校招 + recruit_season 推导届数', () => {
    const parser = new BossParser()
    const candidates = parser.parseList(
      LIST_JSON,
      makeContext({ hire_type: '校招', keyword: '2026届校招前端', city: '101020100' })
    )
    expect(candidates[0]).toMatchObject({ hire_type: '校招', recruit_season: '2026校招' })
  })

  it('缺省招聘类型按校招；关键字无届数 → recruit_season 空（入库兜底"未知"）', () => {
    const parser = new BossParser()
    const candidates = parser.parseList(LIST_JSON, makeContext({ keyword: '前端' }))
    expect(candidates[0]).toMatchObject({ hire_type: '校招', recruit_season: '' })
  })

  it('空壳/异常 JSON → 空候选（纯函数不抛）', () => {
    const parser = new BossParser()
    expect(parser.parseList('', makeContext())).toEqual([])
    expect(parser.parseList('not json', makeContext())).toEqual([])
    expect(parser.parseList('{"code":37,"message":"环境异常"}', makeContext())).toEqual([])
    expect(parser.parseList('{"zpData":{}}', makeContext())).toEqual([])
  })

  it('翻页：hasMore=true → 下一页 URL（页码从 lid 提取，条件保留）；hasMore=false → null', () => {
    const parser = new BossParser()
    const context = makeContext({ hire_type: '社招', keyword: '前端', city: '101020100' })
    expect(parser.nextListUrl?.(LIST_JSON, context)).toBe(
      'https://www.zhipin.com/web/geek/job?query=%E5%89%8D%E7%AB%AF&city=101020100&page=2&jobType=1901'
    )
    expect(parser.nextListUrl?.(LIST_JSON_LAST_PAGE, context)).toBeNull()
    // lid 无页码 / 无条件 → 无法翻页，返回 null（不猜）
    expect(parser.nextListUrl?.(LIST_JSON, makeContext())).toBeNull()
  })
})

describe('BossParser 详情解析（issue #53）', () => {
  it('detail.json → 补全 JD 全文、岗位全名、薪资', () => {
    const parser = new BossParser()
    const base = parser.parseList(LIST_JSON, makeContext({ hire_type: '社招' }))[0] as NonNullable<
      ReturnType<BossParser['parseList']>[number]
    >
    const full = parser.parseDetail?.(DETAIL_JSON, base)
    expect(full).toBeDefined()
    expect(full?.jd).toContain('负责自动驾驶数据平台')
    expect(full?.jd).toContain('工作职责')
    expect(full?.title).toBe('前端开发工程师') // positionName 全名
    expect(full?.salary_min).toBe(20)
    expect(full?.salary_max).toBe(40)
    expect(full?.salary_text).toBe('20-40K·14薪')
  })

  it('异常 JSON → 候选原样返回', () => {
    const parser = new BossParser()
    const base = parser.parseList(LIST_JSON, makeContext({ hire_type: '社招' }))[0] as NonNullable<
      ReturnType<BossParser['parseList']>[number]
    >
    expect(parser.parseDetail?.('', base)).toBe(base)
  })
})
