/**
 * 消息操作：复制整条 + 回答反馈（好的 / 有问题）。
 *
 * 自 ChatFirstShell.tsx 拆出——这些是**叶子组件**，只依赖 i18n / 图标 / ChatMessage 类型，
 * 不碰会话编排状态，放在外壳文件里只会让七千行的那份更难读。
 *
 * 反馈标记存 localStorage（键 `pal.answer-feedback.v1`，按 `<sessionId>:<turn>`），
 * 不写会话文件、不占主进程状态；代价是回滚/删除较早轮次会让后续轮次下标平移，旧标记可能错位。
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ThumbsDown, ThumbsUp } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import type { ChatMessage } from '../store/chat'
/**
 * 单条消息的可复制正文（纯文本 / Markdown 原文），供「复制整条」用。
 *
 * 只取用户真正读到的正文：text、insert（注入的补充说明）、error、compaction 摘要。
 * 刻意跳过 thinking（内部推理）、tool（调用参数，通常又长又没意义）、agentcard / plan / ask 等交互卡
 * （它们是结构不是文字），以及 notice（系统提示）。这样复制出来的就是「这条消息说了什么」。
 * 不取 DOM textContent：那样会带上按钮标签、代码块表头的语言名，也丢了 Markdown 原文的格式。
 */
export function messageCopyText(msg: ChatMessage): string {
  const parts: string[] = []
  for (const b of msg.blocks) {
    switch (b.kind) {
      case 'text':
      case 'insert':
        if (b.text.trim()) parts.push(b.text)
        break
      case 'error':
        if (b.message.trim()) parts.push(b.message)
        break
      case 'compaction':
        if (b.summary.trim()) parts.push(b.summary)
        break
      default:
        break
    }
  }
  return parts.join('\n\n')
}

/**
 * 消息级的「复制」按钮：悬停在消息上浮现，点击复制该条消息正文。
 * 与代码块表头的 CopyButton 分开——那个只复制一个代码块，这里复制整条消息。
 * 复制走原生 clipboard 桥（sandbox 下最稳），失败回退 navigator.clipboard；成功后 1.5 秒显示「已复制」。
 */
export function MessageCopyButton({
  getText,
  inline = false
}: {
  getText: () => string
  /** true = 作为操作行的一员静态排布（左下角），不采用「悬停浮现 + 绝对定位」的那套。 */
  inline?: boolean
}): React.JSX.Element | null {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    []
  )
  const copy = (e: React.MouseEvent): void => {
    e.stopPropagation()
    const text = getText()
    if (!text) return
    const done = (): void => {
      setCopied(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 1500)
    }
    const fallback = (): void => {
      void navigator.clipboard?.writeText(text).then(done).catch(() => {})
    }
    const bridge = window.Pal?.clipboard
    if (bridge) void bridge.writeText(text).then(done).catch(fallback)
    else fallback()
  }
  // 没有正文的消息（纯工具调用 / 只有交互卡）不显示按钮
  if (!getText()) return null
  return (
    <button
      type="button"
      className={inline ? 'cf-msg__copy cf-msg__copy--inline' : 'cf-msg__copy'}
      onClick={copy}
      title={copied ? t('chat.md.copied') : t('chat.msg.copy')}
      aria-label={copied ? t('chat.md.copied') : t('chat.msg.copy')}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  )
}

/* ============================ 回答反馈（好的 / 有问题） ============================ */

type AnswerFeedback = 'good' | 'bad'

/**
 * 反馈落 localStorage：跨重启保留，不占主进程状态、不入会话文件。
 * 键 = `<sessionId>:<turn>` —— 一个回合至多一条助手回复，故足够稳定；
 * 但**回滚 / 删除较早轮次会让后面的轮次下标平移**，那些旧标记会错位到别的回答上。
 * 这是纯本地标注的已知边界：要真正可靠得在会话里按消息落一个持久 id（见后续可选项）。
 */
const FEEDBACK_STORE_KEY = 'pal.answer-feedback.v1'

function readFeedbackStore(): Record<string, AnswerFeedback> {
  try {
    const raw = localStorage.getItem(FEEDBACK_STORE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, AnswerFeedback>) : {}
  } catch {
    return {}
  }
}

function writeFeedbackStore(map: Record<string, AnswerFeedback>): void {
  try {
    localStorage.setItem(FEEDBACK_STORE_KEY, JSON.stringify(map))
  } catch {
    /* 存不下（配额满 / 隐私模式）不影响本次会话内的标记 */
  }
}

/**
 * 助手回复底部操作行：复制 + 「好的回答」/「有问题的回答」。
 * 排在正文下方新的一行、左对齐；只在回合结束（非流式）且确有正文时出现。
 */
export function MessageActions({
  getText,
  sessionId,
  turn
}: {
  getText: () => string
  sessionId: string
  turn: number
}): React.JSX.Element {
  const { t } = useI18n()
  const key = `${sessionId}:${turn}`
  const [value, setValue] = useState<AnswerFeedback | null>(() => readFeedbackStore()[key] ?? null)

  // 同一实例被复用到另一条消息时（列表重排），重新读该键下的既有标记。
  useEffect(() => {
    setValue(readFeedbackStore()[key] ?? null)
  }, [key])

  const pick = (next: AnswerFeedback) => (e: React.MouseEvent): void => {
    e.stopPropagation()
    const v = value === next ? null : next
    setValue(v)
    const map = readFeedbackStore()
    if (v) map[key] = v
    else delete map[key]
    writeFeedbackStore(map)
  }

  return (
    <div className="cf-msg__actions">
      <MessageCopyButton inline getText={getText} />
      <button
        type="button"
        className={`cf-act${value === 'good' ? ' is-on is-good' : ''}`}
        onClick={pick('good')}
        aria-pressed={value === 'good'}
        aria-label={t('cf.answerGood')}
        title={t('cf.answerGoodHint')}
      >
        <ThumbsUp size={13} />
      </button>
      <button
        type="button"
        className={`cf-act${value === 'bad' ? ' is-on is-bad' : ''}`}
        onClick={pick('bad')}
        aria-pressed={value === 'bad'}
        aria-label={t('cf.answerBad')}
        title={t('cf.answerBadHint')}
      >
        <ThumbsDown size={13} />
      </button>
    </div>
  )
}

