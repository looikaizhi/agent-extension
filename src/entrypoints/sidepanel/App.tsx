import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConversationView } from '@/shared/conversation';
import { actionForRole, type ElementDescriptor } from '@/shared/protocol';
import { emptyConversation } from '@/shared/conversation';
import { Composer } from './chat/Composer';
import { Conversation } from './chat/Conversation';
import { EmptyState } from './chat/EmptyState';
import { PageHeader } from './chat/PageHeader';
import { PinnedStep } from './chat/PinnedStep';
import { Inspect } from './settings/Inspect';
import { ModelConfig } from './settings/ModelConfig';
import { SettingsHome, type SettingsPage } from './settings/SettingsHome';
import { Usage } from './settings/Usage';
import { Icon } from './ui/Icon';
import { draftTextOf } from './streaming';
import { loadConfig } from '@/shared/settings';
import { recoverInflightOnMount, startEffectListener } from './effects';
import { statusOf, type CallRecord } from './view-model';

/** Which page the panel shows. Everything that runs lives above this, so
 *  leaving the conversation stops nothing. */
type Page = 'chat' | 'settings' | SettingsPage;

/**
 * The side panel: one conversation per tab, and the step pinned above it.
 *
 * The panel owns nothing. Everything it shows comes from one pull
 * (`GET_CONVERSATION`) of what the host wrote down, re-asked whenever
 * something might have changed — a ping, a tab switch, a gesture of the
 * user's own. Nothing here is remembered between pulls, which is why nothing
 * here can be stale: the old panel kept its own 「正在想…」 and a single
 * message it never received left that on screen for good.
 *
 * The one exception is the draft of what the model is writing this second.
 * It is explicitly not the record: the host's entry replaces it the moment
 * the answer lands.
 */
export function App() {
  const [tabId, setTabId] = useState<number | null>(null);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [view, setView] = useState<ConversationView | null>(null);
  const [text, setText] = useState('');
  const [draft, setDraft] = useState('');
  const [costCalls, setCostCalls] = useState<CallRecord[]>([]);
  const [page, setPage] = useState<Page>('chat');
  const bottom = useRef<HTMLDivElement | null>(null);

  /**
   * The one authoritative read. Every path that changes anything ends here.
   *
   * A failed ask changes nothing on screen: the worker may be starting up, and
   * the next pull — a ping, a tab change, the refresh below — asks again. What
   * must never happen is replacing what the user sees with a guess.
   */
  const pull = useCallback(async (id: number | null) => {
    if (id === null) return setView(null);
    try {
      const res = (await chrome.runtime.sendMessage({ type: 'GET_CONVERSATION', tabId: id })) as ConversationView | undefined;
      // A tab that has never had a conversation still renders: an empty one.
      setView(res ?? { conversation: emptyConversation(id), pending: { kind: 'idle' }, step: null });
    } catch {
      /* asked too early, or the worker is waking: the next pull carries it */
    }
  }, []);

  /** Which tab the panel is looking at. A switch re-pulls rather than
   *  filters: the conversation of the tab now in front is simply another read. */
  const syncTab = useCallback(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    setTabId(tab?.id ?? null);
    setUrl(tab?.url ?? '');
    setTitle(tab?.title ?? '');
  }, []);

  useEffect(() => {
    const sync = syncTab;
    void sync();
    chrome.tabs.onActivated.addListener(sync);
    const onUpdated = (_id: number, info: { status?: string; url?: string }) => {
      if (info.status === 'complete' || info.url) void sync();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(sync);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [syncTab]);

  useEffect(() => {
    void pull(tabId);
  }, [tabId, pull]);

  // The host's ping carries no data and is not trusted for any: it only says
  // "ask again". One that never arrives costs nothing.
  useEffect(() => {
    const listener = (msg: unknown) => {
      const m = msg as { type?: string; tabId?: number } | undefined;
      if (m?.type !== 'CONVERSATION_CHANGED') return;
      // A ping for another tab is a reason to check which tab this panel is
      // on: an activation we missed would otherwise leave it showing the
      // wrong conversation until the next one.
      if (m.tabId === tabId) void pull(tabId);
      else void syncTab();
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [tabId, pull]);

  // The effect protocol: this panel runs the model calls (for every tab, not
  // only the one it shows). The draft is teed off the stream on the way past.
  useEffect(
    () =>
      startEffectListener(
        loadConfig,
        ({ providerCalls, usage }) => {
          setDraft('');
          setCostCalls((cs) => [
            ...cs,
            { kind: 'primary', usage: usage ? { ...usage, estimated: false } : null },
            ...Array.from({ length: Math.max(0, providerCalls - 1) }, () => ({ kind: 'repair' as const, usage: 'merged' as const })),
          ]);
        },
        (args) => setDraft(draftTextOf(args)),
      ),
    [],
  );

  // E-6: what the host already knows about a call in flight for this tab.
  // Reported, never re-issued.
  useEffect(() => {
    if (tabId === null) return;
    void recoverInflightOnMount(tabId, (id) => chrome.runtime.sendMessage({ type: 'PANEL_GUIDE_INFLIGHT', tabId: id }));
  }, [tabId]);

  const pendingKind = view?.pending?.kind ?? 'idle';

  /**
   * While something is under way, keep asking. Not a guess about the page —
   * the host is asked what it holds, which is the same thing the pings ask
   * for and the same thing the panel already shows; it stops the moment
   * nothing is pending.
   *
   * It earns its keep twice: a ping that never arrives no longer freezes the
   * panel, and a pull is also what tells the host a panel is here, which is
   * how a call whose panel went away gets handed to this one
   * (`GET_CONVERSATION` in the worker). Without it the user sat in front of
   * 「正在想」 with nothing left to move it.
   */
  useEffect(() => {
    if (tabId === null || pendingKind === 'idle') return;
    const again = setInterval(() => void pull(tabId), 2000);
    return () => clearInterval(again);
  }, [tabId, pendingKind, pull]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [view?.conversation.rev, draft, page]);

  const send = useCallback(async () => {
    const said = text.trim();
    if (!said || tabId === null) return;
    setText('');
    await chrome.runtime.sendMessage({ type: 'SAID', tabId, text: said });
    await pull(tabId);
  }, [text, tabId, pull]);

  const pointAt = useCallback(
    async (descriptor: ElementDescriptor, title: string, detail: string) => {
      if (tabId === null) return;
      await chrome.runtime.sendMessage({
        type: 'POINT_AT',
        tabId,
        step: { descriptor, expectedUserAction: actionForRole(descriptor.role), title, detail },
      });
      // What it pointed at is said in the conversation, so that is where the
      // user goes next.
      setPage('chat');
      await pull(tabId);
    },
    [tabId, pull],
  );

  const act = useCallback(
    async (message: Record<string, unknown>) => {
      if (tabId === null) return;
      await chrome.runtime.sendMessage({ ...message, tabId });
      await pull(tabId);
    },
    [tabId, pull],
  );

  const pending = view?.pending ?? { kind: 'idle' as const };
  const step = view?.step ?? null;
  // Nothing said on this tab yet and nothing under way: the panel says what it
  // is for instead of showing an empty list.
  const empty = view !== null && view.conversation.entries.length === 0 && !step && pending.kind === 'idle';
  const placeholder =
    pending.kind === 'idle'
      ? '想做什么，或者想问这一页什么？'
      : pending.kind === 'waiting_for_user' && pending.what === 'ask'
        ? '直接打字回答它'
        : '引导在走，你也可以直接说';

  const toSettings = () => setPage('settings');
  if (page !== 'chat')
    return (
      <div className="panel settings-panel">
        {page === 'settings' ? (
          <SettingsHome calls={costCalls.length} onBack={() => setPage('chat')} onOpen={setPage} />
        ) : page === 'model' ? (
          <ModelConfig onBack={toSettings} />
        ) : page === 'inspect' ? (
          <Inspect tabId={tabId} onBack={toSettings} onPointAt={(d, title, detail) => void pointAt(d, title, detail)} />
        ) : (
          <Usage calls={costCalls} onBack={toSettings} />
        )}
      </div>
    );

  return (
    <div className="panel">
      <PageHeader title={title} url={url} status={statusOf(pending, step !== null)} />

      {step && <PinnedStep step={step} onEnd={() => void act({ type: 'END_GUIDE' })} />}

      {empty ? (
        <EmptyState onExample={setText} />
      ) : (
        view && (
          <Conversation
            conversation={view.conversation}
            pending={pending}
            draft={draft}
            {...(view.storageFull ? { storageFull: true as const } : {})}
            {...(view.earlier ? { earlier: view.earlier } : {})}
            {...(step ? { currentEntryId: step.entryId } : {})}
            onRetry={() => void act({ type: 'RETRY_GUIDE' })}
            onOpenModel={() => setPage('model')}
            crossSiteActions={
              <div className="row actions">
                <button className="primary" onClick={() => void act({ type: 'CROSS_SITE_DECISION', confirmed: true })}>
                  继续，带我去
                </button>
                <button onClick={() => void act({ type: 'CROSS_SITE_DECISION', confirmed: false })}>先不去</button>
              </div>
            }
            endRef={bottom}
          />
        )
      )}

      <Composer
        text={text}
        onText={setText}
        onSend={() => void send()}
        placeholder={placeholder}
        {...(!step && pending.kind !== 'idle' ? { onEnd: () => void act({ type: 'END_GUIDE' }) } : {})}
      />

      <button className="to-settings" onClick={toSettings}>
        <Icon name="sliders" size={13} />
        <span>工具与设置</span>
        <Icon name="next" size={12} />
      </button>
    </div>
  );
}
