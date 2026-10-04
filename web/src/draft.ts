// 输入框草稿：按会话（新会话按目录）存在 localStorage，切走再回来、刷新、回前台被系统重载后都还在
const key = (k: string) => `ccr-draft:${k}`

export const loadDraft = (k: string) => localStorage.getItem(key(k)) ?? ''

export function saveDraft(k: string, text: string) {
  if (text.trim()) localStorage.setItem(key(k), text)
  else localStorage.removeItem(key(k))
}
