/**
 * 布局引擎（#42 T1）：侧边栏/列宽拖拽 + 收起，宽度持久化。
 * 移植自 prototype/jobhunt-ui.html 的「布局引擎」脚本块，保持同一语义：
 * - CSS 变量 --sbw（侧边栏宽）与 --colw（内容列宽），localStorage 键 jobhunt.sbw / jobhunt.colw
 * - 收起状态 = <html>.sb-off，localStorage 键 jobhunt.sbOff
 * - 侧边栏拖到 <= SB_MIN-10 视为收起并复位 168px；双击还原默认宽
 */

export const SB_MIN = 120
export const SB_MAX = 320
export const SB_DEFAULT = 168
export const COL_MIN = 180
export const COL_MAX = 520
export const COL_DEFAULT = 300

const SB_COLLAPSE = SB_MIN - 10

function defaultOf(name: string): number {
  return name === '--sbw' ? SB_DEFAULT : COL_DEFAULT
}

/** 读取当前布局变量（CSS 变量可能未显式设置时回落默认值）。 */
export function layoutVal(name: string): number {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
  return Number.isFinite(v) ? v : defaultOf(name)
}

/** 写入布局变量并持久化（jobhunt.sbw / jobhunt.colw）。 */
export function layoutSet(name: string, v: number): void {
  document.documentElement.style.setProperty(name, `${v}px`)
  try {
    localStorage.setItem(`jobhunt.${name.slice(2)}`, String(v))
  } catch {
    /* localStorage 不可用时仅内存生效 */
  }
}

/** 收起/展开侧边栏（html.sb-off + jobhunt.sbOff）。 */
export function setSidebar(off: boolean): void {
  document.documentElement.classList.toggle('sb-off', off)
  try {
    localStorage.setItem('jobhunt.sbOff', off ? '1' : '0')
  } catch {
    /* ignore */
  }
}

export function isSidebarOff(): boolean {
  return document.documentElement.classList.contains('sb-off')
}

/** 启动时恢复持久化的布局（main.ts 挂载前调用）。 */
export function applySavedLayout(): void {
  try {
    if (localStorage.getItem('jobhunt.sbOff') === '1') {
      document.documentElement.classList.add('sb-off')
    }
    const sbw = localStorage.getItem('jobhunt.sbw')
    if (sbw) document.documentElement.style.setProperty('--sbw', `${sbw}px`)
    const colw = localStorage.getItem('jobhunt.colw')
    if (colw) document.documentElement.style.setProperty('--colw', `${colw}px`)
  } catch {
    /* ignore */
  }
}

export interface ResizerOptions {
  /** 拖拽的布局变量名：'--sbw' | '--colw' */
  name: '--sbw' | '--colw'
  min: number
  max: number
  reset: number
  /** 拖到过窄（<= min-10）时收起侧边栏（仅 --sbw 使用）。 */
  collapseBelow?: boolean
}

/** 给拖拽手柄绑定 mousedown/touchstart + 双击还原；返回清理函数。 */
export function bindResizer(handle: HTMLElement, opts: ResizerOptions): () => void {
  let drag = false
  let sx = 0
  let sv = 0
  let tip: HTMLElement | null = null

  const { name, min, max, reset, collapseBelow } = opts

  function tipPos(): void {
    if (!tip) return
    const r = handle.getBoundingClientRect()
    tip.style.left = `${r.left + r.width / 2}px`
  }

  function tipShow(v: number): void {
    if (!tip) {
      tip = document.createElement('div')
      tip.className = 'res-tip'
      document.body.appendChild(tip)
    }
    tip.textContent = `${v}px`
    tipPos()
  }

  function onMove(e: MouseEvent | TouchEvent): void {
    if (!drag) return
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX
    let v = Math.round(sv + clientX - sx)
    if (collapseBelow && v <= SB_COLLAPSE) {
      layoutSet(name, SB_COLLAPSE)
      tipShow(SB_COLLAPSE)
      return
    }
    v = Math.max(min, Math.min(max, v))
    layoutSet(name, v)
    tipShow(v)
  }

  function endDrag(): void {
    if (!drag) return
    drag = false
    document.body.classList.remove('resizing')
    handle.classList.remove('drag')
    if (tip) {
      tip.remove()
      tip = null
    }
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', endDrag)
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('touchend', endDrag)
    if (collapseBelow) {
      const w = layoutVal(name)
      if (w <= SB_COLLAPSE) {
        setSidebar(true)
        layoutSet(name, SB_DEFAULT)
      } else if (w < min) {
        layoutSet(name, min)
      }
    }
  }

  function start(e: MouseEvent | TouchEvent): void {
    if (drag) return
    if ('button' in e && e.button !== 0) return
    drag = true
    const clientX = 'touches' in e ? e.touches[0].clientX : (e as MouseEvent).clientX
    sx = clientX
    sv = layoutVal(name)
    document.body.classList.add('resizing')
    handle.classList.add('drag')
    tipShow(sv)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', endDrag)
    document.addEventListener('touchmove', onMove, { passive: true })
    document.addEventListener('touchend', endDrag)
  }

  function onTouchStart(e: TouchEvent): void {
    if (e.cancelable) e.preventDefault()
    start(e)
  }

  function onDblClick(): void {
    layoutSet(name, reset)
  }

  handle.addEventListener('mousedown', start)
  handle.addEventListener('touchstart', onTouchStart, { passive: false })
  handle.addEventListener('dblclick', onDblClick)

  return () => {
    handle.removeEventListener('mousedown', start)
    handle.removeEventListener('touchstart', onTouchStart)
    handle.removeEventListener('dblclick', onDblClick)
    endDrag()
  }
}
