/**
 * 外壳级共用小件：拖拽条、相对时间、右键菜单、悬停菜单、新建菜单。
 *
 * 任务面板 / Git 面板 / 列表列都用到它们，单独放一份避免「面板 import 外壳」的循环依赖。
 * 这些组件只依赖 i18n、图标与少量 CSS 类，不含会话编排状态。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MessageCircle, Pencil, Plus } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
/**
 * 无对话头的中列界面（快速开启 / 角色空态 / 资料卡）共用的顶部拖拽把手：一条透明、与原生标题栏同高的
 * 窗口拖拽区，补上这些界面缺失的顶部拖拽（对话视图已由 .cf-conv__head 承担）。纯装饰、无交互。
 */
export function DragBar(): React.JSX.Element {
  return <div className="cf-dragbar" aria-hidden="true" />
}

/** 相对时间（本地化，词与数字空格拼接，不用插值——t 只收 key）。 */
export function useRelativeTime(): (ts: number) => string {
  const { t } = useI18n()
  return (ts: number): string => {
    const diff = Date.now() - ts
    const min = Math.floor(diff / 60000)
    if (min < 1) return t('chat.time.now')
    if (min < 60) return `${min} ${t('chat.time.min')}`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr} ${t('chat.time.hr')}`
    const day = Math.floor(hr / 24)
    if (day === 1) return t('chat.time.yesterday')
    return `${day} ${t('chat.time.day')}`
  }
}

/** 菜单条目：普通项点击即执行并关闭菜单；separator=分隔线；section=不可点的分组标题；filter=过滤框（按 label 过滤普通项）。 */
interface CtxItem {
  label: string
  icon?: React.ReactNode
  danger?: boolean
  /** 禁用项：灰显 + 悬停说明（title），不可点（如系统默认角色的删除项）。 */
  disabled?: boolean
  title?: string
  onClick: () => void
}
export type CtxEntry =
  | CtxItem
  | { kind: 'separator' }
  | { kind: 'section'; label: string }
  | { kind: 'filter'; placeholder?: string }

/**
 * 轻量右键菜单：定位到光标处（视口坐标），带全屏透明背板——点击 / 右键空白 / Esc 皆关闭。
 * 挂载后测量自身尺寸并夹取回视口内，避免贴近右 / 下边缘时溢出被裁。
 * openUp 时把传入的 y 当作菜单「底边」锚点（top = y − 菜单高度），使其向上生长——
 * 用于贴近视口底部的触发点（如挂载 chip 的 git pill），避免菜单向下遮挡输入区，行为同模型切换的 dropup。
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  openUp = false
}: {
  x: number
  y: number
  items: CtxEntry[]
  onClose: () => void
  /** 向上浮出：y 视作菜单底边锚点，菜单朝上生长（默认向下）。 */
  openUp?: boolean
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 8
    let left = x
    // openUp：y 是底边 → 顶边 = y − 高度；否则 y 即顶边。随后统一夹回视口。
    let top = openUp ? y - r.height : y
    if (left + r.width > window.innerWidth - pad) left = window.innerWidth - r.width - pad
    if (top + r.height > window.innerHeight - pad) top = window.innerHeight - r.height - pad
    setPos({ left: Math.max(pad, left), top: Math.max(pad, top) })
    // 条目数 / 过滤结果变化会改变高度，需重新夹取
  }, [x, y, openUp, items.length, q])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <>
      <div
        className="cf-ctx__backdrop"
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault()
          onClose()
        }}
      />
      <div ref={ref} className="cf-ctx" style={{ left: pos.left, top: pos.top }} role="menu">
        {items.map((it, i) => {
          if ('kind' in it) {
            if (it.kind === 'separator') return q ? null : <div key={i} className="cf-ctx__sep" role="separator" />
            if (it.kind === 'section') return q ? null : <div key={i} className="cf-ctx__section">{it.label}</div>
            return (
              <input
                key={i}
                className="cf-ctx__filter"
                autoFocus
                placeholder={it.placeholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )
          }
          if (q && !it.label.toLowerCase().includes(q)) return null
          return (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={`cf-ctx__item${it.danger ? ' is-danger' : ''}`}
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                onClose()
                it.onClick()
              }}
            >
              {it.icon}
              <span>{it.label}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}

/**
 * 搜索行 + 按钮浮层的开合逻辑（AddMenu / NewChatMenu 共用）：悬停或点击展开，
 * 离开略延迟收起以容忍按钮→浮层途中的空档（避免闪烁），choose 选中即收起并执行。
 */
export function useHoverMenu(): {
  open: boolean
  hoverProps: { onMouseEnter: () => void; onMouseLeave: () => void }
  show: () => void
  choose: (fn: () => void) => void
} {
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<number | null>(null)

  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }
  const scheduleClose = (): void => {
    cancelClose()
    closeTimer.current = window.setTimeout(() => setOpen(false), 140)
  }
  useEffect(() => cancelClose, [])

  return {
    open,
    hoverProps: {
      onMouseEnter: () => {
        cancelClose()
        setOpen(true)
      },
      onMouseLeave: scheduleClose
    },
    show: () => setOpen(true),
    choose: (fn) => {
      cancelClose()
      setOpen(false)
      fn()
    }
  }
}

/**
 * 「添加」入口（角色花名册 / 定时任务共用）：一个 + 图标，鼠标悬停或点击弹出二选一浮层——
 * 手动添加（打开编辑器表单）/ 通过对话添加（新建对话、Agent 引导创建）。
 * 开合逻辑见 useHoverMenu。文案由调用方按对象给（角色 / 任务）。
 */
export function AddMenu({
  manualLabel,
  chatLabel,
  onManual,
  onByChat
}: {
  /** 手动项文案，同时作 + 按钮的 title / aria-label（如「添加角色」「添加任务」）。 */
  manualLabel: string
  /** 「通过对话添加」项文案。 */
  chatLabel: string
  onManual: () => void
  onByChat: () => void
}): React.JSX.Element {
  const { open, hoverProps, show, choose } = useHoverMenu()

  return (
    <div className="cf-addmenu" {...hoverProps}>
      <button
        className="cf-rail__addbtn"
        title={manualLabel}
        aria-label={manualLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={show}
      >
        <Plus size={16} />
      </button>
      {open && (
        <div className="cf-addmenu__pop" role="menu">
          <button className="cf-addmenu__item" role="menuitem" onClick={() => choose(onManual)}>
            <Pencil size={15} className="cf-addmenu__icon" />
            <span>{manualLabel}</span>
          </button>
          <button className="cf-addmenu__item" role="menuitem" onClick={() => choose(onByChat)}>
            <MessageCircle size={15} className="cf-addmenu__icon" />
            <span>{chatLabel}</span>
          </button>
        </div>
      )}
    </div>
  )
}
