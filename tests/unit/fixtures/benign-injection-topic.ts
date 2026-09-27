/**
 * The control group. A page can legitimately contain
 * an ordinary technical paragraph *about* prompt injection (a security blog
 * post, a vendor's docs page) as a control's name or description. Nothing in
 * S1 is allowed to treat that paragraph specially: no keyword scan, no
 * stripping, no truncation. §8.1 of the design doc is explicit that S-01
 * does no semantic detection precisely because that heuristic would misfire
 * on content like this — the exact content a safety-conscious page is most
 * likely to contain.
 *
 * This is deliberately full of the phrases a keyword filter would key on
 * ("忽略之前的指令", "ignore previous instructions", "prompt injection")
 * while itself being ordinary descriptive prose, not an attack.
 */
export const BENIGN_INJECTION_TOPIC_PARAGRAPH =
  '提示注入攻击（prompt injection）是指攻击者在模型会读取的内容中嵌入类似“忽略之前的指令”这样的文本，' +
  '试图让大语言模型偏离原本的系统指令，转而执行攻击者写下的新指令。防御思路通常不是去扫描这类关键词——' +
  '关键词黑名单既拦不住所有变体，又会把正常讨论这个话题的技术文章一并误伤。更可靠的做法是结构性隔离：' +
  '把不可信内容放进模型无法预测、也无法提前闭合的边界里，使其在协议层面上不可能被解释成指令，而不是依赖' +
  '模型自己判断“这段话是不是在指挥我”。';
