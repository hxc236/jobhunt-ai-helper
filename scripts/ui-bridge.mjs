// UI 状态桥（computer-use 全量验证用）：只读——输出 aria 快照 / 指定文本元素的屏幕坐标。
// 动作由 computer-use（OS 级鼠标键盘）执行；本桥是"眼睛"。
// 用法：ELECTRON_RUN_AS_NODE=1 electron scripts/ui-bridge.mjs <port> snapshot | coord <text> | db <userData>
import { chromium } from 'playwright-core'

const port = process.argv[2]
const mode = process.argv[3]

async function main() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const ctx = browser.contexts()[0]
  const page = ctx.pages()[0]
  if (mode === 'snapshot') {
    const root = page.locator('body')
    const snap = await root.ariaSnapshot({ ref: true })
    console.log(snap)
  } else if (mode === 'coord') {
    const text = process.argv[4]
    // 精确匹配文本（忽略首尾空白），返回首个匹配元素的屏幕坐标（窗口位置 + 元素偏移 * dpr）
    const pos = await page.evaluate(
      ([t]) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        const targets = []
        while (node) {
          const txt = (node.textContent ?? '').trim()
          if (txt === t || txt.includes(t)) {
            const el = node.parentElement
            if (el) {
              const r = el.getBoundingClientRect()
              targets.push({
                text: txt.slice(0, 80),
                x: Math.round(window.screenX + r.x * window.devicePixelRatio + (r.width * window.devicePixelRatio) / 2),
                y: Math.round(window.screenY + r.y * window.devicePixelRatio + (r.height * window.devicePixelRatio) / 2),
                w: Math.round(r.width * window.devicePixelRatio),
                h: Math.round(r.height * window.devicePixelRatio)
              })
            }
          }
          node = walker.nextNode()
        }
        return targets
      },
      [text]
    )
    console.log(JSON.stringify(pos, null, 2))
  } else {
    console.error('用法：ui-bridge.mjs <port> snapshot | coord <text>')
    process.exit(1)
  }
  await browser.close()
}

main().catch((e) => {
  console.error('ERR', e.message)
  process.exit(1)
})
