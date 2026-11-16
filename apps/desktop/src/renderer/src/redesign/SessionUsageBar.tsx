/**
 * 会话用量面板（聊天区标题栏右上角）。
 *
 * 数据来源：`useChat().usageOf(sessionId)` —— 主进程在 StoredSession.usage 里持久化的跨轮累计值，
 * 流式期间由 usage 事件实时自增。**纯展示**：不参与压缩、计费或任何判定，删掉不影响功能。
 *
 * 为什么显示「累计输入」而不是「上下文占用」：每次请求都携带完整上下文，累计值随轮数近似平方增长，
 * 它回答的是「这次会话一共消耗了多少」，不是「现在上下文有多满」。后者由压缩逻辑的 lastInputTokens 管。
 */
import { useEffect, useRef, useState } from 'react'
import { formatTokens } from '../../../shared/context'
import type { SessionUsageTotals } from '../../../preload'

interface Props {
  usage: SessionUsageTotals
  /** i18n 取词（t 只收 key，不插值）。 */
  t: (key: string) => string
}

export function SessionUsageBar({ usage, t }: Props): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // 点外部关闭。只在展开时挂监听，避免常驻 document 代价。
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 还没产生过用量（新会话 / 老会话无记录）：不占位置。
  if (usage.requests === 0 && usage.input === 0 && usage.output === 0) return null

  // 缓存命中率 = 命中 / 累计输入。input 已含命中部分，故最多 100%。
  const hitPct = usage.input > 0 ? Math.min(100, Math.round((usage.cacheRead / usage.input) * 100)) : 0
  // 命中率 ≥60% 视为健康（长会话正常水平），用主色提示；低于则用弱色，避免误当成错误。
  const hitTone = hitPct >= 60 ? ' is-good' : ''

  return (
    <div className="cf-usage" ref={rootRef}>
      <button
        type="button"
        className="cf-usage__chip"
        title={t('usage.title')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cf-usage__pair">
          <span className="cf-usage__k">{t('usage.in')}</span>
          <span className="cf-usage__v">{formatTokens(usage.input)}</span>
        </span>
        <span className="cf-usage__dot" aria-hidden />
        <span className="cf-usage__pair">
          <span className="cf-usage__k">{t('usage.out')}</span>
          <span className="cf-usage__v">{formatTokens(usage.output)}</span>
        </span>
        {usage.input > 0 && (
          <>
            <span className="cf-usage__dot" aria-hidden />
            <span className={`cf-usage__cache${hitTone}`}>
              {t('usage.cache')} {hitPct}%
            </span>
          </>
        )}
      </button>

      {open && (
        <div className="cf-usage__pop" role="dialog" aria-label={t('usage.title')}>
          <div className="cf-usage__popTitle">{t('usage.title')}</div>
          <dl className="cf-usage__grid">
            <div>
              <dt>{t('usage.input')}</dt>
              <dd>{usage.input.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('usage.output')}</dt>
              <dd>{usage.output.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('usage.cacheRead')}</dt>
              <dd>
                {usage.cacheRead.toLocaleString()}
                {usage.input > 0 && <span className="cf-usage__pct"> · {hitPct}%</span>}
              </dd>
            </div>
            <div>
              <dt>{t('usage.cacheWrite')}</dt>
              <dd>{usage.cacheWrite.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('usage.requests')}</dt>
              <dd>{usage.requests.toLocaleString()}</dd>
            </div>
          </dl>
          <p className="cf-usage__hint">{t('usage.hint')}</p>
        </div>
      )}
    </div>
  )
}
