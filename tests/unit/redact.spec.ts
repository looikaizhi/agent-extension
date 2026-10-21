import { describe, expect, it } from 'vitest';
import { REDACTED, looksSecret, redact } from '@/core/security/redact';
import { toPromptText } from '@/core/extractor/project';
import type { PromptItem, PromptTable } from '@/core/extractor/types';
import type { Ref } from '@/shared/types';

/**
 * 值级脱敏（S-03 第二层）。
 *
 * 两组断言，回答两个不同的问题：
 * - **判据本身**对不对——真密钥认得出，页面上真实存在的随机串不误伤。
 * - **接入点**有没有漏——把密钥塞进元素表的每一个文字位置，再看渲染出来的提示词。
 *   第二组才是真正的门：它不关心 `toPromptText` 内部怎么写，只关心有没有漏出去，
 *   所以重构挪动调用点不会让它误绿。
 */

const SECRETS = {
  openai: 'sk-live-abcdefghijklmnopqrstuvwx',
  github: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
  aws: 'AKIAIOSFODNN7EXAMPLE',
  aliyun: 'LTAI5tAbCdEfGhIjKlMn',
  google: 'AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456',
  slack: 'xoxb-123456789012-abcdefghij',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  pem: '-----BEGIN RSA PRIVATE KEY-----',
};

describe('值级脱敏 — 判据', () => {
  it('1. 八种形态都认得出，而且整条被换掉（打码剩下的半截仍然是半个密钥）', () => {
    for (const [name, s] of Object.entries(SECRETS)) {
      expect(looksSecret(s), name).toBe(true);
      expect(redact(s), name).toBe(REDACTED);
    }
  });

  it('2. 密钥夹在一句话里也认得出 —— 真实的形态是可访问名，不是裸串', () => {
    expect(redact(`复制 ${SECRETS.openai} 到剪贴板`)).toBe(REDACTED);
    expect(redact(`Authorization: Bearer ${SECRETS.jwt}`)).toBe(REDACTED);
  });

  /**
   * 这一条是为了挡住一种很容易犯的实现：按「熵」或「够长的十六进制」下手。
   * GitHub 的每一页都有完整的 commit SHA（40 位十六进制），云控制台到处是资源 id。
   * 把它们当密钥吞掉，会直接让引导认不出「哪一行是哪一行」——那正是去重那条规格
   * 花了大力气才保住的区分。宁可漏掉没有前缀的自定义密钥。
   */
  it('3. 页面上真实存在的随机串一律放行：完整 commit SHA、资源 id、版本号', () => {
    const benign = [
      'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      '6cc8c0d',
      '删除实例 i-0abc123def456',
      'v2.14.3-rc1',
      'Pull requests (784)',
      'ci: Scan release images with syft instead of cdxgen (no-changelog) (#32192)',
      'Copy url to clipboard',
      '',
    ];
    for (const s of benign) expect(looksSecret(s), s).toBe(false);
  });

  it('4. 纯函数：同样的输入永远同样的输出，且不改原串', () => {
    const s = 'Copy url to clipboard';
    expect(redact(s)).toBe(s);
    expect(redact(s)).toBe(redact(s));
  });
});

const item = (over: Omit<Partial<PromptItem>, 'ref'> & { ref: string }): PromptItem => ({
  role: 'button',
  name: '按钮',
  path: [],
  ...over,
  ref: over.ref as unknown as Ref,
});

const tableWith = (over: Partial<PromptTable>): PromptTable => ({
  snapshotId: 's1',
  url: 'https://example.test/',
  title: '标题',
  structureHash: 'h',
  omitted: 0,
  degraded: false,
  ambiguity: 0,
  items: [],
  stats: {
    elementsScanned: 0,
    candidates: 0,
    visible: 0,
    emitted: 0,
    shadowRoots: 0,
    emptyName: 0,
    modalScoped: false,
    ms: { total: 0, walk: 0, visibility: 0, semantics: 0, name: 0 },
  },
  ...over,
});

describe('值级脱敏 — 接入点（发出去的那份文本）', () => {
  it('5. 控件名里的密钥不会进提示词 —— 今天最现实的那个口子：「复制 sk-…」的 aria-label', () => {
    const text = toPromptText(tableWith({ items: [item({ ref: 'e1', name: `复制 ${SECRETS.openai}` })] }));
    expect(text).not.toContain(SECRETS.openai);
    expect(text).toContain(REDACTED);
  });

  it('6. 页面标题里的密钥不会进提示词', () => {
    const text = toPromptText(tableWith({ title: `API Key ${SECRETS.github}` }));
    expect(text).not.toContain(SECRETS.github);
  });

  it('7. 组标题（path）里的密钥不会进提示词', () => {
    const text = toPromptText(tableWith({ items: [item({ ref: 'e1', path: [`凭据 ${SECRETS.aws}`] })] }));
    expect(text).not.toContain(SECRETS.aws);
  });

  it('8. URL 查询串里的密钥不会进提示词 —— `?token=…` 的页面不罕见', () => {
    const text = toPromptText(tableWith({ url: `https://example.test/cb?token=${SECRETS.jwt}` }));
    expect(text).not.toContain(SECRETS.jwt);
  });

  it('9. 嵌入框架的标题与 host 里的密钥不会进提示词', () => {
    const text = toPromptText(
      tableWith({ frames: [{ label: `控制台 ${SECRETS.slack}`, host: 'inner.test' }] as PromptTable['frames'] }),
    );
    expect(text).not.toContain(SECRETS.slack);
  });

  it('9b. 旁注（`nearby`）也渲染、也过脱敏 —— 它同样是页面作者写的字', () => {
    const t = tableWith({ items: [item({ ref: 'e1', name: 'Copy', nearby: 'Payment methods' })] });
    expect(toPromptText(t)).toContain('e1 button "Copy" · Payment methods');

    const leak = tableWith({ items: [item({ ref: 'e1', name: 'Copy', nearby: `密钥 ${SECRETS.aliyun}` })] });
    expect(toPromptText(leak)).not.toContain(SECRETS.aliyun);
  });

  it('10. 没有密钥的表逐字不变 —— 脱敏不是一层会改写正常内容的过滤器', () => {
    const t = tableWith({
      title: 'n8n-io/n8n',
      items: [item({ ref: 'e1', role: 'link', name: 'Code', path: ['Repository'] })],
    });
    const text = toPromptText(t);
    expect(text).toContain('e1 link "Code"');
    expect(text).toContain('Repository:');
    expect(text).not.toContain(REDACTED);
  });
});
