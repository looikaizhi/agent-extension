/**
 * S-03. Lives on the live DOM node, not on the extracted representation:
 * `textbox|"验证码"` and `textbox|"项目名称"` are structurally identical in the
 * table, so the evidence has to come from the element itself.
 *
 * Used in two independent places — tagging at extraction time and refusing at
 * render time — so a hand-written pack is blocked exactly like a model is.
 */
const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-|current-password|new-password|one-time-code)/i;
/**
 * `[\s_-]*` rather than `\s*`: attribute values are identifiers far more often
 * than they are prose, and `name="card_number"` / `id="security-code"` are the
 * conventional spellings. `\s*` matched neither, so the two multi-word patterns
 * here only ever fired on the least common form of the thing they name.
 */
const SEP = String.raw`[\s_-]*`;
const SENSITIVE_WORDS = new RegExp(
  `(password|passwd|pwd|密码|口令|cvv|cvc|security${SEP}code|card${SEP}number|卡号|otp|verification${SEP}code|验证码|2fa|totp|授权码|pin\\b)`,
  'i',
);
/** Words that merely *mention* credentials without being an input for one. */
const BENIGN = /(policy|policies|forgot|reset|help|文档|说明|策略|找回|帮助)/i;

export function isSensitive(el: Element, role: string): boolean {
  // Deliberately not gated on role: `input[type=password]` has no ARIA role at
  // all, so a role check would let exactly the field we most need to block slip
  // through. Gate on "is this a text entry" structurally instead.
  const input = el as HTMLInputElement;
  const entry =
    el.localName === 'input' ||
    el.localName === 'textarea' ||
    role === 'textbox' ||
    role === 'searchbox' ||
    role === 'spinbutton' ||
    (el as HTMLElement).isContentEditable === true;
  if (!entry) return false;

  if (input.type === 'password') return true;

  const ac = el.getAttribute('autocomplete') ?? '';
  if (SENSITIVE_AUTOCOMPLETE.test(ac)) return true;

  // Per attribute, never over a joined string.
  //
  // Joining let a benign word in one attribute cancel a sensitive word in a
  // *different* one: `aria-label="请输入登录密码"` on a field with `id="help"`
  // produced the haystack "help 请输入登录密码", BENIGN matched "help", and the
  // function returned false. That is a live S-03 bypass, and the field it waved
  // through is exactly the one this code exists to catch.
  //
  // BENIGN's job is to tell "an input for a password" from "a link that
  // mentions passwords", and that distinction only ever holds *within* one
  // string — "password policy" is a mention; "help" sitting in another
  // attribute says nothing about what "密码" means.
  for (const attr of ATTRS) {
    const v = el.getAttribute(attr);
    if (!v) continue;
    if (SENSITIVE_WORDS.test(v) && !BENIGN.test(v)) return true;
  }

  // `<label for>` is the most common way a form names a field, and it puts the
  // word "password" nowhere the loop above can see it. Treated as one more
  // attribute — same per-string rule, so a "Password policy" label still reads
  // as a mention rather than as a field.
  for (const l of (el as HTMLInputElement).labels ?? []) {
    const t = l.textContent ?? '';
    if (SENSITIVE_WORDS.test(t) && !BENIGN.test(t)) return true;
  }
  return false;
}

const ATTRS = ['name', 'id', 'aria-label', 'placeholder', 'inputmode'] as const;
