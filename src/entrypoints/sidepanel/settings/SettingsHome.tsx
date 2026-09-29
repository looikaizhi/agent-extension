import { useEffect, useState } from 'react';
import { modelIsConfigured } from '@/agent/provider/call';
import { loadConfig } from '@/shared/settings';
import { Icon } from '../ui/Icon';
import { AppearanceSettings } from './Appearance';
import { PageBar } from './PageBar';

export type SettingsPage = 'model' | 'inspect' | 'usage';

/**
 * 工具与设置: the look first — it is what most people come here for — then the
 * three pages behind it, each saying in a word where it stands.
 */
export function SettingsHome({
  calls,
  onBack,
  onOpen,
}: {
  /** Model calls this panel has made, for the 本次用量 row. */
  calls: number;
  onBack: () => void;
  onOpen: (page: SettingsPage) => void;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    void loadConfig().then((c) => setConfigured(modelIsConfigured(c)));
  }, []);

  return (
    <div className="settings-page">
      <PageBar title="工具与设置" parent="页面引导" backLabel="返回对话" onBack={onBack} />
      <AppearanceSettings />
      <nav className="settings-rows" aria-label="更多设置">
        <button onClick={() => onOpen('model')}>
          <span className="row-title">模型配置</span>
          {configured !== null && <span className={`row-meta${configured ? '' : ' warn'}`}>{configured ? '已配置' : '未配置'}</span>}
          <Icon name="next" size={14} />
        </button>
        <button onClick={() => onOpen('inspect')}>
          <span className="row-title">检视页面</span>
          <Icon name="next" size={14} />
        </button>
        <button onClick={() => onOpen('usage')}>
          <span className="row-title">本次用量</span>
          {calls > 0 && <span className="row-meta">{calls} 次调用</span>}
          <Icon name="next" size={14} />
        </button>
      </nav>
    </div>
  );
}
