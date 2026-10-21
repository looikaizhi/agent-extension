/**
 * S-03 的第二层：判的不是「这个元素是不是填密码的地方」，而是**「这段字符串本身像不像一个密钥」**。
 *
 * `sensitive.ts` 开头有一道 `entry` 闸门——不是 input/textarea/textbox/contenteditable 的一律返回
 * false。那个闸门是对的：`input[type=password]` 根本没有 ARIA role，只能按结构判。但它因此**完全看不见
 * 「显示出来的密钥」**：设置页上那串 API key 文本、恢复码、表格单元里的 token。
 *
 * 今天已经存在的口子是 `<button aria-label="复制 sk-live-…">`：那串东西就是这个按钮的可访问名，
 * 会原样进表、原样发往端点。名字只做 `NAME_MAX_LEN` 截断，不做任何脱敏。
 *
 * 所以这一层按**值**判，不按元素判，两者互不替代：
 * - 元素级（`isSensitive`）要看活的 DOM，管的是「别让模型指着它让用户填」。
 * - 值级（这里）是纯字符串，管的是「别把它发出去」。纯函数意味着它能在单元层被测透，不需要 DOM。
 *
 * **替换而不是删除。** 一个悄悄消失的名字会让模型以为那个控件不存在，然后去猜；说出来才能让它绕开。
 * 和元素表尾部的 `omitted` 计数是同一个道理。
 */

/** 顶掉密钥之后留在原地的话。说出来，不是删掉。 */
export const REDACTED = '〔一串像密钥的内容，已隐去〕';

/**
 * 形态判据，一条一个来源。**只认有前缀或有结构的形态**，不认「长得随机」。
 *
 * 熵判据（「这段字符看起来很随机」）在这份语料上试不通：真实页面里到处是 commit SHA、构建号、
 * 资源 id、CSS 类名哈希。一条按熵下手的判据会把它们全吃掉，而它们正是模型用来分辨「哪一行是哪一行」
 * 的东西——去重那条规格花了很大力气才把这类区分留住。
 *
 * 宁可漏掉没有前缀的自定义密钥，也不能把 40 位的 commit SHA 当密钥吞掉：前者的下游还有别的防线
 * （用户自己不会把密钥贴在导航栏上），后者会直接让引导指不准。
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,          // OpenAI / Stripe 一类的前缀式密钥
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,               // GitHub personal access token
  /\bAKIA[0-9A-Z]{16}\b/,                       // AWS access key id
  /\bLTAI[A-Za-z0-9]{12,}/,                     // 阿里云 AccessKey ID
  /\bAIza[A-Za-z0-9_-]{30,}/,                   // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,             // Slack token
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./, // JWT：三段式本身就是结构，不靠熵
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,          // PEM 私钥块
];

/**
 * 命中任意一条形态的字符串，整条换成 `REDACTED`。
 *
 * 整条换掉而不是只换命中那一段：一个密钥被部分打码之后剩下的那一半仍然是密钥的一半，
 * 而这个函数的调用点（`toPromptText`）之后就是网络。
 */
export function redact(s: string): string {
  for (const re of SECRET_SHAPES) if (re.test(s)) return REDACTED;
  return s;
}

/** 这段字符串里是否含有像密钥的东西。给守卫与测试用，产品路径上只需要 `redact`。 */
export function looksSecret(s: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(s));
}
