import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  Pencil,
  Copy,
  Trash2,
  Check,
  Plus,
  AlarmClock,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowUpToLine,
  ChevronRight,
  Cog,
  Folder,
  FolderMinus,
  Globe,
  ListChecks,
  ListFilter,
  MessageCircle,
  Search,
  Bot,
  Users,
  X
} from 'lucide-react'
import { BotsPane } from './BotsPane'
import { iconFor } from './attach-icon'
import { useSyncExternalStore } from 'react'
import { ChevronDown, Clock, FolderPlus, Lightbulb, Paperclip, Puzzle, RotateCcw, Shrink, Square } from 'lucide-react'
import { TodoCapsule } from '../features/chat/Todos'
import { BackgroundCapsule } from '../features/chat/BackgroundTasks'
import { BrowserCapsule } from '../features/browser/BrowserCapsule'
import { useDockOrder } from '../features/chat/dockOrder'
import { COMPOSER_DEFAULT, clampComposer } from './resizable'
import type { EffortLevel } from '../../../shared/effort'
interface Picked {
  path: string
  name: string
  ext: string
  size: number
  kind: 'image' | 'document' | 'text' | 'unsupported'
  supported: boolean
  reason?: string
}

/**
 * 输入框「/ 指令」联想的一个候选项。
 * `command` = 渲染层自有指令（/compact 见 store/chat 的手动压缩分支；/rewind 在 Composer.submit 拦截）；
 * `skill` = 已启用技能，由主进程按 `/name` 匹配并把 SKILL.md 正文预置进本轮消息。
 */
interface SlashCommand {
  name: string
  desc: string
  kind: 'command' | 'skill'
}

function slashQueryOf(input: string): string | null {
  const m = /^\/([A-Za-z0-9_-]*)$/.exec(input)
  return m ? m[1] : null
}

/**
 * 各会话未发送的输入（正文 + 待发附件），按会话 id 存在内存里：切走时存下、切回来接着写，也不会把 A 会话
 * 没写完的内容带到 B。只存非空的；不落盘，重启应用后清空。
 * 会话列表据此在其他会话行上显示「[草稿] …」（见 useDraftPreview）：只在进出会话时变动，打字不刷新列表。
 */
type ComposerDraft = { text: string; pending: Picked[] }
const composerDrafts = new Map<string, ComposerDraft>()
const draftListeners = new Set<() => void>()

/** 写入（null = 清除）某会话的草稿，并通知会话列表。 */
function setComposerDraft(id: string, draft: ComposerDraft | null): void {
  if (draft) composerDrafts.set(id, draft)
  else if (!composerDrafts.delete(id)) return
  for (const notify of draftListeners) notify()
}

function subscribeDrafts(onChange: () => void): () => void {
  draftListeners.add(onChange)
  return () => {
    draftListeners.delete(onChange)
  }
}

/**
 * 正在显示的输入框（随会话切换更新）：插入的消息被撤回或退回时，正是这个会话就直接放回输入框，否则并进那个
 * 会话的草稿（见 restoreToComposer）。
 */
let liveComposer: { sessionId: string; restore: (text: string) => void } | null = null

/** 把文字放回某会话的输入框：排在已有内容之前，中间空一行。 */
function restoreToComposer(sessionId: string, text: string): void {
  if (!text.trim()) return
  if (liveComposer?.sessionId === sessionId) {
    liveComposer.restore(text)
    return
  }
  const d = composerDrafts.get(sessionId)
  setComposerDraft(sessionId, {
    text: d?.text.trim() ? `${text}\n\n${d.text}` : text,
    pending: d?.pending ?? []
  })
}

/**
 * 待送达的插入消息（输入框上方，与待办清单、后台任务胶囊同一排）：回合进行中插入、当前步骤还没结束的消息。
 * 「撤回」把文字放回输入框，可以改完再插入；送达后胶囊消失，消息出现在执行步骤里。多条显示条数，送达时合并成一条。
 */
function InsertCapsule({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const { t } = useI18n()
  const { pendingInserts, withdrawInserts } = useChat()
  const [busy, setBusy] = useState(false)
  const order = useDockOrder(pendingInserts.length > 0, sessionId)
  if (pendingInserts.length === 0) return null
  const text = pendingInserts.join('  ')
  const withdraw = (): void => {
    setBusy(true)
    void withdrawInserts()
      .then((back) => restoreToComposer(sessionId, back))
      .finally(() => setBusy(false))
  }
  return (
    <div className="cf-ins" style={{ order }}>
      {/* 消息文字最多 160px（见 .cf-dock），完整内容挂在悬停上 */}
      <div className="cf-bg__pill cf-ins__pill" title={`${text}\n${t('cf.insert.pendingHint')}`}>
        <Clock size={13} className="cf-ins__icon" />
        <span className="cf-bg__label cf-ins__label">{t('cf.insert.pending')}</span>
        <span className="cf-bg__name">{text}</span>
        {pendingInserts.length > 1 && (
          <span className="cf-ins__count">{t('cf.insert.count').replace('{n}', String(pendingInserts.length))}</span>
        )}
        <button type="button" className="cf-bg__stop" disabled={busy} onClick={withdraw}>
          {t('cf.insert.withdraw')}
        </button>
      </div>
    </div>
  )
}

/** 某会话草稿的一行摘要：正文（空白归一），只有附件时为附件名；没有草稿为 null。 */
function useDraftPreview(id: string): string | null {
  return useSyncExternalStore(subscribeDrafts, () => {
    const d = composerDrafts.get(id)
    if (!d) return null
    return d.text.replace(/\s+/g, ' ').trim() || d.pending.map((p) => p.name).join(' ') || null
  })
}

function Composer({
  sessionId,
  owner,
  streaming,
  focusRoot,
  onMount,
  onSend,
  onStop,
  showJump,
  onJump,
  onRewind,
  prefill,
  onPrefillConsumed
}: {
  /** 当前会话：输入框里的草稿按它分开保存（见 composerDrafts）。 */
  sessionId: string
  owner?: Persona
  streaming: boolean
  focusRoot: string | null
  onMount: (path: string | null) => void
  onSend: (text: string, attachments?: SendAttachment[]) => Promise<boolean>
  onStop: () => void
  showJump: boolean
  onJump: () => void
  /** 打开检查点回滚面板（/rewind、双击 Esc）；返回 false 表示此刻不可用（未打开）。 */
  onRewind: () => boolean
  prefill: { text: string; nonce: number } | null
  onPrefillConsumed: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  const { skills: allSkills } = useExtensions()
  // 本对话角色能用的技能（已启用、且可用角色含该角色；内置恒可用）——同主进程的过滤，/ 联想与上色只认它们。
  const ownerId = owner?.id ?? DEFAULT_PERSONA_ID
  const skills = useMemo(
    () => allSkills.filter((s) => s.enabled && (s.source === 'builtin' || rolesAllow(s.roles, ownerId))),
    [allSkills, ownerId]
  )
  const toast = useToast()
  const { insert: onInsert } = useChat()
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<Picked[]>([])
  const pendingRef = useRef(pending)
  pendingRef.current = pending
  const sessionRef = useRef(sessionId)
  sessionRef.current = sessionId
  // 输入框高度：固定高、不随内容长高，内容多了框内滚动；只能靠顶边手柄拖动调整。
  // 与侧栏同理，存用户意图值、渲染时按窗口高再夹取。
  const viewport = useViewport()
  const [composerH, setComposerH] = useState(() => loadLayout().composerHeight ?? COMPOSER_DEFAULT)
  const boxH = clampComposer(composerH, viewport.h)
  const boxHRef = useRef(boxH)
  boxHRef.current = boxH
  /** 「/ 指令」联想：当前高亮项下标（随查询词变化复位）。 */
  const [slashSel, setSlashSel] = useState(0)
  /** Esc 收起联想；任何一次输入改动都会复位，重新键入即可再唤出。 */
  const [slashOff, setSlashOff] = useState(false)
  /** 输入框是否持有焦点：失焦即收起联想（采纳项走 mousedown+preventDefault，不会触发失焦）。 */
  const [focused, setFocused] = useState(false)
  const slashRef = useRef<HTMLDivElement>(null)
  /** 上一次「空输入框里按 Esc」的时刻：500ms 内再按一次即打开回滚面板。 */
  const lastEscRef = useRef(0)

  // 预填（不发送）：把父层注入的文本写进输入框，聚焦并将光标移到末尾，交由用户自己发送。
  // nonce 变化触发一次；消费后立即回调置空（父层 prefill→null），guard 防重入与重挂载复活。
  useEffect(() => {
    if (!prefill) return
    composer.setText(prefill.text, true)
    onPrefillConsumed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.nonce])

  // 指令表：渲染层自有的 /compact、/rewind 置顶，其后是本角色可用的技能（停用或不对本角色开放的主进程也不认）。
  // 同名技能会被自有指令遮蔽（渲染层先拦截），按小写名去重、保留先者，不给出点了没反应的候选。
  const slashCommands = useMemo<SlashCommand[]>(() => {
    const out: SlashCommand[] = [
      { name: 'compact', desc: t('cf.slash.compact'), kind: 'command' },
      { name: 'rewind', desc: t('cf.slash.rewind'), kind: 'command' }
    ]
    const seen = new Set(out.map((c) => c.name.toLowerCase()))
    for (const s of skills) {
      if (!s.enabled) continue
      const key = s.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ name: s.name, desc: s.desc, kind: 'skill' })
    }
    return out
  }, [skills, t])

  const slashQuery = slashQueryOf(input)
  // 排序：前缀命中优先于子串命中，组内保持原序（/compact 在前，技能按扩展页顺序）。
  const slashMatches = useMemo<SlashCommand[]>(() => {
    if (slashQuery === null) return []
    const q = slashQuery.toLowerCase()
    if (!q) return slashCommands
    const head: SlashCommand[] = []
    const tail: SlashCommand[] = []
    for (const c of slashCommands) {
      const n = c.name.toLowerCase()
      if (n.startsWith(q)) head.push(c)
      else if (n.includes(q)) tail.push(c)
    }
    return [...head, ...tail]
  }, [slashCommands, slashQuery])
  const slashOpen = focused && slashQuery !== null && slashMatches.length > 0 && !slashOff
  // 高亮下标就地夹紧：命中集随输入收缩时，无需等 effect 落地即为合法值。
  const slashCur = slashOpen ? Math.min(slashSel, slashMatches.length - 1) : -1

  // 查询词一变就回到第一项（最贴合用户刚敲的那几个字母）。
  useEffect(() => {
    setSlashSel(0)
  }, [slashQuery])

  // 键盘上下移动时把高亮项滚进可视区（列表超高时才有实际位移）。
  useEffect(() => {
    if (!slashOpen) return
    slashRef.current?.querySelector('[data-on="1"]')?.scrollIntoView({ block: 'nearest' })
  }, [slashCur, slashOpen])

  /** 采纳候选：写回 `/name `（尾随空格便于接着补充说明，发送前会被 trim），光标留在末尾。 */
  const applySlash = (c: SlashCommand): void => composer.setText(`/${c.name} `, true)

  const name = owner?.name ?? t('cf.assistant')
  // 回合进行中：输入框里的文字会插入当前这一轮，占位提示说明送达时机。
  const placeholder = streaming
    ? t('cf.insert.placeholder').replace('{name}', name)
    : locale === 'en'
      ? `Message ${name}…`
      : `跟 ${name} 说点什么…`
  const supported = pending.filter((p) => p.supported)
  const canSend = Boolean(input.trim()) || supported.length > 0
  // 回合进行中有文字：唯一的按键是「发送」（插入当前轮）。只插文字，待发附件留在输入框里随下一条消息发出。
  const canInsert = streaming && Boolean(input.trim())
  /** 上一次插入的时刻：插入后输入框清空、同一位置随即变成停止键，短时间内不认停止，防双击把任务停掉。 */
  const insertedAtRef = useRef(0)
  const stopTurn = (): void => {
    if (Date.now() - insertedAtRef.current < 600) return
    onStop()
  }
  const mounted = Boolean(focusRoot)

  // 挂载工作区（放在输入区工具条，取代原顶部头部的入口）：仅未挂载态的 chip 调用，选了才挂载，取消则保持现状。
  // 已挂载态不提供直接更换（见 WorkspaceMenu），卸载由尾随的 ✕ 图标承担，避免「取消对话框＝卸载」的意外语义。
  const pickWorkspace = (): void => {
    void (async () => {
      const r = await window.Pal.fs.openFolder()
      if (r) onMount(r.path)
    })()
  }

  // 新增附件并入 pending：不支持 / 过大的不加入（加了也发不出去），toast 说明哪些被跳过；按路径去重。
  const addPicked = (picked: Picked[]): void => {
    const bad = picked.filter((p) => !p.supported)
    if (bad.length) {
      const names = bad.map((p) => p.name).join(locale === 'en' ? ', ' : '、')
      toast.show({ variant: 'warning', message: t('cf.attachSkipped').replace('{names}', names) })
    }
    setPending((prev) => {
      const seen = new Set(prev.map((p) => p.path))
      const out = [...prev]
      for (const p of picked) {
        if (!p.supported || seen.has(p.path)) continue
        seen.add(p.path)
        out.push(p)
      }
      return out
    })
  }

  const pickFiles = async (): Promise<void> => {
    if (streaming) return
    addPicked((await window.Pal.fs.pickAttachments()) as Picked[])
  }

  // 粘贴 / 拖入的文件：与「附加文件」同一条链路（主进程落盘授权 → pending 附件条）。
  // 只交字节不交路径，渲染层仍无法让主进程读任意路径；拖入的文件夹读不出字节，直接跳过。
  const addFiles = async (files: File[]): Promise<void> => {
    const results = await Promise.allSettled(
      files.map(async (f) =>
        window.Pal.fs.pasteAttachment({
          name: f.name,
          mime: f.type,
          size: f.size,
          // 超过最大附件上限（PDF 20MB）的不读字节，只报体积，主进程据此判「过大」。
          data: f.size > 20 * 1024 * 1024 ? null : new Uint8Array(await f.arrayBuffer())
        })
      )
    )
    // 同一文件多次粘贴 / 拖入只留一份：主进程按内容去重、重复的返回同一路径，addPicked 按路径过滤即可。
    addPicked(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value as Picked] : [])))
  }

  // 剪贴板带纯文本时一律按文本粘贴——Word / Excel 复制内容会顺带一张渲染图，不能把它变成附件。
  const onPaste = (e: ClipboardEvent): boolean => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (!files.length || e.clipboardData?.getData('text/plain')) return false
    e.preventDefault()
    if (!streaming) void addFiles(files)
    return true
  }

  // 拖入文件：整个窗口都可放下，一律转成附件。Chromium 对未拦截的文件拖放默认「打开该文件」
  // （导航离开应用），故凡带文件的 dragover / drop 都 preventDefault；回复中只拦截不附加，同粘贴。
  const addFilesRef = useRef(addFiles)
  addFilesRef.current = addFiles
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => Boolean(e.dataTransfer?.types.includes('Files'))
    const onDragOver = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = streamingRef.current ? 'none' : 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (files.length && !streamingRef.current) void addFilesRef.current(files)
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const removePending = (path: string): void =>
    setPending((prev) => prev.filter((p) => p.path !== path))

  // 插入当前轮：清空输入框交给主进程，当前步骤结束后送达；没插进去（原因已 toast）就把文字放回。
  const insertNow = (): void => {
    const text = composer.getText()
    // /compact、/rewind 是本地指令，回合进行中用不了，也不该当成消息插进去。
    if (!text.trim() || /^\/(compact|rewind)$/i.test(text.trim())) return
    const sid = sessionId
    insertedAtRef.current = Date.now()
    composer.setText('')
    composer.clearHistory()
    void onInsert(text).then((ok) => {
      if (!ok) restoreToComposer(sid, text)
    })
  }

  const submit = (): void => {
    if (streaming) {
      insertNow()
      return
    }
    const text = composer.getText()
    const atts = pending.filter((p) => p.supported)
    if (!text.trim() && atts.length === 0) return
    // /rewind 纯渲染层指令：打开回滚面板、不发消息；此刻不可用则原样留在输入框。
    if (text.trim().toLowerCase() === '/rewind' && atts.length === 0) {
      if (onRewind()) composer.setText('')
      return
    }
    const prevPending = pending
    const sid = sessionId
    composer.setText('')
    composer.clearHistory()
    setPending([])
    void onSend(
      text,
      atts.map((p) => ({ path: p.path, name: p.name, kind: p.kind as AttachKind }))
    ).then((sent) => {
      // 未发出（未选模型 / 请求失败，原因已 toast）：把草稿放回——但别覆盖用户在此期间新敲的内容；
      // 此间已切到别的会话的，放回原会话的草稿里。
      if (sent) return
      if (sessionRef.current !== sid) {
        if (!composerDrafts.has(sid)) setComposerDraft(sid, { text, pending: prevPending })
        return
      }
      if (!composer.getText()) composer.setText(text)
      setPending((cur) => (cur.length ? cur : prevPending))
    })
  }

  const onKey = (key: ComposerKey, e: KeyboardEvent): boolean => {
    const plain = !e.shiftKey && !e.ctrlKey && !e.altKey
    // 「/ 指令」联想打开时这几个键先归联想；其余（含 Shift+Enter 换行）照旧落到输入框。
    if (slashOpen) {
      if (plain && (key === 'down' || key === 'up')) {
        e.preventDefault()
        const d = key === 'down' ? 1 : -1
        setSlashSel((i) => {
          const n = slashMatches.length
          return (Math.min(i, n - 1) + d + n) % n
        })
        return true
      }
      if (key === 'tab' || (plain && key === 'enter')) {
        e.preventDefault()
        const pick = slashMatches[slashCur]
        if (pick) applySlash(pick)
        return true
      }
      if (key === 'escape') {
        e.preventDefault()
        setSlashOff(true)
        return true
      }
    }
    // 双击 Esc（仅空输入框、无待发附件时）打开回滚面板；联想浮层开着时 Esc 已在上面被它吃掉。
    if (key === 'escape' && plain && !input.trim() && pending.length === 0 && !streaming) {
      const now = Date.now()
      if (now - lastEscRef.current <= 500) {
        lastEscRef.current = 0
        e.preventDefault()
        onRewind()
        return true
      }
      lastEscRef.current = now
      return false
    }
    if (key !== 'enter' || !plain) return false // 其余交给编辑器（Shift+Enter 换行）
    e.preventDefault()
    submit()
    return true
  }

  // 开头 `/name` 会不会生效（决定是否上色）：/compact、/rewind 须整条只有它且无附件（同 submit 与 store 的拦截）；
  // 其余按本角色可用技能的显示名或文件夹名、不分大小写匹配（同主进程 loadSkillInstructionsByName）。
  const noAtts = supported.length === 0
  const isToken = (name: string, whole: string): boolean => {
    const n = name.toLowerCase()
    if ((n === 'compact' || n === 'rewind') && noAtts && whole.toLowerCase() === `/${n}`) return true
    return skills.some((s) => s.enabled && (s.name.toLowerCase() === n || s.id.toLowerCase() === n))
  }

  const composer = useComposerEditor({
    onChange: (text) => {
      setInput(text)
      setSlashOff(false) // 又动了输入：Esc 收起的联想重新可唤出
    },
    onKey,
    onPaste,
    isToken
  })

  // 判定依据（技能启停、有无附件）变了而文本没变：重新识别一次开头指令。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => composer.refreshToken(), [skills, noAtts])

  // 草稿按会话分开：进入会话（含挂载）换上它的草稿，没有则清空；离开（切换会话或卸载，如进入选择删除）时
  // 把当前内容存到它名下。撤销历史一并清掉，免得撤销把别的会话的内容找回来。用 layout effect，切过去时
  // 不会先闪一下上一个会话的文字。
  useLayoutEffect(() => {
    const draft = composerDrafts.get(sessionId)
    setComposerDraft(sessionId, null)
    composer.setText(draft?.text ?? '')
    composer.clearHistory()
    setPending(draft?.pending ?? [])
    return () => {
      const text = composer.getText()
      const kept = pendingRef.current
      if (text.trim() || kept.length) setComposerDraft(sessionId, { text, pending: kept })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // 登记为「正在显示的输入框」：撤回或退回的插入消息若属于本会话，直接放回这里（排在已有内容之前）。
  useLayoutEffect(() => {
    const entry = {
      sessionId,
      restore: (text: string): void => {
        const cur = composer.getText()
        composer.setText(cur.trim() ? `${text}\n\n${cur}` : text, true)
      }
    }
    liveComposer = entry
    return () => {
      if (liveComposer === entry) liveComposer = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  return (
    <div className="cf-composer">
      {/* 回到最新：仅当用户上滚离开底部且已有消息时浮现，锚在输入区正上方居中 */}
      {showJump && (
        <button
          className="cf-jump"
          type="button"
          onClick={onJump}
          title={t('chat.jumpToLatest')}
          aria-label={t('chat.jumpToLatest')}
        >
          <ChevronDown size={18} />
        </button>
      )}
      <div className="cf-composer__inner">
        {slashOpen && (
          <div className="cf-slash" ref={slashRef}>
            <div className="cf-slash__list" role="listbox" aria-label={t('cf.slash.title')}>
              {slashMatches.map((c, i) => {
                const on = i === slashCur
                return (
                  <button
                    key={`${c.kind}:${c.name}`}
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-on={on ? '1' : undefined}
                    className={`cf-slash__item${on ? ' is-on' : ''}`}
                    title={c.desc}
                    // 鼠标按下即采纳：抢在 blur 之前，输入框不失焦、光标不丢。
                    onMouseDown={(e) => {
                      e.preventDefault()
                      applySlash(c)
                    }}
                    onMouseEnter={() => setSlashSel(i)}
                  >
                    {c.kind === 'skill' ? (
                      <Puzzle size={14} />
                    ) : c.name === 'rewind' ? (
                      <RotateCcw size={14} />
                    ) : (
                      <Shrink size={14} />
                    )}
                    <span className="cf-slash__name">{`/${c.name}`}</span>
                    <span className="cf-slash__desc">{c.desc}</span>
                  </button>
                )
              })}
            </div>
            <div className="cf-slash__hint">{t('cf.slash.hint')}</div>
          </div>
        )}
        {/*
         * 输入框上方的胶囊排：待办清单、后台任务、浏览网页、插入对话，各自有内容才出现。
         * 实际先后按出现的先后（新出现的在最右，见 useDockOrder）；这里的书写顺序只在切会话、几枚同时出现时起作用——
         * 越常驻的越靠左，插入对话最短暂、最需要用户留意，放最后。
         */}
        <div className="cf-dock">
          <TodoCapsule />
          <BackgroundCapsule />
          <BrowserCapsule sessionId={sessionId} />
          <InsertCapsule sessionId={sessionId} />
        </div>
        <div className="cf-box">
          {/* 拖拽手柄压在输入框上边框：向上拖加高输入框。 */}
          <ResizeHandle
            axis="y"
            className="cf-resizer--box"
            value={boxH}
            title={t('cf.resizeComposer')}
            onChange={(v) => setComposerH(clampComposer(v, window.innerHeight))}
            onCommit={() => saveLayout({ composerHeight: boxHRef.current })}
            onReset={() => {
              setComposerH(COMPOSER_DEFAULT)
              saveLayout({ composerHeight: undefined })
            }}
          />
          {pending.length > 0 && (
            <div className="cf-composer__files">
              {pending.map((p) => (
                <span
                  key={p.path}
                  className={`attach-chip${p.supported ? '' : ' is-bad'}`}
                  title={p.reason || p.name}
                >
                  {iconFor((p.supported ? p.kind : 'text') as AttachKind)}
                  <span className="attach-chip__name">{p.name}</span>
                  <button
                    className="attach-chip__x"
                    onClick={() => removePending(p.path)}
                    title={t('cf.cancel')}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* 输入区：Lexical 接管的 contentEditable（子节点归编辑器管，React 不渲染内容）；占位提示叠在其上。 */}
          <div className="cf-draft" style={{ height: boxH }}>
            <div
              ref={composer.rootRef}
              className="cf-draft__input"
              contentEditable
              role="textbox"
              aria-multiline
              aria-label={placeholder}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
            />
            {composer.empty && <div className="cf-draft__ph">{placeholder}</div>}
          </div>
          <div className="cf-box__bar">
            <button
              className="cf-iconbtn"
              title={t('cf.attach')}
              aria-label={t('cf.attach')}
              onClick={() => void pickFiles()}
            >
              <Paperclip size={16} />
            </button>
            {mounted && focusRoot ? (
              <span className="cf-wschip cf-wschip--mounted is-on">
                <WorkspaceMenu root={focusRoot} />
                <GitWidget root={focusRoot} streaming={streaming} />
                <button
                  type="button"
                  className="cf-wschip__x"
                  title={t('cf.unmountHint')}
                  aria-label={t('cf.unmountHint')}
                  onClick={() => onMount(null)}
                >
                  <X size={13} />
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="cf-wschip"
                title={t('cf.mountHint')}
                onClick={pickWorkspace}
              >
                <FolderPlus size={15} />
                {t('cf.mountWorkspace')}
              </button>
            )}
            <ModelPicker />
            <EffortPicker />
            {/* 回合进行中只有一枚键：输入框有文字＝「发送」（插入当前轮），空＝「停止」（只放图标，与发送同宽不跳动）。
                有文字时不出停止，要停先清空输入框。 */}
            {streaming ? (
              canInsert ? (
                <button
                  className="cf-send"
                  type="button"
                  title={t('cf.insert.hint').replace('{name}', name)}
                  onClick={insertNow}
                >
                  {t('cf.send')}
                </button>
              ) : (
                <button
                  className="cf-send is-stop"
                  type="button"
                  title={t('chat.stop')}
                  aria-label={t('chat.stop')}
                  onClick={stopTurn}
                >
                  <Square size={14} fill="currentColor" />
                </button>
              )
            ) : (
              <button className="cf-send" type="button" disabled={!canSend} onClick={submit}>
                {t('cf.send')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function ModelPicker(): React.JSX.Element {
  const { t } = useI18n()
  const { activeModel, providers, setActiveModel } = useModels()
  const { currentBinding, setSessionModel } = useChat()
  const [open, setOpen] = useState(false)
  // 只列对话模型（purpose==='llm'）：决策模型（如 Jev）不生成文本，绝不可被选为对话模型。
  const groups = providers
    .filter((p) => p.enabled && (p.purpose ?? 'llm') === 'llm')
    .map((p) => ({ p, models: p.models.filter((m) => m.enabled) }))
    .filter((g) => g.models.length > 0)
  // 本对话生效模型：解析对话覆盖层的 model 引用 `"pid:mid"`；空/非法/已删除 → 回落全局 activeModel。
  const selected = useMemo(() => {
    const ref = currentBinding.model
    if (ref) {
      const idx = ref.indexOf(':')
      if (idx > 0) {
        const pid = ref.slice(0, idx)
        const mid = ref.slice(idx + 1)
        const p = providers.find((x) => x.id === pid)
        const m = p?.models.find((x) => x.id === mid)
        if (p && m) return { pid, mid, name: m.name, accent: p.accent }
      }
    }
    if (activeModel)
      return {
        pid: activeModel.provider.id,
        mid: activeModel.model.id,
        name: activeModel.model.name,
        accent: activeModel.provider.accent
      }
    return null
  }, [currentBinding.model, providers, activeModel])
  return (
    <div className="model-pick">
      <button
        className={`chip${open ? ' is-open' : ''}`}
        type="button"
        title={t('chat.selectModel')}
        onClick={() => setOpen((v) => !v)}
      >
        {selected && <span className="chip__dot" style={{ background: selected.accent }} />}
        <span className="chip__label">{selected ? selected.name : t('chat.selectModel')}</span>
        <ChevronDown size={13} className="chip__caret" />
      </button>
      {open && (
        <>
          <div className="model-pick__backdrop" onClick={() => setOpen(false)} />
          <div className="model-pick__menu" role="menu">
            {groups.length === 0 && <div className="model-pick__empty">{t('chat.noModel')}</div>}
            {groups.map(({ p, models }) => (
              <div key={p.id} className="model-pick__group">
                <div className="model-pick__group-head">
                  <span className="model-pick__dot" style={{ background: p.accent }} />
                  <span className="model-pick__group-name">{p.name}</span>
                </div>
                {models.map((m) => {
                  const active = selected?.pid === p.id && selected?.mid === m.id
                  return (
                    <button
                      key={m.id}
                      role="menuitemradio"
                      aria-checked={active}
                      className={`model-pick__item${active ? ' is-active' : ''}`}
                      title={m.name === m.id ? m.id : `${m.name} · ${m.id}`}
                      onClick={() => {
                        // ① 记入本对话属性；② 记为「最近使用」，充当后续新对话未选时的默认。
                        setSessionModel(`${p.id}:${m.id}`)
                        setActiveModel(p.id, m.id)
                        setOpen(false)
                      }}
                    >
                      <span className="model-pick__name">{m.name}</span>
                      {active && <Check size={14} className="model-pick__check" />}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 思考等级选择器（紧挨模型选择器，复用其 model-pick / chip 类）。与模型同一套语义：切换只改本对话并立即
 * 落库（setSessionEffort），同时记为「最近使用」（setActiveEffort），尚未定格的对话（新对话）沿用它。
 * 只列本对话生效模型支持的档（模型能力内置表，见 shared/effort.ts）；模型不支持思考等级则整个隐藏。
 * 「默认」= 不发任何思考参数；各档如何映射到各家协议、不支持时如何自愈，见主进程 providers/* 与 chat.ts。
 */
function EffortPicker(): React.JSX.Element | null {
  const { t } = useI18n()
  const { activeEffort, setActiveEffort, activeModel, providers } = useModels()
  const { currentBinding, setSessionEffort } = useChat()
  const [open, setOpen] = useState(false)
  // 本对话生效模型（同 ModelPicker：本对话已选 → 否则回落最近使用）。选择器只列对话模型，adapter 必属三协议之一。
  const active = findActive(providers, currentBinding.model ?? null) ?? activeModel
  const adapter = active?.provider.adapter as EffortAdapter | undefined
  const modelId = active?.model.id
  const levels = adapter && modelId ? supportedEffortLevels(adapter, modelId) : []
  if (!adapter || !modelId || levels.length === 0) return null
  // 只能开、不能调档的模型（如通义 qwen-plus、Kimi K2）：唯一的一档显示为「开启」。
  const toggle = isToggleEffort(adapter, modelId)
  const nameOf = (lv: EffortLevel): string =>
    toggle && lv !== 'default' ? t('chat.effort.on') : t(`chat.effort.levels.${lv}`)
  const hintOf = (lv: EffortLevel): string =>
    toggle && lv !== 'default' ? t('chat.effort.onHint') : t(`chat.effort.hints.${lv}`)
  // 本对话存的档位（尚未定格时为「最近使用」）收敛到该模型支持的档来显示——与主进程实际发送的一致；
  // 存值本身不改，换回支持该档的模型即恢复。
  const current = clampEffort(adapter, modelId, currentBinding.effort ?? activeEffort)
  const label = nameOf(current)
  const options: EffortLevel[] = ['default', ...levels]
  return (
    <div className="model-pick">
      <button
        className={`chip${open ? ' is-open' : ''}`}
        type="button"
        title={`${t('chat.effort.title')}：${label}`}
        aria-label={`${t('chat.effort.title')}：${label}`}
        onClick={() => setOpen((v) => !v)}
      >
        <Lightbulb size={13} />
        <span className="chip__label">{label}</span>
        <ChevronDown size={13} className="chip__caret" />
      </button>
      {open && (
        <>
          <div className="model-pick__backdrop" onClick={() => setOpen(false)} />
          <div className="model-pick__menu" role="menu">
            <div className="model-pick__group">
              <div className="model-pick__group-head">
                <span className="model-pick__group-name">{t('chat.effort.title')}</span>
              </div>
              {options.map((lv) => {
                const active = lv === current
                return (
                  <button
                    key={lv}
                    role="menuitemradio"
                    aria-checked={active}
                    className={`model-pick__item${active ? ' is-active' : ''}`}
                    onClick={() => {
                      // ① 记入本对话属性；② 记为「最近使用」，充当后续新对话的默认。
                      setSessionEffort(lv)
                      setActiveEffort(lv)
                      setOpen(false)
                    }}
                  >
                    <span className="model-pick__name cf-effort__text">
                      <span>{nameOf(lv)}</span>
                      <span className="cf-effort__hint">{hintOf(lv)}</span>
                    </span>
                    {active && <Check size={14} className="model-pick__check" />}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

import { AddMenu, ContextMenu, DragBar, useHoverMenu, useRelativeTime } from './shell-bits'
import { DEFAULT_PERSONA_ID, IS_MAC, basename, clipName } from './shared-ui'
import { useComposerEditor, type ComposerKey } from './composer-editor'
import { SessionUsageBar } from './SessionUsageBar'
// 关于页的应用图标：直接用安装包图标的源文件，图形只维护一份
import './redesign.css'
import type { Persona } from '../mock/extensions'
import type {
} from '../../../preload'
import { useBrowserState } from '../features/browser/shared'
import { ModelSetupCard } from '../features/chat/ModelSetupCard'
import {
  useChat,
  type AttachKind,
  type ChatBlock,
  type ChatMessage,
  type SendAttachment,
  type SessionLiveState,
  type SessionMeta,
  type StreamStatus
} from '../store/chat'
import { rolesAllow, useExtensions } from '../store/extensions'
import { findActive, hasUsableModel, useModels } from '../store/models'
import {
  clampEffort,
  isToggleEffort,
  supportedEffortLevels,
  type EffortAdapter
} from '../../../shared/effort'
import { useTasks } from '../store/tasks'
import { useI18n } from '../i18n/i18n'
import { useDialog } from '../components/DialogProvider'
import { useToast } from '../components/ToastProvider'
import {
  ICONRAIL_W,
  ICONRAIL_W_MAC,
  ResizeHandle,
  SIDEBAR_COLLAPSE_AT,
  SIDEBAR_DEFAULT,
  clampSidebar,
  loadLayout,
  saveLayout,
  useViewport
} from './resizable'
import {
  PersonaFace,
  USER_AVATAR_SEED,
  parseAvatarSpec,
} from '../components/humation'
import {
  BlockView,
  CompactionNotice,
  DeliveryCards,
  LiveThinkingWindow,
  ProcessFold,
  StatusIndicator,
  Timeline,
  currentSteps,
  deriveActivity,
  groupBlocks,
  hasProcess,
  splitProcess
} from '../features/chat/blocks'
import { ProfilePanel } from './ProfilePanel'
import { RewindModal } from './RewindModal'
import { useProfile } from '../store/profile'

/**
 * 「对话优先」外壳（已接真实 store）。
 *
 * 形态（借鉴 IM 应用的单人对话）：
 *  - 左栏两个 tab：消息（对话列表，来自 useChat().sessions）/ 角色（花名册，来自 useExtensions().personas）
 *  - 一对话一身份：中列是「我 ↔ 某一个角色」的单人对话，头顶显示当值角色（persona 单选、首发绑定后不可改）
 *  - 角色可查看资料、可反复发起对话；「添加/编辑角色」走 PersonaEditor（round-trip upsertPersona）
 *  - 工作区可选：头部一个 chip，挂了文件夹就「聚焦中」（focusRoot），没挂就是全机通用助手
 *  - 动手全内联：复用 features/chat/blocks 的 BlockView / StatusIndicator / deriveActivity 渲染工具/权限/思考/子智能体
 *
 * 安全不变式全程不动：角色不收窄工具，每次调用都过同一闸门；聚焦挂载复用 fs.openFolder 的
 * trustRoot；Agent 文件读写与命令执行不设任何限制。旧壳（PREVIEW_CHAT_FIRST=false）零回归靠后端 personaId 缺省 gate。
 */

/* ============================ 小工具 ============================ */

/** 附件类型 → 图标。 */




/**
 * macOS 左上角红绿灯（关闭/最小化/全屏）当前是否可见：可见时图标栏加宽并在顶部为它让位。
 * 全屏时系统会隐藏红绿灯，此时回到常规布局；其他平台恒为 false。
 */
function useTrafficLights(): boolean {
  const [fullScreen, setFullScreen] = useState(false)
  useEffect(() => {
    if (!IS_MAC) return
    let alive = true
    const off = window.Pal.window.onFullScreen(setFullScreen)
    void window.Pal.window.isFullScreen().then((on) => alive && setFullScreen(on))
    return () => {
      alive = false
      off()
    }
  }, [])
  return IS_MAC && !fullScreen
}

/**
 * 花名册手动排序不再按名称（角色可改名 → 名称排序会跳位）：改由用户拖拽 / 置顶决定，顺序以 id 列表
 * 持久化（对标微信等 IM 的联系人手动排序）。此纯函数把「把 dragId 放到 targetId 之前/之后」算成新的 id 序列。
 */
function reorderIds(
  ids: string[],
  dragId: string,
  targetId: string,
  place: 'before' | 'after'
): string[] {
  if (dragId === targetId) return ids
  const without = ids.filter((id) => id !== dragId)
  const ti = without.indexOf(targetId)
  if (ti < 0) return ids
  without.splice(place === 'before' ? ti : ti + 1, 0, dragId)
  return without
}

/** 距底 ≤ 此像素即视为「贴住底部」，留缓冲避免临界抖动。 */
const BOTTOM_THRESHOLD = 64

/**
 * 长对话分段渲染：打开对话时只渲染最后 WINDOW_TURNS 轮，滚到离已渲染内容的顶边（或跳转后的底边）
 * 不足 LOAD_MORE_PX 时再补一段同样多的轮。整条历史一次挂载的话，Markdown 解析、代码高亮与整页布局都随
 * 长度线性增长：几百轮的对话每次切换都要卡十几秒，上千轮能把渲染进程撑崩。
 */
const WINDOW_TURNS = 10
const LOAD_MORE_PX = 600

/**
 * 右侧「对话轮次索引」面板参数。纯渲染层视觉常量：不持久化、不给设置项。
 * 面板只索引用户消息（对话的锚点），轮次少时不出现，避免短对话占位。
 */
/** 触发阈值：用户消息条数 ≥ 此值才渲染面板。 */
const TOC_MIN_TURNS = 4
/**
 * 当前轮判定线：距滚动容器顶边的偏移（px），最后一条越过它的用户消息即当前轮。
 * 须与 {@link TOC_JUMP_PAD} 保持接近——二者之差若超过相邻两条用户消息的最小间距，
 * 跳转落位后下一轮会立刻越线把高亮抢走，表现为「点了 A 却亮 B」。
 */
const TOC_ACTIVE_OFFSET = 48
/** 跳转后目标消息距容器顶边的留白（px）。 */
const TOC_JUMP_PAD = 16
/** 索引项保留的文本长度上限（DOM 体积护栏）；列表里的视觉截断交给 CSS line-clamp。 */
const TOC_TEXT_MAX = 200
/**
 * 面板一屏最多显示的索引条数，多出的在列表内部滚动（条数本身不设上限）。
 * 不做成「条数 × 固定行高」的估算：索引项 1~2 行不定高，收起态只剩刻度更矮，
 * 必须实测第 N 条的底边才不会多显或少显一条。
 */
const TOC_VISIBLE_MAX = 10

/** 系统默认角色 id（首启种子「Pal」，id 恒为 general）：兼作兜底身份，且不允许删除。 */

/** 一次挑选返回的附件（与 preload PickedAttachment 结构一致）。 */



/* ============================ 顶层外壳 ============================ */
/** 图标栏的 tab：对话 / 角色 / 定时任务 / 机器人。 */
type RailTab = 'chats' | 'roster' | 'tasks' | 'bots'

export function ChatFirstShell(): React.JSX.Element {
  const {
    sessions: storedSessions,
    currentSessionId,
    messages,
    streaming,
    streamStatus,
    sessionStates,
    send,
    stop,
    newSession,
    selectSession,
    deleteSession,
    renameSession,
    setArchived,
    deleteSessions,
    deleteTurns,
    currentBinding,
    draftSession,
    mountFocus,
    respondAsk,
    respondPlan,
    respondMount,
    onInsertsReturned
  } = useChat()
  const { personas, remove, reorderPersonas } = useExtensions()
  const { tasks } = useTasks()
  const { t, locale } = useI18n()
  const dialog = useDialog()
  const toast = useToast()

  // 回合被停止或出错时还没送达的插入消息：放回所属会话的输入框（正在看就直接放进去，否则进那个会话的草稿）。
  useEffect(() => onInsertsReturned(restoreToComposer), [onInsertsReturned])

  const [railTab, setRailTab] = useState<RailTab>('chats')
  // 图标栏「对话」按钮的红点：其他对话有新消息或待你处理时亮起（与头像红点同口径）。只认列表里看得到的对话：
  // 删除正在跑的对话时回合被中止，随后的 done 仍会给它记一条未读；已归档的不再提醒（含仍待确认的名片）。
  // 不过滤就成了点开找不到的红点。
  const chatAlert = useMemo(() => {
    const visible = new Set(storedSessions.filter((s) => !s.archived).map((s) => s.id))
    return Object.entries(sessionStates).some(
      ([id, st]) => id !== currentSessionId && visible.has(id) && (st.unread || st.attention)
    )
  }, [sessionStates, currentSessionId, storedSessions])
  // 左侧对话面板宽（可拖动）：存的是用户意图值，渲染时按窗口宽再夹取——窗口缩小时自动收窄、放大后复原。
  const viewport = useViewport()
  const trafficLights = useTrafficLights()
  const railW = trafficLights ? ICONRAIL_W_MAC : ICONRAIL_W
  const [sidebarW, setSidebarW] = useState(() => loadLayout().sidebarWidth ?? SIDEBAR_DEFAULT)
  const sidebarShown = clampSidebar(sidebarW, viewport.w, railW)
  const sidebarRef = useRef(sidebarShown)
  sidebarRef.current = sidebarShown
  // 收起会话列表：只有「对话」页能收起（角色页右侧只是资料卡，收起没意义；定时任务 / 机器人页本就占满）。
  // 收起状态记住（切页再回来、重启都保持）。收起时悬停「对话」图标，列表整块浮在对话区上方（peek），
  // 点会话即切过去（列表留着，可以接着点别的，鼠标离开才收回）——不用先展开就能换对话。
  const [listCollapsed, setListCollapsed] = useState(() => loadLayout().sidebarCollapsed ?? false)
  const collapsed = railTab === 'chats' && listCollapsed
  const [peek, setPeek] = useState(false)
  const peekTimer = useRef<number | null>(null)
  const clearPeekTimer = (): void => {
    if (peekTimer.current !== null) window.clearTimeout(peekTimer.current)
    peekTimer.current = null
  }
  const setCollapsed = (next: boolean): void => {
    clearPeekTimer()
    setPeek(false)
    setListCollapsed(next)
    saveLayout({ sidebarCollapsed: next || undefined })
  }
  // 浮出：停 0.2 秒才浮出（鼠标路过不弹）；离开图标与列表 0.15 秒才收回（从图标移到列表要穿过图标栏右侧
  // 约 9px 的空白；再长收回就显得拖沓。同「新建对话」悬停菜单的 0.14 秒）。
  // 已浮出时再进入只取消待收回、不排定时器——否则点了会话（收回）后排着的定时器会把它重新打开。
  const peekEnter = (): void => {
    if (!collapsed) return
    clearPeekTimer()
    if (!peek) peekTimer.current = window.setTimeout(() => setPeek(true), 200)
  }
  // 进入浮出的列表：只取消待收回。浮出只由悬停「对话」图标触发——收起过程中（或刚拖动收起）鼠标还停在
  // 列表上，不该因此又浮出来。
  const peekHover = useRef(false)
  const peekStay = (): void => {
    peekHover.current = true
    if (peek) clearPeekTimer()
  }
  // 正在浮出列表的输入框（搜索框、菜单里的筛选框）里打字：打字时鼠标常挪开、输入法候选框也会盖到指针上，
  // 这时不因鼠标离开而收回，等焦点离开输入框再说（见 peekFocusOut）。
  const typingInPeek = (): boolean => {
    const el = document.activeElement
    return el instanceof HTMLInputElement && el.closest('.cf-rail.is-peek') !== null
  }
  const peekLeave = (): void => {
    peekHover.current = false
    if (!collapsed) return
    clearPeekTimer()
    peekTimer.current = window.setTimeout(() => {
      if (!typingInPeek()) setPeek(false)
    }, 150)
  }
  // 焦点离开浮出列表里的输入框（点了别处、切走窗口）：鼠标也不在列表上就收回。
  const peekFocusOut = (): void => {
    if (peek && !peekHover.current) setPeek(false)
  }
  useEffect(() => clearPeekTimer, [])
  // 离开对话页：收回浮出列表。切换对话不收回——可以连着点开几个看，鼠标离开列表才收回。
  useEffect(() => {
    clearPeekTimer()
    setPeek(false)
  }, [railTab])
  // Esc 收回浮出列表；Ctrl+B / ⌘B 在对话页收起 / 展开会话列表。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && peek) {
        clearPeekTimer()
        setPeek(false)
      } else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyB' && railTab === 'chats') {
        e.preventDefault()
        setCollapsed(!listCollapsed)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peek, railTab, listCollapsed])
  /**
   * 「角色」tab 当前选中的角色（右侧显示其资料卡）。仅当 railTab==='roster' 时生效——右侧内容整体由
   * railTab 决定，故「消息」tab 与「角色」tab 各自记住自己的右侧（当前对话 / 当前角色），彼此独立、
   * 切 tab 时右侧随之切换（见下方渲染分支）。
   */
  const [viewPersonaId, setViewPersonaId] = useState<string | null>(null)
  /**
   * 「定时任务」tab 的外部导航意图：对话里点已创建任务名片「查看任务」时置为目标任务 id，切到 tasks tab
   * 后由 TasksPane 消费（直选该任务详情）并回清为 null——使之后手动进本 tab 仍复位到未选中空态。
   */
  const [tasksTarget, setTasksTarget] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 打开设置时落在哪一页（资料卡的「能力」直达设置 › 扩展，可直接进某项详情）。
  const [settingsInit, setSettingsInit] = useState<SettingsInit>({})
  const openSettings = (init: SettingsInit = {}): void => {
    setSettingsInit(init)
    setSettingsOpen(true)
  }
  /** 非空时打开角色编辑器（Part G）。 */
  const [editor, setEditor] = useState<EditorState | null>(null)
  /**
   * 输入框预填（一次性、不自动发送）：用于「通过对话添加角色」——把引导语放进输入框交由用户
   * 自己审阅/修改后发送，而非替他发出。nonce 使相同文本也能重复触发；Composer 消费后回调置空。
   */
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; nonce: number } | null>(
    null
  )

  /** 兜底身份：优先 general，其次首个（花名册非空时）。 */
  const defaultPersona = useMemo(
    () => personas.find((p) => p.id === DEFAULT_PERSONA_ID) ?? personas[0],
    [personas]
  )
  const defaultPersonaId = defaultPersona?.id

  // 对话归属的角色：未绑定、或绑定的角色已不存在（如手动删了角色文件）一律算默认角色，与主进程执行时一致
  // （见 personas.ts resolvePersonaId）。列表头像、筛选、搜索、资料卡都读这里；只改显示，不改对话里存的绑定。
  const sessions = useMemo(() => {
    if (!defaultPersonaId) return storedSessions
    const ids = new Set(personas.map((p) => p.id))
    const known = (s: SessionMeta): boolean => !!s.personaId && ids.has(s.personaId)
    return storedSessions.every(known)
      ? storedSessions
      : storedSessions.map((s) => (known(s) ? s : { ...s, personaId: defaultPersonaId }))
  }, [storedSessions, personas, defaultPersonaId])

  // 说明（去掉了旧的「自动绑定通用」effect）：从前只要当前对话未绑定且为空，就自动落一条绑定到默认身份
  // 的空会话——这会在「删空左侧所有对话」后立刻重建一条，导致永远无法真正清空、也进不了「快速开启」空态。
  // 现在改为：空对话由用户显式动作（点头像 / ＋开始对话 / 通过对话添加）才创建并落盘（见 startWith）；
  // 左侧无任何对话时，中列改渲染 QuickStart（列出全部角色，点头像直接开聊）。

  /** 当值身份（当前对话绑定的 persona；未绑定或已不存在时为默认角色，同上）。 */
  const owner = personas.find((p) => p.id === currentBinding.personaId) ?? defaultPersona

  // 左侧列表数据源：把「草稿会话」（尚未落库的空对话）并到已落库会话之前——与角色开启新对话时，该对话
  // 立即出现在聊天列表（内容可为空）。草稿 id 必不在 sessions 中（见 store.draftSession），无需去重；
  // 首发落库后 draftSession 转 null、真值并入 sessions，列表项按同 id 无缝接管。
  const railSessions = useMemo(
    () => (draftSession ? [draftSession, ...sessions] : sessions),
    [draftSession, sessions]
  )
  // 列表里一条对话都没有（已归档的不算）、右侧也没开着已归档对话 → 右侧显示快速开启页。
  const noThreads = !railSessions.some((s) => !s.archived || s.id === currentSessionId)

  // 打开某对话 → 切到「消息」tab（右侧内容随 railTab 切换）。不清 viewPersonaId：让「角色」tab 记住
  // 自己上次查看的角色，两个 tab 的右侧彼此独立。
  const openThread = (id: string): void => {
    selectSession(id)
    setRailTab('chats')
  }
  // 查看某角色资料 → 切到「角色」tab 并选中该角色（右侧随之显示其资料卡）。
  const openProfile = (personaId: string): void => {
    setViewPersonaId(personaId)
    setRailTab('roster')
  }
  /** 点角色名片 → 打开预填的编辑器（propose 态，接受才落盘）。 */
  const openProposal = (block: Extract<ChatBlock, { kind: 'agentcard' }>): void =>
    setEditor({ mode: 'propose', draft: block.draft, toolId: block.id })
  /**
   * 点已创建定时任务名片「查看任务」→ 切到「定时任务」tab 并直选该任务详情。
   * 不再打开其独占会话：会话要等任务首次触发才由 runScheduledTurn 建，创建后立即打开必为空；
   * 查看任务详情（日程 / 授权 / 运行历史）才是此刻有意义的落点。
   */
  const openAutotask = (taskId: string): void => {
    setTasksTarget(taskId)
    setRailTab('tasks')
  }
  // 主进程导航意图（tasks:navigate）：通知点击带 `{sessionId}` → 打开该对话（定时任务独占会话 / 刚回复完的对话）并回消息视图；
  // 托盘「定时任务概览」带 `{pane:'tasks'}` → 切到 Tasks 标签。窗口从托盘唤起时随即落到目标视图。
  useEffect(() => {
    const off = window.Pal?.tasks?.onNavigate?.((payload) => {
      if (payload?.sessionId) {
        selectSession(payload.sessionId)
        setRailTab('chats')
      } else if (payload?.pane === 'tasks') {
        setRailTab('tasks')
      }
    })
    return () => off?.()
  }, [selectSession])

  /** 与某身份发起新对话：新建空会话（首发落绑定，并快照该身份当时的偏好模型）→ 回到消息视图。 */
  const startWith = (personaId: string): void => {
    newSession(personaId, undefined, personas.find((p) => p.id === personaId)?.model)
    setRailTab('chats')
  }
  /**
   * 右键菜单「新开对话」：以选中对话的**原角色**发起一条全新对话（复用 startWith → 新建空会话并
   * 快照该角色当前偏好模型）。原角色已删（或为旧无绑定会话）时回落兜底身份，绝不无绑定裸建。
   */
  const newChatFromThread = (id: string): void => {
    const source = railSessions.find((s) => s.id === id)
    const personaId = source?.personaId ?? defaultPersonaId
    if (personaId) startWith(personaId)
  }
  /**
   * 「通过对话添加角色」：新建一个绑定兜底身份（通常「通用」）的空对话，把引导语**预填进输入框**，
   * 交由用户自己发送（不自动发出）——用户可先审阅/修改，确认后再发起；Agent 收到后一步步引导澄清
   * 需求、最后调 propose_agent 铸名片供确认（不写盘，接受才落盘）。
   */
  const addPersonaByChat = (): void => {
    newSession(defaultPersonaId, undefined, defaultPersona?.model)
    setRailTab('chats')
    setComposerPrefill({ text: t('cf.addByChatPrompt'), nonce: Date.now() })
  }
  /**
   * 「通过对话添加定时任务」：同上，仅把引导语换成定时任务模板（含【时间间隔】【具体任务】占位，
   * 交由用户补全后自己发送）。Agent 收到后照常澄清需求、调 create_task 铸确认名片待批。
   */
  const addTaskByChat = (): void => {
    newSession(defaultPersonaId, undefined, defaultPersona?.model)
    setRailTab('chats')
    setComposerPrefill({ text: t('tasks.addByChatPrompt'), nonce: Date.now() })
  }
  const viewPersona = viewPersonaId ? personas.find((p) => p.id === viewPersonaId) : undefined

  // 右键删除（对话 / 角色）：先弹居中确认框（破坏性 → 红色确认键），确认后才走既有删除通路——
  // 对话经 deleteSession（中止在跑回合 + 落盘删除 + 切到最近会话），角色经 remove('persona')。
  // 标题直接写成「删除对话 xxx ？/删除角色 xxx ？」这一动作问句（比裸标题更醒目），随语言拼装；
  // 名字经 clipName 限长，过长截断补「…」，免得撑宽 / 撑高弹框。
  const deleteThread = (id: string, title: string): void => {
    const name = clipName(title || t('chat.untitled'))
    const heading = locale === 'en' ? `Delete conversation “${name}”?` : `删除对话 ${name} ？`
    void (async () => {
      const ok = await dialog.confirm({
        title: heading,
        message: t('cf.deleteChatConfirm'),
        variant: 'danger',
        confirmText: t('cf.delete')
      })
      if (ok) deleteSession(id)
    })()
  }
  // 重命名对话：居中输入框，预填当前标题并全选。没改不让提交；清空也可提交（= 恢复自动标题）。
  const renameThread = (id: string, title: string): void => {
    void (async () => {
      const next = await dialog.prompt({
        title: t('cf.renameChatTitle'),
        defaultValue: title,
        placeholder: t('cf.renamePlaceholder'),
        confirmText: t('cf.renameChat'),
        validate: (v) => v.replace(/\s+/g, ' ').trim() !== title
      })
      if (next !== null) renameSession(id, next)
    })()
  }
  // 右键归档：从列表移走，提示条带「撤销」。归档的是当前对话时右侧随之打开列表第一条（见 store.setArchived），
  // 撤销则把它重新打开。名字经 clipName 限长，随语言拼装。
  const archiveThread = (id: string, title: string): void => {
    const wasCurrent = id === currentSessionId
    setArchived(id, true)
    const name = clipName(title || t('chat.untitled'))
    toast.show({
      message: locale === 'en' ? `Archived “${name}”` : `已归档「${name}」`,
      action: {
        label: t('cf.undo'),
        onClick: () => {
          setArchived(id, false)
          if (wasCurrent) openThread(id)
        }
      }
    })
  }
  // 按「轮」删除当前对话的选中轮次（同步删上下文）：先弹居中破坏性确认，确认后走 store.deleteTurns。
  // 返回是否已删——Conversation 据此退出选择态并清空选择（未确认则保持选择态供继续调整）。
  const deleteTurnsWithConfirm = async (indices: number[]): Promise<boolean> => {
    if (indices.length === 0) return false
    const heading =
      locale === 'en'
        ? `Delete ${indices.length} selected turn${indices.length > 1 ? 's' : ''}?`
        : `删除选中的 ${indices.length} 轮对话？`
    const ok = await dialog.confirm({
      title: heading,
      message: t('cf.deleteTurnsConfirm'),
      variant: 'danger',
      confirmText: t('cf.delete')
    })
    if (!ok) return false
    await deleteTurns(indices)
    return true
  }
  const deletePersona = (id: string, name: string): void => {
    // 系统默认角色不可删除（UI 侧菜单项已禁用，此处再兜一道，防其他触发路径）。
    if (id === DEFAULT_PERSONA_ID) return
    // 该角色名下已落库的对话（草稿未落库不计），删角色时一并清除；数量用于提示影响面。
    // 定时任务的独占对话不在此列：任务改由 Pal 执行，对话随之改挂 Pal（主进程删角色时处理）。
    const taskSessionIds = new Set(tasks.map((x) => x.sessionId))
    const relatedIds = sessions
      .filter((s) => s.personaId === id && !taskSessionIds.has(s.id))
      .map((s) => s.id)
    const shown = clipName(name)
    const heading = locale === 'en' ? `Delete persona “${shown}”?` : `删除角色 ${shown} ？`
    // 有关联对话 → 提示「同时删除 N 个对话」；无 → 用不涉及对话的简短文案。
    const message =
      relatedIds.length > 0
        ? t('cf.deletePersonaConfirmWithChats').replace('{count}', String(relatedIds.length))
        : t('cf.deletePersonaConfirm')
    void (async () => {
      const ok = await dialog.confirm({
        title: heading,
        message,
        variant: 'danger',
        confirmText: t('cf.delete')
      })
      if (!ok) return
      // 先清对话再删角色：避免出现「角色已删、对话仍引用缺失角色」的空窗渲染。
      if (relatedIds.length > 0) deleteSessions(relatedIds)
      remove('persona', id)
    })()
  }

  return (
    <div
      className={`cf-shell${IS_MAC ? ' is-mac' : ''}${trafficLights ? ' has-traffic-lights' : ''}`}
    >
      {/* 无独立标题栏（微信式）：最小化/最大化/关闭用系统原生窗口控件叠加（titleBarOverlay），
          此处不再自绘按钮，避免与原生按钮重影。拖拽交给图标栏与对话头。 */}
      <div
        className={`cf-body${collapsed && peek ? ' is-peeking' : ''}`}
        style={
          {
            '--cf-rail-w': `${railW}px`,
            '--cf-side': `${collapsed ? 0 : sidebarShown}px`,
            '--cf-side-open': `${sidebarShown}px`
          } as React.CSSProperties
        }
      >
        {/* 面板右缘拖拽手柄（覆盖在分隔线上，绝对定位不占网格单元）；定时任务 tab 的列表列同宽同享。
            对话页：往左拖过下限继续拖即收起（手柄随之卸下、这次拖动结束）。收起后不显示手柄：往外拖要拖够
            距离才生效、中间没有跟手的反馈，展开交给「对话」图标 / Ctrl+B。 */}
        {!collapsed && (
          <ResizeHandle
            axis="x"
            value={sidebarShown}
            title={t('cf.resizeSidebar')}
            style={{ left: `calc(${railW}px + ${sidebarShown}px)` }}
            onChange={(v) => {
              if (railTab === 'chats' && v < SIDEBAR_COLLAPSE_AT) {
                // 收起后手柄卸下、不再走 onCommit：拖到下限前改过的宽度在这里落盘。
                saveLayout({ sidebarWidth: sidebarRef.current })
                setCollapsed(true)
                return
              }
              setSidebarW(clampSidebar(v, window.innerWidth, railW))
            }}
            onCommit={() => saveLayout({ sidebarWidth: sidebarRef.current })}
            onReset={() => {
              setSidebarW(SIDEBAR_DEFAULT)
              saveLayout({ sidebarWidth: undefined })
            }}
          />
        )}
        <IconRail
          tab={railTab}
          // 点亮着的「对话」图标 = 收起 / 展开会话列表；点别的图标照常切页。
          onTab={(tab) => (tab === 'chats' && railTab === 'chats' ? setCollapsed(!listCollapsed) : setRailTab(tab))}
          listCollapsed={collapsed}
          onChatsHover={peekEnter}
          onChatsLeave={peekLeave}
          onOpenSettings={() => openSettings()}
          chatAlert={chatAlert}
        />
        {railTab === 'bots' ? (
          // 「机器人」tab：同定时任务，占满列表列 + 右侧内容（机器人列表 + 详情）。
          <BotsPane />
        ) : railTab === 'tasks' ? (
          // 「定时任务」tab：占满列表列 + 右侧内容的整块空间，作独立管理面（列表 + 每行操作）。
          // 与「消息 / 角色」正交——不渲染 Rail 列表列，故 Rail 的 tab 只会拿到 'chats' | 'roster'。
          <TasksPane
            target={tasksTarget}
            onTargetConsumed={() => setTasksTarget(null)}
            onAddByChat={addTaskByChat}
          />
        ) : (
          <>
            <Rail
              tab={railTab}
              sessions={railSessions}
              personas={personas}
              currentSessionId={currentSessionId}
              sessionStates={sessionStates}
              viewPersonaId={viewPersonaId}
              onOpenThread={openThread}
              onOpenProfile={openProfile}
              onStartPersona={startWith}
              onAddPersona={() => setEditor({ mode: 'create' })}
              onAddPersonaByChat={addPersonaByChat}
              onNewChatFromThread={newChatFromThread}
              onRenameThread={renameThread}
              onArchiveThread={archiveThread}
              onUnarchiveThread={(id) => setArchived(id, false)}
              onDeleteThread={deleteThread}
              onDeletePersona={deletePersona}
              onReorderPersonas={reorderPersonas}
              collapsed={collapsed}
              peek={collapsed && peek}
              onHover={peekStay}
              onLeave={peekLeave}
              onInputBlur={peekFocusOut}
            />
            {railTab === 'roster' ? (
              // 「角色」tab：右侧显示选中角色的资料卡；未选中（或角色已删）则给出提示。
              // 与「消息」tab 的右侧彼此独立——切 tab 即切右侧内容。
              viewPersona ? (
                <ProfileView
                  persona={viewPersona}
                  sessions={railSessions}
                  onOpenThread={openThread}
                  onStart={() => startWith(viewPersona.id)}
                  onEdit={() => setEditor({ mode: 'edit', persona: viewPersona })}
                  onManageCaps={(ext) => openSettings({ section: 'extensions', ext })}
                />
              ) : (
                <RosterEmpty />
              )
            ) : noThreads ? (
              <QuickStart personas={personas} onStart={startWith} />
            ) : (
              <Conversation
                owner={owner}
                currentSessionId={currentSessionId}
                messages={messages}
                streaming={streaming}
                streamStatus={streamStatus}
                focusRoot={currentBinding.focusRoot}
                onOpenProfile={openProfile}
                onSend={send}
                onStop={stop}
                onMount={mountFocus}
                onAsk={respondAsk}
                onPlan={respondPlan}
                onMountReq={respondMount}
                onOpenProposal={openProposal}
                onOpenAutotask={openAutotask}
                onDeleteTurns={deleteTurnsWithConfirm}
                archived={!!railSessions.find((s) => s.id === currentSessionId)?.archived}
                onUnarchive={() => setArchived(currentSessionId, false)}
                attention={sessionStates[currentSessionId]?.attention ?? false}
                prefill={composerPrefill}
                onPrefill={(text) => setComposerPrefill({ text, nonce: Date.now() })}
                onPrefillConsumed={() => setComposerPrefill(null)}
              />
            )}
          </>
        )}
      </div>

      {editor && <PersonaEditor initial={editor} onClose={() => setEditor(null)} />}
      {settingsOpen && <Settings initial={settingsInit} onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}

/* ============================ 最左：图标导航栏（微信式） ============================ */
/**
 * 窄图标栏：顶部当前用户头像，中部「对话 / 角色」切换（点击切左栏列表列），底部设置入口。
 * 把原先挤在列表列顶部的文字 tab 与底部的用户/设置脚移到这里，列表列因而只承载列表本身。
 */
function IconRail({
  tab,
  onTab,
  listCollapsed,
  onChatsHover,
  onChatsLeave,
  onOpenSettings,
  chatAlert
}: {
  tab: RailTab
  /** 点亮着的「对话」图标也回调（由调用方切换会话列表的收起 / 展开）。 */
  onTab: (t: RailTab) => void
  /** 对话页的会话列表已收起：「对话」图标的提示改为「展开会话列表」，红点也显示在它上面。 */
  listCollapsed: boolean
  /** 悬停 / 离开「对话」图标（收起时据此浮出列表）。 */
  onChatsHover: () => void
  onChatsLeave: () => void
  onOpenSettings: () => void
  /** 其他对话有新消息或待你处理 → 按钮上显示红点。 */
  chatAlert: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  const [profileOpen, setProfileOpen] = useState(false)
  // 亮着的「对话」图标点了是收起 / 展开，提示写明，免得点了以为列表丢了。
  const chatsLabel =
    tab !== 'chats' ? t('cf.tabChats') : listCollapsed ? t('cf.expandList') : t('cf.collapseList')
  return (
    <nav className="cf-iconrail">
      <button
        type="button"
        className="cf-iconrail__me"
        title={t('cf.profile.open')}
        aria-label={t('cf.profile.open')}
        onClick={() => setProfileOpen(true)}
      >
        <Avatar user size={34} />
      </button>
      {profileOpen && <ProfilePanel onClose={() => setProfileOpen(false)} />}
      <button
        className={`cf-navbtn${tab === 'chats' ? ' is-active' : ''}`}
        title={chatsLabel}
        aria-label={chatsLabel}
        aria-current={tab === 'chats'}
        aria-expanded={tab === 'chats' ? !listCollapsed : undefined}
        onClick={() => onTab('chats')}
        onMouseEnter={onChatsHover}
        onMouseLeave={onChatsLeave}
      >
        <MessageCircle size={20} />
        {/* 看不到会话列表时（不在对话页，或列表已收起），在导航按钮上提示其他对话的动静。 */}
        {(tab !== 'chats' || listCollapsed) && chatAlert && (
          <span className="cf-navbtn__dot" aria-hidden="true" />
        )}
      </button>
      <button
        className={`cf-navbtn${tab === 'roster' ? ' is-active' : ''}`}
        title={t('cf.tabRoster')}
        aria-label={t('cf.tabRoster')}
        aria-current={tab === 'roster'}
        onClick={() => onTab('roster')}
      >
        <Users size={20} />
      </button>
      <button
        className={`cf-navbtn${tab === 'tasks' ? ' is-active' : ''}`}
        title={t('cf.tabTasks')}
        aria-label={t('cf.tabTasks')}
        aria-current={tab === 'tasks'}
        onClick={() => onTab('tasks')}
      >
        <AlarmClock size={20} />
      </button>
      <div className="cf-spacer" />
      <button
        className={`cf-navbtn${tab === 'bots' ? ' is-active' : ''}`}
        title={t('bots.title')}
        aria-label={t('bots.title')}
        aria-current={tab === 'bots'}
        onClick={() => onTab('bots')}
      >
        <Bot size={20} />
      </button>
      <button
        className="cf-navbtn"
        title={t('cf.settings')}
        aria-label={t('cf.settings')}
        onClick={onOpenSettings}
      >
        <Cog size={20} />
      </button>
    </nav>
  )
}

/** 列表行右键菜单：光标处（视口坐标）+ 目标（对话或角色）。 */
type RowMenu =
  | { x: number; y: number; kind: 'thread'; id: string; title: string; archived: boolean }
  | { x: number; y: number; kind: 'persona'; id: string; name: string }

/* ============================ 左栏：列表列（对话 / 角色） ============================ */
/** 对话列表的一项筛选条件：角色 id，或挂载文件夹路径（NO_FOLDER = 未挂载文件夹）。 */
interface ConvFilter {
  kind: 'role' | 'folder'
  value: string
}
const NO_FOLDER = ''
const folderKeyOf = (s: SessionMeta): string => s.focusRoot || NO_FOLDER
// 同一类里选了多个是「任一」，角色与文件夹之间是「同时满足」；没选即不限。
const passRoles = (s: SessionMeta, roles: string[]): boolean =>
  !roles.length || roles.includes(s.personaId ?? '')
const passFolders = (s: SessionMeta, folders: string[]): boolean =>
  !folders.length || folders.includes(folderKeyOf(s))
/**
 * 列表搜索词（消息 / 角色 tab 各一份）与对话筛选：切换时不清空，由用户手动清。放在模块级，切到定时任务 /
 * 机器人（Rail 卸载）再回来仍在；不跨重启。
 */
const railSearchMemo: { query: Record<'chats' | 'roster', string>; filters: ConvFilter[] } = {
  query: { chats: '', roster: '' },
  filters: []
}

function Rail({
  tab,
  sessions,
  personas,
  currentSessionId,
  sessionStates,
  viewPersonaId,
  onOpenThread,
  onOpenProfile,
  onStartPersona,
  onAddPersona,
  onAddPersonaByChat,
  onNewChatFromThread,
  onRenameThread,
  onArchiveThread,
  onUnarchiveThread,
  onDeleteThread,
  onDeletePersona,
  onReorderPersonas,
  collapsed,
  peek,
  onHover,
  onLeave,
  onInputBlur
}: {
  tab: 'chats' | 'roster'
  sessions: SessionMeta[]
  personas: Persona[]
  currentSessionId: string
  sessionStates: Record<string, SessionLiveState>
  viewPersonaId: string | null
  onOpenThread: (id: string) => void
  onOpenProfile: (id: string) => void
  /** 以该角色发起一条全新对话（复用 startWith）：角色行右键「开始对话」与搜索行「新建对话」浮层共用。 */
  onStartPersona: (id: string) => void
  onAddPersona: () => void
  onAddPersonaByChat: () => void
  onNewChatFromThread: (id: string) => void
  /** 重命名对话（弹框输入新标题）；title 为当前标题。 */
  onRenameThread: (id: string, title: string) => void
  /** 归档（从列表移走，提示条可撤销）/ 移回对话列表。 */
  onArchiveThread: (id: string, title: string) => void
  onUnarchiveThread: (id: string) => void
  onDeleteThread: (id: string, title: string) => void
  onDeletePersona: (id: string, name: string) => void
  onReorderPersonas: (ids: string[]) => void
  /** 会话列表已收起（列宽归零、列表藏在对话区下面）。 */
  collapsed: boolean
  /** 收起时浮出：整块浮在对话区上方。 */
  peek: boolean
  /** 鼠标进出列表（浮出时据此决定收回）。右键菜单、新建菜单都是列表的子元素，停在上面不算离开。 */
  onHover: () => void
  onLeave: () => void
  /** 焦点离开列表里的输入框（且没落在列表内别处）：浮出时据此决定收回。 */
  onInputBlur: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  // 右键菜单态（对话/角色行共用一个，同一时刻至多一个）。
  const [menu, setMenu] = useState<RowMenu | null>(null)
  // 搜索词：对话 / 角色 tab 共用一个输入框，但各记各的（检索对象不同，残留词会误导），切 tab 不清空。
  const [queries, setQueries] = useState(railSearchMemo.query)
  const query = queries[tab]
  const setQuery = (v: string): void => setQueries((qs) => (qs[tab] === v ? qs : { ...qs, [tab]: v }))
  // 对话筛选（只在消息 tab）：按选中先后排列，空输入框按退格撤掉最后一项。与消息 tab 的搜索词同进退——
  // 浮出列表收回、从列表新建对话时一并清空。
  const [filters, setFilters] = useState<ConvFilter[]>(railSearchMemo.filters)
  const [filterOpen, setFilterOpen] = useState(false)
  // 已归档对话：从「新建对话」浮层底部进入，在列表这一栏里列出，顶部「←」返回。已归档的不进列表、搜索与筛选。
  const [archiveView, setArchiveView] = useState(false)
  // 右键归档的次数：每归档一次加一，NewChatMenu 据此在 + 右上角短暂亮一枚归档角标，提示去这里找回。
  const [archiveHint, setArchiveHint] = useState(0)
  // 各对话在内置浏览器里开着几个网页（对话行上打地球徽标）；整栏订阅一次，不让每行各自监听
  const browserState = useBrowserState()
  const browserPages = useMemo(() => {
    const n: Record<string, number> = {}
    for (const tab of browserState?.tabs ?? []) n[tab.sessionId] = (n[tab.sessionId] ?? 0) + 1
    return n
  }, [browserState?.tabs])
  const liveSessions = useMemo(() => sessions.filter((s) => !s.archived), [sessions])
  const archivedSessions = useMemo(
    () => sessions.filter((s) => s.archived).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions]
  )
  // 最后一个已归档对话被移回或删除：入口随之隐藏，自动回到对话列表。
  useEffect(() => {
    if (archiveView && archivedSessions.length === 0) setArchiveView(false)
  }, [archiveView, archivedSessions.length])
  useEffect(() => {
    railSearchMemo.query = queries
    railSearchMemo.filters = filters
  }, [queries, filters])
  // 花名册拖拽态：dragId=正被拖动的角色；dropTarget=当前悬停的落点行与半区（驱动放置指示线）。
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; edge: 'before' | 'after' } | null>(
    null
  )
  const clearFilters = (): void => {
    setFilters((fs) => (fs.length ? [] : fs))
    setFilterOpen(false)
  }
  // 切 tab 只收起筛选面板（面板只属于消息 tab），搜索词与筛选都保留。
  useEffect(() => {
    setFilterOpen(false)
  }, [tab])
  const asideRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // 收起后浮出列表收回时：连带关掉在它里面打开的右键菜单（否则菜单留在隐藏的列表里，下次浮出时它的全屏
  // 透明背板跟着回来，第一下点击被背板吃掉）；清空搜索词与筛选、退出已归档对话（浮出列表是临时的，下次浮出
  // 不该还是筛过的样子）；焦点若还在列表里（如搜索框）也移走，免得接着打字打进看不见的框。
  useEffect(() => {
    if (!collapsed || peek) return
    setMenu(null)
    setQuery('')
    clearFilters()
    setArchiveView(false)
    const el = document.activeElement
    if (el instanceof HTMLElement && asideRef.current?.contains(el)) el.blur()
  }, [collapsed, peek])
  // 删掉的角色从筛选里剔除（否则列表一直是空的，面板里又找不到它来取消）。
  useEffect(() => {
    setFilters((fs) => {
      const next = fs.filter((f) => f.kind !== 'role' || personas.some((p) => p.id === f.value))
      return next.length === fs.length ? fs : next
    })
  }, [personas])
  // 筛选条件变了，列表回到顶部看结果。
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 })
  }, [filters])
  // 筛选面板：点面板、筛选按钮、已选标签以外的地方（含输入框，点它就是要打字）或按 Esc 收起。
  // 不用全屏背板：点对话行时收起面板的同时照常打开对话。
  useEffect(() => {
    if (!filterOpen) return
    const onDown = (e: MouseEvent): void => {
      const inside =
        e.target instanceof Element &&
        e.target.closest('.cf-filter, .cf-search__filter')
      if (!inside) setFilterOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFilterOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [filterOpen])
  const roleIds = useMemo(() => filters.filter((f) => f.kind === 'role').map((f) => f.value), [filters])
  const folderKeys = useMemo(
    () => filters.filter((f) => f.kind === 'folder').map((f) => f.value),
    [filters]
  )
  const toggleFilter = (kind: ConvFilter['kind'], value: string): void =>
    setFilters((fs) =>
      fs.some((f) => f.kind === kind && f.value === value)
        ? fs.filter((f) => !(f.kind === kind && f.value === value))
        : [...fs, { kind, value }]
    )
  // 从列表新建对话：清空搜索与筛选，保证新对话出现在列表里。
  const startFresh = (fn: () => void): void => {
    setQuery('')
    clearFilters()
    fn()
  }
  // 筛选面板的选项（只在打开时算）：有对话的角色按花名册顺序，挂过的文件夹按最近使用；已选的即便没有对话了
  // 也列出来，好取消。数字是在另一类条件下的对话数，为 0 置灰（仍可点）。
  const filterOptions = useMemo(() => {
    if (!filterOpen) return null
    const roles = personas
      .filter((p) => roleIds.includes(p.id) || liveSessions.some((s) => s.personaId === p.id))
      .map((p) => ({
        persona: p,
        n: liveSessions.filter((s) => s.personaId === p.id && passFolders(s, folderKeys)).length
      }))
    const paths: string[] = []
    for (const s of [...liveSessions].sort((a, b) => b.updatedAt - a.updatedAt))
      if (s.focusRoot && !paths.includes(s.focusRoot)) paths.push(s.focusRoot)
    for (const k of folderKeys) if (k !== NO_FOLDER && !paths.includes(k)) paths.push(k)
    const names = paths.map(basename)
    const count = (key: string): number =>
      liveSessions.filter((s) => folderKeyOf(s) === key && passRoles(s, roleIds)).length
    const folders = paths.map((path, i) => ({
      key: path,
      name: names[i],
      // 同名文件夹附上级目录名区分。
      hint:
        names.filter((n) => n === names[i]).length > 1
          ? basename(path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, ''))
          : '',
      n: count(path)
    }))
    // 从没挂过文件夹就不出文件夹一栏（只剩「未挂载」一项，筛了等于没筛）。
    const none = count(NO_FOLDER)
    if (paths.length && (none || folderKeys.includes(NO_FOLDER)))
      folders.push({ key: NO_FOLDER, name: t('cf.filterNoFolder'), hint: '', n: none })
    return { roles, folders }
  }, [filterOpen, personas, liveSessions, roleIds, folderKeys, t])
  // 已选条件的说明（搜索框里只写总数，选了什么挂在悬停与读屏上）：「角色：…」「文件夹：…」各一行。
  const pickedRoles = roleIds
    .map((id) => personas.find((p) => p.id === id))
    .filter((p): p is Persona => !!p)
  const sep = locale === 'en' ? ', ' : '、'
  const colon = locale === 'en' ? ': ' : '：'
  const folderNames = folderKeys
    .map((k) => (k === NO_FOLDER ? t('cf.filterNoFolder') : basename(k)))
    .join(sep)
  const roleNames = pickedRoles.map((p) => p.name).join(sep)
  const filterLines = [
    pickedRoles.length ? `${t('cf.filterRoles')}${colon}${roleNames}` : '',
    folderKeys.length ? `${t('cf.filterFolders')}${colon}${folderNames}` : ''
  ].filter(Boolean)
  // 归一化后的检索词（去空白 + 小写）；空则视为不过滤。
  const q = query.trim().toLowerCase()
  // 消息列表按最近更新降序，先按筛选条件，再按检索词过滤（标题 + 所属角色名 + 挂载的文件夹名，均大小写不敏感）。
  const ordered = useMemo(() => {
    const sorted = [...liveSessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .filter((s) => passRoles(s, roleIds) && passFolders(s, folderKeys))
    if (!q) return sorted
    return sorted.filter((s) => {
      const owner = personas.find((p) => p.id === s.personaId)
      return (
        s.title.toLowerCase().includes(q) ||
        (owner ? owner.name.toLowerCase().includes(q) : false) ||
        (s.focusRoot ? basename(s.focusRoot).toLowerCase().includes(q) : false)
      )
    })
  }, [liveSessions, personas, q, roleIds, folderKeys])
  // 角色列表按检索词过滤（角色名 + 简介，均大小写不敏感）；空词返回全部。
  const shownPersonas = useMemo(() => {
    if (!q) return personas
    return personas.filter(
      (p) => p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)
    )
  }, [personas, q])

  const clearDrag = (): void => {
    setDragId(null)
    setDropTarget(null)
  }
  // 拖拽落定：把 dragId 放到目标行的上/下半区所决定的位置，算出新 id 序列并落盘（乐观 + 持久化）。
  const dropOnPersona = (targetId: string, edge: 'before' | 'after'): void => {
    if (dragId && dragId !== targetId) {
      onReorderPersonas(reorderIds(personas.map((p) => p.id), dragId, targetId, edge))
    }
    clearDrag()
  }
  // 置顶：把该角色移到花名册最前（右键菜单触发）。已在最前则为无害的同序写入。
  const pinPersona = (id: string): void => {
    const ids = personas.map((p) => p.id)
    onReorderPersonas([id, ...ids.filter((x) => x !== id)])
  }
  // 对话行（对话列表与已归档对话共用）：右键菜单记下是否已归档，菜单项随之不同。
  const threadRow = (s: SessionMeta): React.JSX.Element => (
    <ThreadRow
      key={s.id}
      session={s}
      owner={personas.find((p) => p.id === s.personaId)}
      state={sessionStates[s.id]}
      browserPages={browserPages[s.id] ?? 0}
      active={s.id === currentSessionId}
      onClick={() => onOpenThread(s.id)}
      onContext={(e) => {
        e.preventDefault()
        setMenu({
          x: e.clientX,
          y: e.clientY,
          kind: 'thread',
          id: s.id,
          title: s.title || '',
          archived: !!s.archived
        })
      }}
    />
  )
  return (
    <aside
      ref={asideRef}
      className={`cf-rail${collapsed ? ' is-collapsed' : ''}${peek ? ' is-peek' : ''}`}
      aria-hidden={collapsed && !peek ? true : undefined}
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      onBlur={(e) => {
        const to = e.relatedTarget
        if (e.target instanceof HTMLInputElement && !(to instanceof Node && e.currentTarget.contains(to))) onInputBlur()
      }}
    >
      {/* 顶部：搜索占满整行；消息 tab 并排「新建对话」入口（悬停出角色列表），角色 tab 并排「添加角色」入口（悬停/点击出二选一弹层）。
          消息 tab 的搜索框最左是筛选按钮（代替放大镜）；选了条件后换成已选的角色头像（堆叠）与文件夹（多个时标数字），
          点它们同样打开筛选面板。 */}
      <div className="cf-rail__top">
        {tab === 'chats' && archiveView ? (
          // 已归档对话：顶行换成「← 已归档对话 N」，返回即回到对话列表（搜索词与筛选原样保留）。
          <>
            <button
              className="cf-rail__back"
              title={t('cf.backToChats')}
              aria-label={t('cf.backToChats')}
              onClick={() => setArchiveView(false)}
            >
              <ArrowLeft size={16} />
            </button>
            <span className="cf-rail__title">{t('cf.archivedChats')}</span>
            <span className="cf-rail__count">{archivedSessions.length}</span>
          </>
        ) : (
          <>
          <div className={`cf-search${tab === 'chats' ? ' cf-search--filter' : ''}`}>
            {tab !== 'chats' ? (
              <Search className="cf-search__icon" size={14} />
            ) : (
              // 选了条件仍是同一个按钮：原位加底色、图标后接已选总数，图标不换不挪，选择前后不跳。
              <button
                className={`cf-search__filter${filters.length ? ' is-active' : ''}`}
                title={filters.length ? filterLines.join('\n') : t('cf.filter')}
                aria-label={
                  filters.length ? filterLines.join(locale === 'en' ? '; ' : '；') : t('cf.filter')
                }
                aria-haspopup="menu"
                aria-expanded={filterOpen}
                onClick={() => setFilterOpen((o) => !o)}
              >
                <ListFilter size={15} />
                {filters.length > 0 && filters.length}
              </button>
            )}
            <input
              className="cf-search__input"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                tab === 'chats' ? t(filters.length ? 'cf.search' : 'cf.searchChats') : t('cf.searchRoster')
              }
              aria-label={t('cf.search')}
            />
            {(query || filters.length > 0) && (
              <button
                className="cf-search__clear"
                title={filters.length ? t('cf.clearSearch') : t('common.close')}
                aria-label={filters.length ? t('cf.clearSearch') : t('common.close')}
                onClick={() => {
                  setQuery('')
                  clearFilters()
                }}
              >
                <X size={13} />
              </button>
            )}
          </div>
          {tab === 'chats' && (
            <NewChatMenu
              personas={personas}
              archivedCount={archivedSessions.length}
              archiveHint={archiveHint}
              onStart={(id) => startFresh(() => onStartPersona(id))}
              onOpenArchive={() => {
                setFilterOpen(false)
                setArchiveView(true)
              }}
            />
          )}
          {tab === 'roster' && (
            <AddMenu
              manualLabel={t('cf.addPersona')}
              chatLabel={t('cf.addByChat')}
              onManual={onAddPersona}
              onByChat={onAddPersonaByChat}
            />
          )}
          </>
        )}
        {/* 筛选面板：外观同统一下拉框的浮层，角色与文件夹两栏，点选即时生效、面板不收起。选中项铺浅主题色底（同对话列表的当前行），不用行尾对勾。 */}
        {tab === 'chats' && !archiveView && filterOptions && (
          <div className="select-menu cf-filter" role="menu" aria-label={t('cf.filter')}>
            <div className="select-menu__group">{t('cf.filterRoles')}</div>
            {filterOptions.roles.map(({ persona: p, n }) => {
              const on = roleIds.includes(p.id)
              return (
                <button
                  key={p.id}
                  className={`select-menu__opt cf-filter__opt${on ? ' is-on' : ''}${!n && !on ? ' is-dim' : ''}`}
                  role="menuitemcheckbox"
                  aria-checked={on}
                  // 不抢输入框的焦点（浮出列表靠它判断是否在打字）。
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => toggleFilter('role', p.id)}
                >
                  <span className="select-ava">
                    <PersonaFace seed={p.id} spec={parseAvatarSpec(p.avatar)} image={p.avatarImage} />
                  </span>
                  <span className="select-menu__main">
                    <span className="select-menu__name">{p.name}</span>
                  </span>
                  <span className="cf-filter__count">{n}</span>
                </button>
              )
            })}
            {filterOptions.folders.length > 0 && (
              <>
                <div className="select-menu__sep" />
                <div className="select-menu__group">{t('cf.filterFolders')}</div>
                {filterOptions.folders.map(({ key, name, hint, n }) => {
                  const on = folderKeys.includes(key)
                  return (
                    <button
                      key={key || '\0'}
                      className={`select-menu__opt cf-filter__opt${on ? ' is-on' : ''}${!n && !on ? ' is-dim' : ''}`}
                      role="menuitemcheckbox"
                      aria-checked={on}
                      title={key || undefined}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => toggleFilter('folder', key)}
                    >
                      <span className="cf-filter__icon">
                        {key === NO_FOLDER ? <FolderMinus size={15} /> : <Folder size={15} />}
                      </span>
                      <span className="select-menu__main">
                        <span className="select-menu__name">
                          {name}
                          {hint && <span className="cf-filter__hint"> · {hint}</span>}
                        </span>
                      </span>
                      <span className="cf-filter__count">{n}</span>
                    </button>
                  )
                })}
              </>
            )}
          </div>
        )}
      </div>

      {/* 角色 tab：角色为空只会是还没加载完（默认角色 Pal 删不掉），先留空，不落到「未找到匹配项」。 */}
      <div className="cf-list" ref={listRef}>
        {tab === 'chats' && archiveView ? (
          archivedSessions.map(threadRow)
        ) : tab === 'chats' ? (
          ordered.length === 0 ? (
            <div className="cf-empty">
              {q || filters.length ? t('cf.searchNoResults') : t('chat.noSessions')}
              {filters.length > 0 && (
                <button className="cf-empty__action" onClick={clearFilters}>
                  {t('cf.filterClear')}
                </button>
              )}
            </div>
          ) : (
            ordered.map(threadRow)
          )
        ) : personas.length === 0 ? null : shownPersonas.length === 0 ? (
          <div className="cf-empty">{t('cf.searchNoResults')}</div>
        ) : (
          shownPersonas.map((p) => (
            <PersonaRow
              key={p.id}
              persona={p}
              active={viewPersonaId === p.id}
              dragging={dragId === p.id}
              dropEdge={dropTarget?.id === p.id && dragId !== p.id ? dropTarget.edge : null}
              onClick={() => onOpenProfile(p.id)}
              onContext={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, kind: 'persona', id: p.id, name: p.name })
              }}
              onDragStart={() => setDragId(p.id)}
              onDragOverRow={(edge) => {
                if (!dragId || dragId === p.id) return
                setDropTarget((cur) =>
                  cur && cur.id === p.id && cur.edge === edge ? cur : { id: p.id, edge }
                )
              }}
              onDropRow={(edge) => dropOnPersona(p.id, edge)}
              onDragEnd={clearDrag}
            />
          ))
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            menu.kind === 'thread' && menu.archived
              ? [
                  {
                    label: t('cf.unarchive'),
                    icon: <ArchiveRestore size={14} />,
                    onClick: () => onUnarchiveThread(menu.id)
                  },
                  {
                    label: t('cf.deleteChat'),
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onClick: () => onDeleteThread(menu.id, menu.title)
                  }
                ]
              : menu.kind === 'thread'
              ? [
                  {
                    label: t('cf.newChat'),
                    icon: <Plus size={14} />,
                    onClick: () => startFresh(() => onNewChatFromThread(menu.id))
                  },
                  {
                    label: t('cf.renameChat'),
                    icon: <Pencil size={14} />,
                    onClick: () => onRenameThread(menu.id, menu.title)
                  },
                  {
                    label: t('cf.archive'),
                    icon: <Archive size={14} />,
                    // 进行中不能归档（灰显 + 悬停说明）：归档后它在看不见的地方跑完，红点却指向列表里找不到的对话。
                    // 反过来已归档的对话一开始新一轮就会移回列表（主进程 emitTurnStart），故「进行中」与「已归档」互斥。
                    disabled: sessionStates[menu.id]?.streaming === true,
                    title: sessionStates[menu.id]?.streaming ? t('cf.archiveBusy') : undefined,
                    onClick: () => {
                      setArchiveHint((n) => n + 1)
                      onArchiveThread(menu.id, menu.title)
                    }
                  },
                  {
                    label: t('cf.deleteChat'),
                    icon: <Trash2 size={14} />,
                    danger: true,
                    onClick: () => onDeleteThread(menu.id, menu.title)
                  }
                ]
              : [
                  {
                    label: t('cf.startChat'),
                    icon: <MessageCircle size={14} />,
                    onClick: () => onStartPersona(menu.id)
                  },
                  {
                    label: t('cf.pinTop'),
                    icon: <ArrowUpToLine size={14} />,
                    // 已在花名册最前则禁用（灰显），避免无意义的同序写入。
                    disabled: personas[0]?.id === menu.id,
                    onClick: () => pinPersona(menu.id)
                  },
                  {
                    label: t('cf.deletePersona'),
                    icon: <Trash2 size={14} />,
                    danger: true,
                    // 系统默认角色：菜单项禁用（灰显 + 悬停说明），不可点。
                    disabled: menu.id === DEFAULT_PERSONA_ID,
                    title:
                      menu.id === DEFAULT_PERSONA_ID ? t('cf.deletePersonaLocked') : undefined,
                    onClick: () => onDeletePersona(menu.id, menu.name)
                  }
                ]
          }
        />
      )}
    </aside>
  )
}


/* ─────────────────────────── Git 快捷面板（IDEA 式点击浮出） ───────────────────────────
 * 挂载工作区若是 git 仓库，则在挂载 chip 里跟一枚分支 pill，点击浮出常用操作。
 * 后端（services/git.ts + window.Pal.git.*）早已齐备；此处只是薄薄一层 renderer UI。
 * 安全：focusRoot 在 fs:open-folder 时已 trustRoot，git:status 内部 assertInside——复用既有受信根，
 * 不新增任何越权面，也不弹权限框（与「全放行 + 静默硬底线」一致）。
 */

import { GitWidget, WorkspaceMenu } from './git-widget'





/**
 * 「新建对话」入口（消息 tab 搜索行右侧）：外观与交互同 AddMenu，浮层列出花名册全部角色，
 * 点某个角色即以其开启一条全新对话（onStart → startWith）。角色多时角色列表内滚动；有已归档对话时
 * 底部隔线固定一行「已归档对话」与数量（不随列表滚走），点了在列表这一栏打开已归档对话。
 */
function NewChatMenu({
  personas,
  archivedCount,
  archiveHint,
  onStart,
  onOpenArchive
}: {
  personas: Persona[]
  archivedCount: number
  /** 右键归档的次数（Rail 每归档一次加一）；变化时在 + 右上角短暂亮归档角标。 */
  archiveHint: number
  onStart: (personaId: string) => void
  onOpenArchive: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const { open, hoverProps, show, choose } = useHoverMenu()
  // 归档角标：亮约 1.5 秒后淡出；连续归档重新计时并轻跳一下。鼠标停在 + / 浮层上时一直亮着（浮层底部
  // 「已归档对话」同时标主题色），移开即熄。只认挂载后的变化——切 tab、进出已归档视图会重新挂载本组件，
  // 不能把之前的计数当成新归档。撤销到一条已归档都不剩时也熄（浮层里已没有那一行）。
  const [hint, setHint] = useState(false)
  const seenHint = useRef(archiveHint)
  const hovered = useRef(false)
  const badgeRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (archiveHint === seenHint.current) return
    seenHint.current = archiveHint
    hovered.current = false
    if (hint && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      badgeRef.current?.animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(1.2)' }, { transform: 'scale(1)' }],
        { duration: 220, easing: 'ease-out' }
      )
    }
    setHint(true)
    // 只随归档次数触发；hint 仅用来判断是否已经亮着
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archiveHint])
  useEffect(() => {
    if (!hint) return
    if (open) {
      hovered.current = true
      return
    }
    if (hovered.current) {
      hovered.current = false
      setHint(false)
      return
    }
    const timer = window.setTimeout(() => setHint(false), 1500)
    return () => window.clearTimeout(timer)
  }, [hint, open, archiveHint])
  const hinting = hint && archivedCount > 0
  return (
    <div className="cf-addmenu" {...hoverProps}>
      <button
        className="cf-rail__addbtn"
        title={t('cf.newChat')}
        aria-label={t('cf.newChat')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={show}
      >
        <Plus size={16} />
      </button>
      <span ref={badgeRef} className={`cf-addmenu__badge${hinting ? ' is-on' : ''}`} aria-hidden="true">
        <Archive size={10} strokeWidth={2.6} />
      </span>
      {open && (personas.length > 0 || archivedCount > 0) && (
        <div className="cf-addmenu__pop cf-addmenu__pop--scroll" role="menu">
          {personas.length > 0 && (
            <div className="cf-addmenu__list">
              {personas.map((p) => (
                <button
                  key={p.id}
                  className="cf-addmenu__item cf-addmenu__item--persona"
                  role="menuitem"
                  // 名字 / 专长过长时单行省略，悬停 title 给出全文。
                  title={p.desc ? `${p.name} · ${p.desc}` : p.name}
                  onClick={() => choose(() => onStart(p.id))}
                >
                  <Avatar persona={p} size={28} />
                  {/* 与花名册行同构：角色名 + 专长（未填写则只显示名字）。 */}
                  <span className="cf-addmenu__main">
                    <span className="cf-addmenu__name">{p.name}</span>
                    {p.desc && <span className="cf-addmenu__desc">{p.desc}</span>}
                  </span>
                </button>
              ))}
            </div>
          )}
          {/* 没有已归档对话时连同分隔线一起不显示。 */}
          {archivedCount > 0 && (
            <>
              {personas.length > 0 && <div className="cf-addmenu__sep" />}
              <button
                className={`cf-addmenu__item${hinting ? ' is-hint' : ''}`}
                role="menuitem"
                onClick={() => choose(onOpenArchive)}
              >
                <Archive size={15} className="cf-addmenu__icon" />
                <span className="cf-addmenu__label">{t('cf.archivedChats')}</span>
                <span className="cf-addmenu__count">{archivedCount}</span>
                <ChevronRight size={14} className="cf-addmenu__chev" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}


function ThreadRow({
  session,
  owner,
  state,
  browserPages,
  active,
  onClick,
  onContext
}: {
  session: SessionMeta
  owner?: Persona
  state?: SessionLiveState
  /** 这个对话在内置浏览器里开着几个网页（>0 时标题旁打地球徽标）。 */
  browserPages: number
  active: boolean
  onClick: () => void
  onContext: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const rel = useRelativeTime()
  const draft = useDraftPreview(session.id)
  // 任务独占会话（sessionId = `task-…`）：行上打一枚静态「⏰ 定时」徽标以区别普通对话。
  // 「有新运行未读」（state.unread）与待你处理（state.attention）都在头像右上角打红点。
  const isTask = session.id.startsWith('task-')
  return (
    <button
      className={`cf-thread${active ? ' is-active' : ''}`}
      onClick={onClick}
      onContextMenu={onContext}
    >
      {/* 对话中（streaming）→ 头像上一道扫光指示；有新消息 / 待你处理 → 右上角红点。
          正在查看的对话不打红点（内容就在眼前），已归档的也不打（归档即不再提醒）。 */}
      <Avatar
        persona={owner}
        size={38}
        busy={state?.streaming}
        attention={!active && !session.archived && state?.attention}
        unread={!active && !session.archived && state?.unread}
      />
      <div className="cf-thread__main">
        {/* 上：对话标题与时间（主视觉，醒目显示对话内容）；下：角色名，挂了文件夹则换成文件夹名（悬停看完整路径，角色看头像）。 */}
        <div className="cf-thread__top">
          <span className="cf-thread__title">{session.title || t('chat.untitled')}</span>
          <span className="cf-thread__time">{rel(session.updatedAt)}</span>
        </div>
        {/* 下行：左边是角色名 / 文件夹名 / 草稿，右边是状态图标，与上方时间右缘对齐（右侧一列：上时间、下状态）。 */}
        <div className="cf-thread__sub">
          {/* 这个会话里有没发出的内容（且不是正在看的会话）：下行换成红色「[草稿]」+ 内容开头，提醒切回去接着写。 */}
          {draft && !active ? (
            <div className="cf-thread__owner">
              <span className="cf-thread__draft">{t('cf.draftTag')}</span>
              {draft}
            </div>
          ) : session.focusRoot ? (
            <div className="cf-thread__owner cf-thread__owner--ws" title={session.focusRoot}>
              <Folder size={11} />
              <span className="cf-thread__wsname">{basename(session.focusRoot)}</span>
            </div>
          ) : (
            <div className="cf-thread__owner">{owner?.name ?? ''}</div>
          )}
          {(isTask || browserPages > 0) && (
            <span className="cf-thread__badges">
              {isTask && (
                <span className="cf-thread__badge" title={t('cf.tabTasks')}>
                  <AlarmClock size={13} />
                </span>
              )}
              {/* 开着内置浏览器的网页。地球是满圆，比闹钟显大，缩 1px 让两者观感一致 */}
              {browserPages > 0 && (
                <span
                  className="cf-thread__badge"
                  title={t('browser.threadBadge').replace('{n}', String(browserPages))}
                >
                  <Globe size={12} />
                </span>
              )}
            </span>
          )}
        </div>
      </div>
    </button>
  )
}

function PersonaRow({
  persona,
  active,
  dragging,
  dropEdge,
  onClick,
  onContext,
  onDragStart,
  onDragOverRow,
  onDropRow,
  onDragEnd
}: {
  persona: Persona
  active: boolean
  /** 本行正被拖动（淡化显示）。 */
  dragging: boolean
  /** 本行是当前落点时的插入边（上=before / 下=after），驱动放置指示线；非落点为 null。 */
  dropEdge: 'before' | 'after' | null
  onClick: () => void
  onContext: (e: React.MouseEvent) => void
  onDragStart: () => void
  /** 拖动经过本行：据指针落在上/下半区回报插入边。 */
  onDragOverRow: (edge: 'before' | 'after') => void
  onDropRow: (edge: 'before' | 'after') => void
  onDragEnd: () => void
}): React.JSX.Element {
  // 指针在本行的上半区 → 插到本行之前；下半区 → 之后。
  const edgeAt = (e: React.DragEvent): 'before' | 'after' => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientY - r.top < r.height / 2 ? 'before' : 'after'
  }
  return (
    <button
      className={`cf-prow${active ? ' is-active' : ''}${dragging ? ' is-dragging' : ''}${
        dropEdge ? ` drop-${dropEdge}` : ''
      }`}
      draggable
      onClick={onClick}
      onContextMenu={onContext}
      onDragStart={(e) => {
        // 需要 dataTransfer 非空，拖拽才成立（内容用不到，仅占位）。
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', persona.id)
        onDragStart()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        onDragOverRow(edgeAt(e))
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDropRow(edgeAt(e))
      }}
      onDragEnd={onDragEnd}
    >
      <Avatar persona={persona} size={38} />
      <div className="cf-prow__main">
        {/* 花名册只展示角色名与专长；专长未填写则整行不显示。 */}
        <div className="cf-prow__name">
          {persona.name}
        </div>
        {persona.desc && <div className="cf-prow__spec">{persona.desc}</div>}
      </div>
    </button>
  )
}

/* ============================ 中列：单人对话 ============================ */
/* ============================ 中列：快速开启（无任何对话时的空态） ============================ */
/**
 * 左侧对话被清空后中列的落点：列出花名册全部角色，点头像/卡片直接与该角色开启新对话
 * （onStart → startWith：新建并落盘一条绑定该角色的空对话，随即切入消息视图）。
 * 默认角色 Pal 删不掉，花名册只在加载完成前为空，此时网格先留空。
 */
function QuickStart({
  personas,
  onStart
}: {
  personas: Persona[]
  onStart: (personaId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <main className="cf-conv">
      <DragBar />
      <div className="cf-quick">
        <div className="cf-quick__inner">
          <div className="cf-quick__title">{t('cf.quickStartTitle')}</div>
          <div className="cf-quick__hint">{t('cf.quickStartHint')}</div>
          <div className="cf-quick__grid">
            {personas.map((p) => (
              <button
                key={p.id}
                className="cf-qcard"
                onClick={() => onStart(p.id)}
                title={p.desc || p.name}
              >
                <Avatar persona={p} size={48} />
                <span className="cf-qcard__name">{p.name}</span>
                {p.desc && <span className="cf-qcard__desc">{p.desc}</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}

/**
 * 「角色」tab 未选中任何角色时的右侧落点（与「消息」tab 的右侧彼此独立）：一句提示，引导从左侧花名册
 * 选一个角色查看资料。复用 QuickStart 的居中容器，无新增 CSS。
 */
function RosterEmpty(): React.JSX.Element {
  const { t } = useI18n()
  return (
    <main className="cf-conv">
      <DragBar />
      <div className="cf-quick">
        <div className="cf-quick__inner">
          <div className="cf-quick__title">{t('cf.rosterEmptyTitle')}</div>
          <div className="cf-quick__hint">{t('cf.rosterEmptyHint')}</div>
        </div>
      </div>
    </main>
  )
}

import { TasksPane } from './tasks-pane'




/**
 * 把展示消息按「轮」分组为连续区间（to 独占）。turn>=0 为可删的对话轮（0 基，每遇一条 user 消息 +1）；
 * turn=-1 为首条 user 之前的前言（压缩摘要 / 历史提示气泡等，不可删）。turn 值与主进程 turnRanges 同源
 * （都以「数用户气泡」为轮界），故渲染层选中的轮下标可直接交给主进程按轮删除，逐一对齐。
 */
function groupTurns(messages: ChatMessage[]): { turn: number; from: number; to: number }[] {
  const groups: { turn: number; from: number; to: number }[] = []
  let turn = -1
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') turn++
    const last = groups[groups.length - 1]
    if (last && last.turn === turn) last.to = i + 1
    else groups.push({ turn, from: i, to: i + 1 })
  }
  return groups
}

function Conversation({
  owner,
  currentSessionId,
  messages,
  streaming,
  streamStatus,
  focusRoot,
  onOpenProfile,
  onSend,
  onStop,
  onMount,
  onAsk,
  onPlan,
  onMountReq,
  onOpenProposal,
  onOpenAutotask,
  onDeleteTurns,
  archived,
  onUnarchive,
  attention,
  prefill,
  onPrefill,
  onPrefillConsumed
}: {
  owner?: Persona
  currentSessionId: string
  messages: ChatMessage[]
  streaming: boolean
  streamStatus: StreamStatus
  focusRoot: string | null
  onOpenProfile: (id: string) => void
  onSend: (text: string, attachments?: SendAttachment[]) => Promise<boolean>
  onStop: () => void
  onMount: (path: string | null) => void
  onAsk: (key: string, answers: string[]) => void
  onPlan: (key: string, decision: 'approve' | 'keep' | 'ignore', feedback?: string) => void
  /** 回应「请求挂载工作区」（path=用户选定目录 / null=暂不挂载）。 */
  onMountReq: (key: string, path: string | null) => void
  onOpenProposal: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
  /** created 态定时任务名片「打开任务会话」。 */
  onOpenAutotask: (taskId: string) => void
  /** 按「轮」删除选中轮次（含破坏性确认）；返回是否已删（true=退出选择态并清空选择）。 */
  onDeleteTurns: (turnIndices: number[]) => Promise<boolean>
  /** 当前对话已归档：标题栏显示「已归档」与「移回对话列表」。 */
  archived: boolean
  onUnarchive: () => void
  /** 当前会话有待用户处理的卡片（问答 / 计划 / 挂载请求）：此时不开回滚面板。 */
  attention: boolean
  /** 输入框预填（一次性、不发送）；null 表示无待预填。 */
  prefill: { text: string; nonce: number } | null
  /** 请求预填输入框（回滚恢复对话后把该轮原问题放回去）。 */
  onPrefill: (text: string) => void
  /** Composer 消费预填后回调，父层据此置空，避免重挂载时复活旧预填。 */
  onPrefillConsumed: () => void
}): React.JSX.Element {
  const { t, locale } = useI18n()
  // 会话累计用量（标题栏右上角面板）：纯展示，数据来自 store 的 usageOf。
  const { usageOf } = useChat()
  const scrollRef = useRef<HTMLDivElement>(null)
  // 一个可用模型都没有（首次安装的常态）→ 对话区显示「接入模型」引导卡；须等配置载入，否则启动瞬间误判。
  const { providers: modelProviders, ready: modelsReady } = useModels()
  const needModelSetup = modelsReady && !hasUsableModel(modelProviders)

  // 是否「贴住底部」：决定流式新内容是否自动跟随。用户上滚离开底部即脱离跟随，回到底部（或点「回到最新」）
  // 恢复跟随。ref 供滚动副作用同步读取（避免闭包过期、其变化不触发副作用重跑），state 仅驱动浮标显隐。
  const stickRef = useRef(true)
  const [atBottom, setAtBottom] = useState(true)

  // 选择态（按轮删除）：selecting=是否在选择模式；selected=选中的轮下标集合（0 基，与 groupTurns 一致）。
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  // 右键菜单：记录光标位置、命中的轮下标（turn=null 表示未落在某一轮上）、命中消息 id（复制整条用），
  // 以及右键那一刻的选中文字与是否可删。
  // selection 有值 → 「复制选中」；msgId 有值 → 「复制这条消息」；canDelete → 「选择删除」。各自独立成项。
  const [ctxMenu, setCtxMenu] = useState<{
    x: number
    y: number
    turn: number | null
    msgId: string | null
    selection: string
    canDelete: boolean
  } | null>(null)
  // 每条消息所属轮下标：与 groupTurns 同源（每遇 user +1），前言为 -1；供常态渲染在根节点标注 data-turn。
  const turnOf = useMemo(() => {
    const arr: number[] = []
    let turn = -1
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') turn++
      arr[i] = turn
    }
    return arr
  }, [messages])
  // 各轮首条消息（用户消息）的下标：分段渲染按整轮取边界。
  const turnStart = useMemo(() => {
    const arr: number[] = []
    messages.forEach((m, i) => {
      if (m.role === 'user') arr.push(i)
    })
    return arr
  }, [messages])
  const lastTurn = turnStart.length - 1
  /** 第 turn 轮的首条消息下标；第 0 轮及更早从 0 起，带上首轮之前的前言（压缩摘要等）。 */
  const startOfTurn = (turn: number): number => (turn <= 0 ? 0 : turnStart[turn])
  /** 第 turn 轮的末条消息下标。 */
  const endOfTurn = (turn: number): number =>
    turn + 1 < turnStart.length ? turnStart[turn + 1] - 1 : messages.length - 1

  // 分段渲染的范围（见 WINDOW_TURNS）：首末两轮的轮下标，to 为 null 即一直到最新（含此后新到的轮）。
  // 换了对话（sid 不符）回到默认的最后几轮；同一对话的消息整份重建（删轮 / 回滚 / 压缩后重载）时沿用原范围，
  // 停在原来那片内容附近，超出现有轮数的部分收拢到末尾。不合规时在渲染中就地改正（React 允许组件在渲染中
  // 更新自身状态），不先按旧范围画一遍——换对话时那一遍就是整条历史。
  const [win, setWin] = useState<{ sid: string; from: number; to: number | null } | null>(null)
  let range = messages.length > 0 && win && win.sid === currentSessionId ? win : null
  if (messages.length > 0) {
    const fromTurn = range ? Math.min(range.from, lastTurn) : lastTurn - WINDOW_TURNS + 1
    const toTurn = range && range.to !== null && range.to < lastTurn ? Math.max(range.to, fromTurn) : null
    if (!range || range.from !== fromTurn || range.to !== toTurn) {
      range = { sid: currentSessionId, from: fromTurn, to: toTurn }
      setWin(range)
    }
  }
  const from = range ? startOfTurn(range.from) : 0
  const to = range && range.to !== null ? endOfTurn(range.to) : messages.length - 1
  /** 已渲染到最新一条：不在时（跳转到较早的轮后）不跟随新内容、不显示底部状态行，「回到最新」常显。 */
  const isTail = to === messages.length - 1
  // 补上更早一段后要保持的「距底距离」（内容加在上方，按距底距离落位，看着的内容不动）。
  const restoreRef = useRef<number | null>(null)
  // 跳转目标轮还没渲染：先换范围，渲染后再落位。
  const pendingJumpRef = useRef<number | null>(null)
  // 从中间一段回到最新：换回最后几轮后直接落到底。
  const pendingBottomRef = useRef(false)
  const loadEarlier = (): void => {
    if (!range || from <= 0) return
    const el = scrollRef.current
    if (el) restoreRef.current = el.scrollHeight - el.scrollTop
    setWin({ ...range, from: range.from - WINDOW_TURNS })
  }
  const loadLater = (): void => {
    if (!range || range.to === null) return
    const next = range.to + WINDOW_TURNS
    setWin({ ...range, to: next >= lastTurn ? null : next })
  }
  /** 回到最后几轮（下一次渲染落到底）。 */
  const resetToTail = (): void => {
    pendingBottomRef.current = true
    setWin(null)
  }
  // 右侧轮次索引的数据源：只取用户消息，turn 与上面的 turnOf 同源（每遇 user +1，0 基）。
  // 正文为空（纯附件）时回落到附件名，再空则用占位文案，保证每轮都有可点的锚点。
  const tocItems = useMemo<TocItem[]>(() => {
    const out: TocItem[] = []
    let turn = -1
    for (const m of messages) {
      if (m.role !== 'user') continue
      turn++
      let full = m.blocks
        .map((b) => (b.kind === 'text' ? b.text : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      if (!full && m.attachments?.length) full = m.attachments.map((a) => a.name).join(' ')
      if (!full) full = t('cf.toc.untitled')
      out.push({
        turn,
        text: full.length > TOC_TEXT_MAX ? full.slice(0, TOC_TEXT_MAX) + '…' : full
      })
    }
    return out
  }, [messages, t])

  // 检查点回滚面板：null=关闭；turn=null 从列表开始，否则直达该轮详情（右键「回到此处」）。
  // 三个入口（/rewind、双击 Esc、右键）共用 canRewind：流式中或有待处理卡片时一律不开。
  const [rewind, setRewind] = useState<{ turn: number | null } | null>(null)
  const canRewind = !streaming && !attention
  const openRewind = (turn: number | null = null): boolean => {
    if (!canRewind) return false
    setRewind({ turn })
    return true
  }
  // 某轮提问原文（不含附件）：面板在回滚前调用，回滚后该轮消息就不在了。
  const promptOf = (turn: number): string => {
    let k = -1
    for (const m of messages) {
      if (m.role !== 'user') continue
      if (++k === turn) return m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('')
    }
    return ''
  }

  // 当前所在轮（高亮）。-1 表示无（无消息时）。滚动中经 rAF 去抖重算，避免每个滚动事件都量 DOM。
  const [activeTurn, setActiveTurn] = useState(-1)
  const tocRafRef = useRef(0)
  const recomputeActive = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const nodes = el.querySelectorAll<HTMLElement>('.cf-msg.is-user[data-turn]')
    if (nodes.length === 0) {
      setActiveTurn((p) => (p === -1 ? p : -1))
      return
    }
    let hit = -1
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD) {
      // 已滚到底时强制取最后一轮：末轮下方内容往往不足以把它顶过判定线，
      // 不特判就会出现「点了最后一项却高亮上一轮」。
      hit = Number(nodes[nodes.length - 1].dataset.turn)
    } else {
      const line = el.getBoundingClientRect().top + TOC_ACTIVE_OFFSET
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].getBoundingClientRect().top > line) break
        hit = Number(nodes[i].dataset.turn)
      }
      // 全部都在判定线之下（滚到最顶）：取第一条，保证总有高亮。
      if (hit < 0) hit = Number(nodes[0].dataset.turn)
    }
    if (!Number.isInteger(hit)) hit = -1
    setActiveTurn((p) => (p === hit ? p : hit))
  }, [])
  const scheduleActive = useCallback((): void => {
    if (tocRafRef.current) return
    tocRafRef.current = requestAnimationFrame(() => {
      tocRafRef.current = 0
      recomputeActive()
    })
  }, [recomputeActive])
  useEffect(
    () => () => {
      // 清零不可省：tocRafRef 兼作「已排队」闸门，只 cancel 不复位会让闸门永久关闭，
      // 之后所有 scheduleActive() 都直接 return（StrictMode 挂载即 setup→cleanup→setup，必踩）。
      if (tocRafRef.current) {
        cancelAnimationFrame(tocRafRef.current)
        tocRafRef.current = 0
      }
    },
    []
  )


  // 滚到某一轮的用户消息（须已渲染）：复用右键删除已标注的 data-turn 作锚点。
  const scrollToTurn = (turn: number): void => {
    const el = scrollRef.current
    if (!el) return
    const target = el.querySelector<HTMLElement>(`.cf-msg.is-user[data-turn="${turn}"]`)
    if (!target) return
    const top = Math.max(
      0,
      target.getBoundingClientRect().top -
        el.getBoundingClientRect().top +
        el.scrollTop -
        TOC_JUMP_PAD
    )
    // 贴底态按目标位置同步算，不能等 onScroll 回填：目标与当前位置相同时一次 scroll 都不会触发，
    // 贴底态会卡在错值（§4.8 流式跟随据此决策）。
    const atBot = isTail && el.scrollHeight - top - el.clientHeight <= BOTTOM_THRESHOLD
    stickRef.current = atBot
    setAtBottom(atBot)
    // 直接落位，不用 behavior:"smooth"：长对话里一路滚过去既慢又晃眼。
    el.scrollTop = top
    setActiveTurn(turn)
  }
  // 跳到某一轮：已渲染就直接滚过去；还没渲染则改为从该轮起渲染一段（不把中间的轮全渲染出来），渲染后再落位，
  // 它上方的内容随即按滚到顶部补上。
  const jumpToTurn = (turn: number): void => {
    const i = turnStart[turn]
    if (i === undefined) return
    if (i >= from && i <= to) {
      scrollToTurn(turn)
      return
    }
    const end = turn + WINDOW_TURNS - 1
    pendingJumpRef.current = turn
    setWin({ sid: currentSessionId, from: turn, to: end >= lastTurn ? null : end })
  }
  // 换了渲染范围之后、绘制之前落位：补上更早一段时保持距底距离，跳转则滚到目标轮，回到最新则落到底。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (restoreRef.current !== null) {
      el.scrollTop = el.scrollHeight - restoreRef.current
      restoreRef.current = null
    }
    if (pendingJumpRef.current !== null) {
      const turn = pendingJumpRef.current
      pendingJumpRef.current = null
      scrollToTurn(turn)
    }
    if (pendingBottomRef.current) {
      pendingBottomRef.current = false
      el.scrollTop = el.scrollHeight
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win])

  const exitSelect = (): void => {
    setSelecting(false)
    setSelected(new Set())
  }
  const toggleTurn = (turn: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(turn)) next.delete(turn)
      else next.add(turn)
      return next
    })
  }
  const doDeleteSelected = (): void => {
    const indices = [...selected]
    if (indices.length === 0) return
    void (async () => {
      const done = await onDeleteTurns(indices)
      if (done) exitSelect()
    })()
  }
  // 聊天区右键：按当下情形组装菜单。
  // - 选中文字 → 提供「复制」（不论是否流式，复制只读无副作用）；
  // - 非流式且有内容 → 提供「选择删除」（流式/改写中删除会撞上正在变的 messages，故此时不给）。
  // 选择态下让位给选择态自身交互；既无选中又不可删则不接管右键（放行系统默认菜单）。
  const onMsgsContextMenu = (e: React.MouseEvent): void => {
    if (selecting) return
    const selection = (window.getSelection()?.toString() ?? '').trim()
    const canDelete = !streaming && messages.length > 0
    // 命中某条消息（根节点带 data-msg）：有正文就也能「复制这条消息」，故不必先选中文字才接管右键。
    const hit = (e.target as HTMLElement).closest('[data-turn]') as HTMLElement | null
    const n = hit ? Number(hit.dataset.turn) : NaN
    const turn = Number.isInteger(n) && n >= 0 ? n : null
    const hitId = (e.target as HTMLElement).closest('[data-msg]')?.getAttribute('data-msg') ?? null
    const hitMsg = hitId ? messages.find((m) => m.id === hitId) : undefined
    const msgId = hitMsg && messageCopyText(hitMsg) ? hitId : null
    if (!selection && !canDelete && !msgId) return
    e.preventDefault()
    setCtxMenu({ x: e.clientX, y: e.clientY, turn, msgId, selection, canDelete })
  }
  // 复制选中文字到系统剪贴板：优先走原生 clipboard 桥（sandbox 下最稳），失败回退 navigator.clipboard。
  const copySelection = (text: string): void => {
    if (!text) return
    void window.Pal?.clipboard?.writeText(text).catch(() => {
      void navigator.clipboard?.writeText(text).catch(() => {})
    })
  }
  // 会话内消息被删空（选中全部轮）后自动退出选择态，避免停留在空白选择界面。
  useEffect(() => {
    if (selecting && messages.length === 0) exitSelect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages.length, selecting])

  // 新内容到达：仅当仍贴底才自动滚到底；用户上滚查看历史时保持不动。
  useEffect(() => {
    scheduleActive()
    if (!stickRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, streaming])

  // 切换会话（Conversation 不按会话重挂载）：复位贴底并直接滚到底；同时退出选择态（选择只属当前对话）。
  useEffect(() => {
    stickRef.current = true
    setAtBottom(true)
    setSelecting(false)
    setSelected(new Set())
    setCtxMenu(null)
    setRewind(null)
    setActiveTurn(-1)
    restoreRef.current = null
    pendingJumpRef.current = null
    pendingBottomRef.current = false
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [currentSessionId])

  // 换了渲染范围或消息整份重建后（刚打开 / 刚补过一段 / 刚跳转 / 删轮后）离边缘仍不远（内容填不满一屏等）：
  // 接着补，直到够滚动或到头。排在上面两个滚到底的副作用之后，量的是落位后的位置。
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (from > 0 && el.scrollTop < LOAD_MORE_PX) loadEarlier()
    else if (!isTail && el.scrollHeight - el.scrollTop - el.clientHeight < LOAD_MORE_PX) loadLater()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win, messages])

  // 监听用户滚动：据距底距离更新「是否贴底」，离已渲染内容的边缘不远时补一段。程序化滚到底同样触发，结果仍为贴底、幂等。
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBot = isTail && dist <= BOTTOM_THRESHOLD
    stickRef.current = atBot
    setAtBottom((prev) => (prev === atBot ? prev : atBot))
    scheduleActive()
    if (from > 0 && el.scrollTop < LOAD_MORE_PX) loadEarlier()
    else if (!isTail && dist < LOAD_MORE_PX) loadLater()
  }

  // 内容变矮或可视区变高后已到底（如上滚后收起展开的工作过程 / 思考，页面缩短、下方再无内容）：滚动位置常常
  // 没变，不触发 onScroll，贴底态停在「未贴底」，「回到最新」一直挂着。故在尺寸变化时补判一次。只补回到底部
  // 这一向：内容变高时不动贴底态，否则流式新内容撑高的那一刻（滚到底的副作用还没跑）会被误判为离底、断掉跟随。
  useEffect(() => {
    const el = scrollRef.current
    const inner = el?.firstElementChild
    if (!el || !inner || !isTail) return
    const ro = new ResizeObserver(() => {
      // 贴底时可视区变矮（如输入框上方多出一排胶囊：浏览器 / 待办 / 后台任务）：立刻贴回底部。否则最新的步骤、思考
      // 被挤到可视区下面，要等下一次内容更新才滚回来——Pal 正在执行耗时的步骤时，那一行会一直被挡着
      if (stickRef.current) {
        if (el.scrollHeight - el.scrollTop - el.clientHeight > 1) el.scrollTop = el.scrollHeight
        return
      }
      if (el.scrollHeight - el.scrollTop - el.clientHeight > BOTTOM_THRESHOLD) return
      stickRef.current = true
      setAtBottom(true)
    })
    ro.observe(el)
    ro.observe(inner)
    return () => ro.disconnect()
  }, [isTail])

  // 回到最新：平滑滚到底并恢复自动跟随。正看着跳转过去的一段时，换回最后几轮直接落到底，不滚过中间。
  const jumpToLatest = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = true
    setAtBottom(true)
    if (isTail) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else resetToTail()
  }

  // 发送后必看到自己的消息与回复：无论此刻是否上滚，都恢复贴底跟随。
  const handleSend = (text: string, attachments?: SendAttachment[]): Promise<boolean> => {
    stickRef.current = true
    setAtBottom(true)
    if (!isTail) resetToTail()
    return onSend(text, attachments)
  }

  // 底部工作状态行。本轮已有「工作过程」折叠条时，常规的「正在做什么 + 计时」已在折叠条里，只剩等待作答 /
  // 重连 / 压缩这些特殊状态；它们放进这条消息的末尾，紧跟步骤与卡片——放在消息列表下面的话，进行中消息底部
  // 撑住的空白（见 ConvMessage）会把它和上面的步骤隔开。还没有折叠条时照常放在列表下方。
  // 回复还什么都没出（请求中）时也放进这条消息，就在角色名下面、正文将出现的位置，显示为三个跳动的点；
  // 正文或思考一到即被替换。
  const lastMsg = messages[messages.length - 1]
  const folded = streaming && lastMsg?.role === 'assistant' && hasProcess(lastMsg.blocks)
  const blank =
    streaming &&
    lastMsg?.role === 'assistant' &&
    lastMsg.blocks.every((b) => b.kind === 'step' || (b.kind === 'text' && !b.text.trim()))
  const statusInMsg = folded || blank
  const statusLine = streaming ? (
    <StatusIndicator
      activity={deriveActivity(messages)}
      status={streamStatus}
      folded={folded}
      pending={blank}
      onStop={onStop}
    />
  ) : null

  // 单条消息渲染（选择态与常态复用；选择态下 active 恒 false，因选择只在非流式时可用）。
  // turn：常态渲染传入，标注到根 data-turn 供右键定位；选择态用卡片自身处理点击，无需传。
  const renderMsg = (m: ChatMessage, i: number, turn?: number): React.JSX.Element => (
    <ConvMessage
      key={m.id}
      msg={m}
      owner={owner}
      active={!selecting && streaming && i === messages.length - 1}
      latest={i === messages.length - 1}
      elapsedSec={i === messages.length - 1 ? streamStatus.elapsedSec : 0}
      footer={statusInMsg && !selecting && i === messages.length - 1 ? statusLine : undefined}
      dataTurn={turn}
      dataMsg={m.id}
      sessionId={currentSessionId}
      onAsk={onAsk}
      onPlan={onPlan}
      onMountReq={onMountReq}
      onOpenProposal={onOpenProposal}
      onOpenAutotask={onOpenAutotask}
    />
  )

  return (
    <main className="cf-conv">
      <div className="cf-conv__head">
        <button
          className="cf-idbtn"
          onClick={() => owner && onOpenProfile(owner.id)}
          title={t('cf.viewProfile')}
        >
          {/* 顶部只显示角色名称（去掉头像与描述行）；仍可点击打开资料卡。 */}
          <div className="cf-idbtn__name">{owner?.name ?? ''}</div>
        </button>
        {archived && (
          <>
            <span className="cf-conv__tag">
              <Archive size={11} />
              {t('cf.archivedTag')}
            </span>
            <button className="cf-conv__headbtn" onClick={onUnarchive}>
              <ArchiveRestore size={13} />
              {t('cf.unarchive')}
            </button>
          </>
        )}
        {/* 本会话累计用量：入/出 token 与缓存命中率，点开看明细。没有用量时组件自身返回 null。 */}
        <SessionUsageBar usage={usageOf(currentSessionId)} t={t} />
      </div>

      {/* 删除入口在聊天区右键唤起（见 onMsgsContextMenu）；选择态由右键菜单的「选择删除」开启。 */}
      {/* .cf-convmid 只为给右侧轮次索引面板提供定位上下文（.cf-msgs 自身会滚动，面板不能放里面）。 */}
      <div className="cf-convmid">
        <div
          className="cf-msgs"
          ref={scrollRef}
          onScroll={onScroll}
          onContextMenu={onMsgsContextMenu}
        >
          <div className={`cf-msgs__inner${selecting ? ' is-selecting' : ''}`}>
            {messages.length === 0 ? (
              <>
                <div className="cf-empty">
                  {owner ? (owner.desc ? `${owner.name} · ${owner.desc}` : owner.name) : ''}
                </div>
                {needModelSetup && <ModelSetupCard />}
              </>
            ) : selecting ? (
              // 选择态：按「轮」分组，每轮一张可勾选卡片；前言（turn<0）原样呈现、不可选。只画已渲染范围内的轮
              // （范围按整轮取，各轮要么整轮在内、要么整轮在外）。
              groupTurns(messages)
                .filter((g) => g.from >= from && g.to - 1 <= to)
                .map((g) => {
                  const items = messages.slice(g.from, g.to)
                  if (g.turn < 0)
                    return (
                      <Fragment key={`pre-${g.from}`}>
                        {items.map((m, k) => renderMsg(m, g.from + k))}
                      </Fragment>
                    )
                  const isSel = selected.has(g.turn)
                  return (
                    <div
                      key={`turn-${g.turn}`}
                      className={`cf-turn is-selectable${isSel ? ' is-selected' : ''}`}
                      role="button"
                      aria-pressed={isSel}
                      onClick={() => toggleTurn(g.turn)}
                    >
                      <span className="cf-turn__check" aria-hidden>
                        {isSel && <Check size={13} />}
                      </span>
                      <div className="cf-turn__body">
                        {items.map((m, k) => renderMsg(m, g.from + k))}
                      </div>
                    </div>
                  )
                })
            ) : (
              <>
                {messages.slice(from, to + 1).map((m, k) => renderMsg(m, from + k, turnOf[from + k]))}
                {isTail && !statusInMsg && statusLine}
                {/* 已有对话但模型被删光：引导卡接在末尾（不进对话记录）。 */}
                {isTail && needModelSetup && !streaming && <ModelSetupCard />}
              </>
            )}
          </div>
        </div>
        {/* 轮次索引：只在轮次够多且非选择态时出现（选择态要让位给勾选交互）。 */}
        {!selecting && tocItems.length >= TOC_MIN_TURNS && (
          <TurnIndex items={tocItems} active={activeTurn} onJump={jumpToTurn} />
        )}
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          items={[
            ...(ctxMenu.selection
              ? [
                  {
                    label: t('common.copy'),
                    icon: <Copy size={14} />,
                    onClick: () => copySelection(ctxMenu.selection)
                  }
                ]
              : []),
            // 命中的那条消息有正文才给：复制整条（含 Markdown 原文），不受选区影响。
            ...(ctxMenu.msgId
              ? [
                  {
                    label: t('chat.msg.copy'),
                    icon: <Copy size={14} />,
                    onClick: () => {
                      const m = messages.find((x) => x.id === ctxMenu.msgId)
                      if (m) copySelection(messageCopyText(m))
                    }
                  }
                ]
              : []),
            // 落在某一轮上才给：回到的是「这一轮开始之前」，前言区（压缩摘要等）不算轮。
            ...(ctxMenu.canDelete && ctxMenu.turn !== null && canRewind
              ? [
                  {
                    label: t('cf.rewind.here'),
                    icon: <RotateCcw size={14} />,
                    onClick: () => openRewind(ctxMenu.turn)
                  }
                ]
              : []),
            ...(ctxMenu.canDelete
              ? [
                  {
                    label: t('cf.selectToDelete'),
                    icon: <ListChecks size={14} />,
                    onClick: () => setSelecting(true)
                  }
                ]
              : [])
          ]}
        />
      )}

      {selecting ? (
        <div className="cf-selbar">
          <span className="cf-selbar__count">
            {locale === 'en'
              ? `${selected.size} selected`
              : `已选 ${selected.size} 轮`}
          </span>
          <div className="cf-selbar__actions">
            <button className="cf-selbar__btn" onClick={exitSelect}>
              {t('cf.selCancel')}
            </button>
            <button
              className="cf-selbar__btn cf-selbar__btn--danger"
              disabled={selected.size === 0}
              onClick={doDeleteSelected}
            >
              {t('cf.delete')}
            </button>
          </div>
        </div>
      ) : (
        <Composer
          sessionId={currentSessionId}
          owner={owner}
          streaming={streaming}
          focusRoot={focusRoot}
          onMount={onMount}
          onSend={handleSend}
          onStop={onStop}
          showJump={!atBottom && messages.length > 0}
          onJump={jumpToLatest}
          onRewind={() => openRewind()}
          prefill={prefill}
          onPrefillConsumed={onPrefillConsumed}
        />
      )}

      {rewind && (
        <RewindModal
          sessionId={currentSessionId}
          turns={tocItems}
          initialTurn={rewind.turn}
          promptOf={promptOf}
          onClose={() => setRewind(null)}
          onPrefill={onPrefill}
        />
      )}
    </main>
  )
}

/** 一条轮次索引项：turn 与 turnOf/groupTurns 同源的 0 基轮下标；text 已归一空白并限长。 */
interface TocItem {
  turn: number
  text: string
}

/**
 * 右侧对话轮次索引面板（对标 DeepSeek 网页版）：只索引用户消息，点击跳转、悬停看完整摘要、
 * 当前轮高亮。默认只显刻度短横线，悬停整条面板才展开为浮层文字列表，不压住正文；
 * 不随窗口宽度切换，任何宽度下行为一致。
 */
function TurnIndex({
  items,
  active,
  onJump
}: {
  items: TocItem[]
  /** 当前所在轮下标；-1 表示无。 */
  active: number
  onJump: (turn: number) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const listRef = useRef<HTMLDivElement>(null)
  // 悬停即展开浮层。展开与否决定索引项高度（收起时无文字），故须在高度实测之前就定下来。
  const [open, setOpen] = useState(false)

  // 一屏只放 TOC_VISIBLE_MAX 条：实测第 N 条底边定上限，其余靠列表自身滚动。
  // 用 layout 副作用（而非 effect）避免先铺满再收窄的一帧抖动。
  const [maxH, setMaxH] = useState<number | null>(null)
  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const nodes = list.querySelectorAll<HTMLElement>('.cf-toc__item')
    if (nodes.length <= TOC_VISIBLE_MAX) {
      setMaxH((p) => (p === null ? p : null))
      return
    }
    const measure = (): void => {
      // 取 rect 之差而非 offsetTop：列表已滚动时两者一起位移，差值仍是布局距离。
      const cs = getComputedStyle(list)
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      const top = nodes[0].getBoundingClientRect().top
      const bottom = nodes[TOC_VISIBLE_MAX - 1].getBoundingClientRect().bottom
      const h = Math.round(bottom - top + pad)
      setMaxH((p) => (p === h ? p : h))
    }
    measure()
    // 盯住首条而非列表自身：收起↔展开时列表宽度有 0.14s 过渡，只测一次会量到过渡中途
    // 的行高（窄宽度下文字多折一行），面板就会稳定地多显几条。观察条目宽度不会因为
    // 上限生效而变化，故不存在测量回环（观察列表则可能自激）。
    const ro = new ResizeObserver(measure)
    ro.observe(nodes[0])
    return () => ro.disconnect()
  }, [items, open])

  // 轮次多到列表内部要滚动时，保证高亮项始终可见。
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.cf-toc__item.is-active')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // 滚轮刻意不转发给对话：面板不在 .cf-msgs 内、列表又有 overscroll-behavior:contain，滚到头即停——
  // 浮层盖在正文之上，看索引时正文在底下跟着乱跑既晃眼、又会把高亮一路带走。
  return (
    <nav
      className={`cf-toc${open ? ' is-open' : ''}`}
      aria-label={t('cf.toc.title')}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <div
        className="cf-toc__list"
        ref={listRef}
        // 与 CSS 的 max-height:100% 取较小值：窗口矮于 10 条时以消息区高度为准。
        style={maxH === null ? undefined : { maxHeight: `min(${maxH}px, 100%)` }}
      >
        {items.map((it) => (
          <button
            key={it.turn}
            className={`cf-toc__item${it.turn === active ? ' is-active' : ''}`}
            aria-current={it.turn === active ? 'true' : undefined}
            title={it.text}
            onClick={() => onJump(it.turn)}
          >
            <span className="cf-toc__dash" aria-hidden />
            <span className="cf-toc__label">{it.text}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}

/** 用户消息文本默认最多显示的行数，超出即折叠。 */
const USER_TEXT_LINES = 3

/**
 * 用户消息正文：默认折叠到 {@link USER_TEXT_LINES} 行，超出时给出展开/收起按钮。
 * 折叠靠 CSS line-clamp，是否溢出则须实测——文本换行取决于主区宽度，无法静态判断。
 * clamp 落在内层 .cf-msg__clamp（无内边距），气泡 padding 留在外层 .cf-msg__text。
 */
function UserText({ text }: { text: string }): React.JSX.Element {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflow, setOverflow] = useState(false)

  // 只在收起态测量：此时 clientHeight 是 3 行高度、scrollHeight 是全文高度，二者不等即超出。
  // 展开态两者必然相等，故直接跳过、沿用上次判定，否则按钮会自己消失。
  useLayoutEffect(() => {
    if (expanded) return
    const el = ref.current
    if (!el) return
    const measure = (): void => setOverflow(el.scrollHeight - el.clientHeight > 1)
    measure()
    // 侧栏折叠、窗口缩放都会改变换行，需要重新判定。
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [text, expanded])

  return (
    <>
      <div className="cf-msg__text">
        {/* 折叠盒必须无内边距：气泡的下内边距会让被截断的下一行漏出「半个字」，详见 CSS 注释。 */}
        <div
          ref={ref}
          className={`cf-msg__clamp${expanded ? '' : ' is-clamped'}`}
          style={{ '--clamp-lines': String(USER_TEXT_LINES) } as React.CSSProperties}
        >
          {text}
        </div>
      </div>
      {overflow && (
        <button
          type="button"
          className="cf-msg__more"
          onClick={(e) => {
            // 选择态下整轮卡片本身可点选，展开/收起不应连带勾选。
            e.stopPropagation()
            setExpanded((v) => !v)
          }}
        >
          {t(expanded ? 'cf.msgCollapse' : 'cf.msgExpand')}
          <ChevronDown size={12} className={expanded ? 'is-up' : undefined} />
        </button>
      )}
    </>
  )
}

/**
 * 进行中消息出现这些元素时不撑住高度（见 ConvMessage）：工作过程里用户展开着的节点 / 折叠条，
 * 以及还在等用户处置的问答、计划、挂载卡。
 */
const NO_HOLD =
  '.msg__process [aria-expanded="true"], .ask:not(.is-answered), .msg__plan:not(.is-decided), .msg__mount:not(.is-decided)'

import { MessageActions, MessageCopyButton, messageCopyText } from './message-actions'

/** 单条消息：IM 头像外壳 + 复用 features/chat/blocks 的 BlockView（安全渲染器不重写）。 */
function ConvMessage({
  msg,
  owner,
  active,
  latest,
  elapsedSec,
  footer,
  dataTurn,
  dataMsg,
  sessionId,
  onAsk,
  onPlan,
  onMountReq,
  onOpenProposal,
  onOpenAutotask
}: {
  msg: ChatMessage
  owner?: Persona
  active: boolean
  /** 是否为对话里最后一条消息（进行中撑住的高度在它不再是最后一条时释放）。 */
  latest: boolean
  /** 本轮已用秒数（进行中的折叠条标题末尾显示；只对 active 的消息有意义）。 */
  elapsedSec: number
  /** 接在消息内容末尾的底部状态行（只交给进行中的那条：已有折叠条时是等待作答 / 重连 / 压缩，还没内容时是思考中）。 */
  footer?: React.ReactNode
  /** 该消息所属的对话轮下标（0 基）；标注在根节点上，供右键菜单定位「删除此轮」。前言/未知为 undefined。 */
  dataTurn?: number
  /** 消息 id：标在根节点 data-msg 上，右键菜单据此反查正文（见 onMsgsContextMenu）。 */
  dataMsg?: string
  /** 所属会话 id：回答反馈按 `<sessionId>:<turn>` 存本地，需它做键。 */
  sessionId: string
  onAsk: (key: string, answers: string[]) => void
  onPlan: (key: string, decision: 'approve' | 'keep' | 'ignore', feedback?: string) => void
  onMountReq: (key: string, path: string | null) => void
  onOpenProposal: (block: Extract<ChatBlock, { kind: 'agentcard' }>) => void
  onOpenAutotask: (taskId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  // 「工作过程」是否展开：进行中与结束后都默认收起；用户点开后在本次挂载内保持（跨过回合结束也不变）。
  const [processOpen, setProcessOpen] = useState(false)
  // 进行中消息高度只增不减：当前步骤区域随内容伸缩（5 个并行工具 → 1 行思考 → 1 个工具）、中间说明收进
  // 折叠条，都会让消息变矮，页面跟着上下拉扯。故把本轮出现过的最大高度记作最小高度，空出的地方留在消息
  // 底部。回合结束后用 0.25s 平滑收回到实际高度（直接释放的话，最终回复很短时会一下缩掉一大截）。
  // 用户在消息里点了按钮（开合折叠条、思考 / 子智能体节点、各种卡片）立即释放：那是有意的伸缩，
  // 否则点开思考再收起，撑高的那截会一直留着，「回到最新」就落到一片空白上。
  // 以下两种情况不记高度（见 NO_HOLD），恢复后从当时的高度重新记：
  // · 工作过程里有用户展开着的东西（折叠条本身、计划 / 思考 / 提问等节点）：展开的节点可能随后被自动换掉
  //   （当前步骤前进到下一步），它撑出的高度不该留下。
  // · 有等你处置的问答 / 计划 / 挂载卡：回合停着等你，本无抖动可防；处置后卡片收进折叠条是你造成的收缩，
  //   而且常是在输入框里按回车提交，不经过按钮点击，上面的释放管不到。
  const contentRef = useRef<HTMLDivElement>(null)
  const peakRef = useRef(0)
  const releasePeak = (): void => {
    peakRef.current = 0
    const el = contentRef.current
    if (!el) return
    el.style.transition = ''
    el.style.minHeight = ''
  }
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    if (active) {
      const ro = new ResizeObserver(() => {
        if (el.querySelector(NO_HOLD)) {
          if (peakRef.current) releasePeak()
          return
        }
        const h = el.getBoundingClientRect().height
        if (h > peakRef.current) {
          peakRef.current = h
          el.style.minHeight = `${h}px`
        }
      })
      ro.observe(el)
      return () => ro.disconnect()
    }
    // 回合结束：撑住的空白平滑收回。先量出不撑时的实际高度，再从撑住的高度过渡过去。
    const held = el.style.minHeight
    if (!held) return
    releasePeak()
    const natural = el.getBoundingClientRect().height
    if (natural >= parseFloat(held) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    el.style.minHeight = held
    void el.getBoundingClientRect() // 让过渡从撑住的高度起步
    el.style.transition = 'min-height 0.25s ease'
    el.style.minHeight = `${natural}px`
    const timer = setTimeout(releasePeak, 300)
    return () => clearTimeout(timer)
  }, [active])
  useLayoutEffect(() => {
    if (!latest) releasePeak()
  }, [latest])
  // 后台任务通知（后台子智能体结束后自动起的那一轮的起点）：一行居中的系统通知，不画成用户气泡。
  // 仍保留 is-user + data-turn：它是一轮的起点，右键删轮 / 跳转定位都靠它。
  if (msg.role === 'user' && msg.notify) {
    const text = msg.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('')
    return (
      <div className="cf-msg is-user is-notify" data-turn={dataTurn} data-msg={dataMsg}>
        <div className="cf-notify">
          <Bot size={13} />
          <span>{text || t('chat.subagent.notify')}</span>
        </div>
      </div>
    )
  }
  // 压缩摘要（较早的对话已收成它）：一行居中提示 + 折叠的摘要，不画头像与角色名——那不是角色说的话。
  const only = msg.blocks.length === 1 ? msg.blocks[0] : undefined
  if (msg.role === 'assistant' && only?.kind === 'compaction') {
    return (
      <div className="cf-msg is-compaction" data-turn={dataTurn} data-msg={dataMsg}>
        <CompactionNotice summary={only.summary} />
      </div>
    )
  }
  if (msg.role === 'user') {
    const text = msg.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('')
    return (
      <div className="cf-msg is-user" data-turn={dataTurn} data-msg={dataMsg}>
        <div className="cf-msg__body">
          <MessageCopyButton getText={() => text} />
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="msg__attachments">
              {msg.attachments.map((a, i) => (
                <span key={i} className="attach-chip attach-chip--sent" title={a.name}>
                  {iconFor(a.kind)}
                  <span className="attach-chip__name">{a.name}</span>
                </span>
              ))}
            </div>
          )}
          {text && <UserText text={text} />}
        </div>
        <Avatar user size={32} />
      </div>
    )
  }
  // 仍在流式输出的那一块（只有进行中的回合才有）：思考据此判断是否已完成，按引用比对。
  const liveBlock = active ? msg.blocks[msg.blocks.length - 1] : undefined
  // 连续的思考 / 工具调用 / 子智能体画成一条时间轴（见 groupBlocks）；其余块逐个原样渲染。
  // notesInline：工作过程里夹着的正文是中间说明，作为时间轴上的说明节点，不打断时间轴。
  const renderBlocks = (blocks: ChatBlock[], notesInline = false): React.ReactNode =>
    groupBlocks(blocks, notesInline).map((item) =>
      item.type === 'timeline' ? (
        <Timeline key={item.key} steps={item.steps} liveBlock={liveBlock} />
      ) : (
        <BlockView
          key={item.index}
          block={item.block}
          thinkingDone={item.block !== liveBlock}
          onAsk={onAsk}
          onPlan={onPlan}
          onMountReq={onMountReq}
          onOpenProposal={onOpenProposal}
          onOpenAutotask={onOpenAutotask}
        />
      )
    )
  // 思考 / 工具调用等过程收进「工作过程」折叠条，名片等固定块与回复正文留在外面（见 splitProcess）；
  // 交付卡在回合结束后排在最后（见 DeliveryCards）。
  // 进行中同样默认收起，收起时折叠条下露出当前步骤（并行执行的一并列出，最多 5 行，见 currentSteps）；
  // 最近一步之后已在输出正文或出了卡片时不露。
  // 当前步骤正是流式输出中的思考：折叠条标题直接写「思考中」，下面只露实时小窗，不再重复一行「思考中」
  // 节点（点折叠条展开整条时间轴即可看全文）。
  const split = splitProcess(msg.blocks, active)
  const current = split && active ? currentSteps(msg.blocks) : []
  const step = current.length === 1 ? current[0] : undefined
  const liveThinking = step?.kind === 'thinking' && step === liveBlock ? step : undefined
  const preview =
    current.length > 0 ? (
      liveThinking ? (
        liveThinking.text.trim() && <LiveThinkingWindow text={liveThinking.text} />
      ) : (
        <Timeline
          steps={current.map((b) => ({ block: b, index: msg.blocks.indexOf(b) }))}
          liveBlock={liveBlock}
          compact
          limit={5}
        />
      )
    ) : undefined
  // 有工作过程时，角色名与折叠条同一行（「Pal › 已处理 … · N 步」）；没有时单独一行。
  const name = <span className="cf-msg__name">{owner?.name ?? t('cf.assistant')}</span>
  return (
    <div className="cf-msg" data-turn={dataTurn} data-msg={dataMsg}>
      <Avatar persona={owner} size={32} />
      <div className="cf-msg__body">
        {!split && <div className="cf-msg__head">{name}</div>}
        <div
          className="msg__content"
          ref={contentRef}
          onClickCapture={(e) => {
            if ((e.target as HTMLElement).closest('button')) releasePeak()
          }}
        >
          {split ? (
            <>
              <ProcessFold
                blocks={split.process}
                durationMs={msg.durationMs}
                live={active}
                thinking={Boolean(liveThinking)}
                elapsedSec={active ? elapsedSec : undefined}
                preview={preview}
                open={processOpen}
                onToggle={() => setProcessOpen((v) => !v)}
                lead={name}
              >
                {renderBlocks(split.process, true)}
              </ProcessFold>
              {renderBlocks(split.visible)}
            </>
          ) : (
            renderBlocks(msg.blocks)
          )}
          {!active && <DeliveryCards blocks={msg.blocks} />}
          {footer}
        </div>
        {/* 操作行：复制 + 回答反馈，排在正文下方新的一行、左对齐。流式中不出现。 */}
        {!active && dataTurn !== undefined && (
          <MessageActions
            getText={() => messageCopyText(msg)}
            sessionId={sessionId}
            turn={dataTurn}
          />
        )}
      </div>
    </div>
  )
}






/**
 * 模型选择器。复用 app.css 的既有类
 * （model-pick / chip / model-pick__backdrop / model-pick__menu），零新增 CSS。
 * 只列「已启用服务商 × 已启用模型」，按服务商分组。
 * 切换时做两件事：① 写当前对话覆盖层并立即落库到会话属性（setSessionModel，切了不发重启也不丢），
 * 故同角色的多个对话可各用不同模型；② 把这次选择记为「最近使用模型」（setActiveModel）——本应用不设
 * 显式「默认模型」，最近一次在此切换的模型即充当**新对话未选时的默认**（见 store/models.tsx activeModelId）。
 * 显示的是**本对话生效模型**：本对话已选则显示所选；未选 / 所选模型已被删除 → 回落最近使用模型
 * activeModel 显示（与主进程 resolveModelRef 的兜底一致，删除的偏好模型自动回归最近使用）。
 * 菜单向上弹出（.model-pick__menu 的 bottom:calc(100%+8px)），锚在输入区工具条恰在屏内。
 */

import { PersonaEditor, ProfileView, type EditorState } from './profile-pane'
import { Settings, type SettingsInit } from './settings-pane'

/* ============================ 通用小件 ============================ */
// 全应用头像（角色 / 人类用户）统一走 Humation：
//  - 角色：seed=persona.id，叠加其 avatar spec（若有）。
//  - 用户：个人资料里的头像（图片 / spec；未配置时主进程回默认头像），读到前回落固定 seed（USER_AVATAR_SEED）。
// 结构：外层 .cf-ava 作定位框，内层 .cf-ava__face 圆形裁剪头像（无描边）。
function Avatar({
  persona,
  user,
  size,
  busy,
  attention,
  unread
}: {
  persona?: Persona
  user?: boolean
  size?: number
  /** 忙碌（对话生成中）：头像上叠一道自左向右扫过的高光带，作就地「思考/生成中」指示。 */
  busy?: boolean
  /** 待你处理（问答 / 计划 / 挂载 / 待确认名片）：右上角红点。 */
  attention?: boolean
  /** 有新消息未读：右上角红点。 */
  unread?: boolean
}): React.JSX.Element | null {
  const profile = useProfile()
  const style = { ...(size ? { '--sz': `${size}px` } : {}) } as React.CSSProperties
  const cls = `cf-ava${busy ? ' is-busy' : ''}${user ? ' is-user' : ''}`
  // 遮层必须排在 .cf-ava__face 之后：同为 inset:0 的绝对定位兄弟，靠文档顺序压在头像之上；红点再压在最上。
  const sweep = busy ? <span className="cf-ava__sweep" aria-hidden="true" /> : null
  const marks = unread || attention ? <span className="cf-ava__dot" aria-hidden="true" /> : null
  // 非用户、非角色（理论上罕见）：空占位圈。
  if (!user && !persona)
    return (
      <div className={cls} style={style}>
        {sweep}
        {marks}
      </div>
    )
  const seed = user ? USER_AVATAR_SEED : (persona as Persona).id
  const spec = user ? profile.avatar : parseAvatarSpec((persona as Persona).avatar)
  const title = user
    ? undefined
    : `${(persona as Persona).name} · ${(persona as Persona).desc}${(persona as Persona).model ? ` · ${(persona as Persona).model}` : ''}`
  return (
    <div className={cls} style={style} title={title}>
      <span className="cf-ava__face">
        <PersonaFace
          seed={seed}
          spec={spec}
          image={user ? profile.avatarImage : (persona as Persona).avatarImage}
          title={title}
        />
      </span>
      {sweep}
      {marks}
    </div>
  )
}
