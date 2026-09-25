import { micromark } from 'micromark'
import { gfm, gfmHtml } from 'micromark-extension-gfm'

// micromark 默认安全：原始 HTML 会被转义，javascript: 之类的链接会被去掉
const toHtml = (text: string) =>
  micromark(text, { extensions: [gfm()], htmlExtensions: [gfmHtml()] }).replaceAll(
    '<a href=',
    '<a target="_blank" rel="noreferrer" href=',
  )

export function Markdown(props: { text: string; class?: string }) {
  return <div class={props.class ? `md ${props.class}` : 'md'} innerHTML={toHtml(props.text)} />
}
