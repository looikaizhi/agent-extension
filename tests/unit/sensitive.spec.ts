import { describe, expect, it } from 'vitest';
import { isSensitive } from '@/core/security/sensitive';

/**
 * S-03 had no unit test at all, which is why the bypass below survived.
 *
 * The e2e suite does exercise `isSensitive`, but only along two paths that both
 * return before the attribute scan: `smoke.mjs:178` uses `type=password` (early
 * return) and `smoke.mjs:180` uses an `<a>` (rejected at the `entry` gate). The
 * BENIGN branch — the one that decides whether a field that *mentions*
 * credentials is one — had never been executed by any test.
 *
 * The suite runs in `environment: 'node'`, so the element is a stand-in. That is
 * the right level here: the defect was in the decision logic, not in the DOM
 * reading, and a stand-in that returns `null` for absent attributes models the
 * only DOM behaviour this function depends on.
 */
type Attrs = Partial<Record<'name' | 'id' | 'aria-label' | 'placeholder' | 'inputmode' | 'autocomplete', string>>;

function el(
  localName: string,
  attrs: Attrs = {},
  extra: { type?: string; contentEditable?: boolean } = {},
): Element {
  return {
    localName,
    type: extra.type,
    isContentEditable: extra.contentEditable === true,
    getAttribute: (k: string) => (attrs as Record<string, string | undefined>)[k] ?? null,
  } as unknown as Element;
}

describe('isSensitive —— S-03 判定', () => {
  it('结构性入口之外一律不敏感（链接提到密码也不算）', () => {
    expect(isSensitive(el('a', { 'aria-label': 'Forgot your password?' }), 'link')).toBe(false);
    expect(isSensitive(el('button', { 'aria-label': '重置密码' }), 'button')).toBe(false);
  });

  it('input[type=password] 永远敏感，不看任何属性', () => {
    expect(isSensitive(el('input', {}, { type: 'password' }), '')).toBe(true);
  });

  it('autocomplete 提示优先于文本判定', () => {
    expect(isSensitive(el('input', { autocomplete: 'current-password' }, { type: 'text' }), 'textbox')).toBe(true);
    expect(isSensitive(el('input', { autocomplete: 'cc-number' }, { type: 'text' }), 'textbox')).toBe(true);
    expect(isSensitive(el('input', { autocomplete: 'one-time-code' }, { type: 'text' }), 'textbox')).toBe(true);
  });

  it('单个属性内的良性提及不算敏感', () => {
    expect(isSensitive(el('input', { 'aria-label': 'Password policy' }, { type: 'text' }), 'textbox')).toBe(false);
    expect(isSensitive(el('input', { 'aria-label': '密码找回说明' }, { type: 'text' }), 'textbox')).toBe(false);
  });

  it('与凭据无关的字段不敏感', () => {
    expect(isSensitive(el('input', { name: 'project_name', 'aria-label': '项目名称' }, { type: 'text' }), 'textbox')).toBe(false);
  });

  /**
   * The regression that motivated this file. Against the previous
   * implementation — five attributes joined into one string, then BENIGN tested
   * over the join — every case here returned `false`, and a credential field
   * would have been offered to the user as a guide target.
   */
  describe('一个属性里的良性词不得取消另一个属性里的敏感词', () => {
    it('中文：aria-label 敏感 + id 良性', () => {
      expect(
        isSensitive(el('input', { 'aria-label': '请输入登录密码', id: 'help' }, { type: 'text' }), 'textbox'),
      ).toBe(true);
    });

    it('英文：aria-label 敏感 + name 良性', () => {
      expect(
        isSensitive(el('input', { 'aria-label': 'Enter your password', name: 'help' }, { type: 'text' }), 'textbox'),
      ).toBe(true);
    });

    it('2FA：placeholder 敏感 + id 良性', () => {
      expect(
        isSensitive(el('input', { placeholder: '验证码', id: 'help-doc' }, { type: 'text' }), 'textbox'),
      ).toBe(true);
    });

    it('卡号：name 敏感 + placeholder 良性', () => {
      expect(
        isSensitive(el('input', { name: 'card_number', placeholder: '见帮助文档' }, { type: 'text' }), 'textbox'),
      ).toBe(true);
    });
  });

  it('<label for> 关联的文本同样参与判定（最常见的表单写法）', () => {
    const withLabel = (text: string, attrs: Attrs = {}) =>
      ({
        ...(el('input', attrs, { type: 'text' }) as unknown as Record<string, unknown>),
        labels: [{ textContent: text }],
      }) as unknown as Element;
    expect(isSensitive(withLabel('登录密码'), 'textbox')).toBe(true);
    expect(isSensitive(withLabel('Card number'), 'textbox')).toBe(true);
    // Same per-string rule: a label that only mentions credentials is a mention.
    expect(isSensitive(withLabel('Password policy'), 'textbox')).toBe(false);
    expect(isSensitive(withLabel('项目名称'), 'textbox')).toBe(false);
  });

  it('contenteditable 与 textarea 同样是结构性入口', () => {
    expect(isSensitive(el('div', { 'aria-label': '口令' }, { contentEditable: true }), 'textbox')).toBe(true);
    expect(isSensitive(el('textarea', { 'aria-label': '授权码' }), '')).toBe(true);
  });
});
