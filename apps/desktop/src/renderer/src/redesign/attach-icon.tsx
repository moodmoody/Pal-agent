/**
 * 附件类型 → 图标。输入框的待发附件、已发送附件的气泡都用它，抽出来避免两边各写一份。
 */
import { FileCode2, FileText, Image as ImageIcon, Paperclip } from 'lucide-react'
import type { AttachKind } from '../store/chat'

export function iconFor(kind: AttachKind): React.ReactNode {
  if (kind === 'image') return <ImageIcon size={13} />
  if (kind === 'document') return <FileText size={13} />
  if (kind === 'text') return <FileCode2 size={13} />
  return <Paperclip size={13} />
}
