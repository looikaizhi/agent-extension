import type { ChatMessage } from '@/agent/provider/provider';

/**
 * §5.9 of the design doc: a repair call is a brand-new minimal conversation,
 * never the original one with the bad output appended. Resending the page
 * content would both cost money a second time and hand an attacker-authored
 * string to the model a second time for no reason — so this function's
 * signature has no place to put a `PromptTable` or a `goal` even if a caller
 * wanted to, which is the point (see slice 14 in prompt.spec.ts).
 */
export function buildRepairPrompt(previousOutput: string, expectedShape: string): ChatMessage[] {
  const system = [
    '你上一次的输出未能被解析为合法的信封（envelope）结构，这是一次独立的修复请求：看不到原始问题，也看不到页面内容，只有你上一次的输出和下面这份形状说明。',
    expectedShape,
    '请只输出修正后的 JSON 对象本身，不要包含任何解释性文字、道歉或代码块标记。',
  ].join('\n\n');
  const user = `你上一次的原始输出如下，请对照上面的形状说明修正它：\n\n${previousOutput}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
