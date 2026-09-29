import type * as React from 'react';
import type { Conversation as ConversationData, Pending } from '@/shared/conversation';
import { Prose } from '../Prose';
import { Icon } from '../ui/Icon';
import { Entry } from './Entry';
import { Thinking } from './Thinking';

/**
 * The conversation, as the host wrote it down.
 *
 * Nothing here is state: every render comes from one `ConversationView` the
 * panel pulled. The only thing the panel adds of its own is the draft of what
 * the model is writing right now, which is explicitly not the record —
 * `draft` below — and is replaced by the host's entry the moment it lands.
 */
export function Conversation({
  conversation,
  pending,
  draft,
  storageFull,
  earlier,
  currentEntryId,
  onRetry,
  onOpenModel,
  crossSiteActions,
  endRef,
}: {
  conversation: ConversationData;
  pending: Pending;
  /** What the model is writing right now, as far as it has arrived. */
  draft: string;
  /** The store had no room for the newest thing that happened. */
  storageFull?: true;
  /** Entries older than the ones shown: kept, but not carried on every pull. */
  earlier?: number;
  /** The entry whose step is on screen now, pinned above. */
  currentEntryId?: string;
  /** 「再试一次」 on the last call that never got through. */
  onRetry?: () => void;
  /** 「打开模型配置 →」 on a note whose cure is there. */
  onOpenModel?: () => void;
  /** 继续 / 先不去, while the run waits on a cross-site choice. */
  crossSiteActions?: React.ReactNode;
  /** The bottom of the list, so the newest entry can be scrolled to. */
  endRef?: React.Ref<HTMLDivElement>;
}) {
  const working = pending.kind === 'thinking' || pending.kind === 'running_tool';
  // Nothing to try again while something is already under way, and only the
  // last word of the conversation can be the one still standing.
  const last = conversation.entries.at(-1);
  const retryable = !working && last?.canRetry ? last.id : null;
  const crossSite = pending.kind === 'waiting_for_user' && pending.what === 'cross_site';
  const rounds = conversation.draft ?? [];
  return (
    <div className="conversation">
      {/* 更早的话去哪了，以及此刻还写不写得下——都说出来，不让这条对话
          悄悄地少掉东西。 */}
      {conversation.dropped ? (
        <div className="conversation-note">
          <Icon name="archive" size={13} />
          更早的 {conversation.dropped} 条已不再保留
        </div>
      ) : null}
      {earlier ? (
        <div className="conversation-note">
          <Icon name="up" size={13} />
          更早还有 {earlier} 条，没有载入
        </div>
      ) : null}
      {storageFull && (
        <div className="conversation-note warn">
          <Icon name="warn" size={13} />
          这条对话写不下了：刚刚发生的事没能记下来
        </div>
      )}
      {conversation.entries.map((e) => (
        <Entry
          key={e.id}
          entry={e}
          current={e.id === currentEntryId}
          {...(e.id === retryable && onRetry ? { onRetry } : {})}
          {...(onOpenModel ? { onOpenModel } : {})}
          {...(crossSite && e === last && crossSiteActions ? { actions: crossSiteActions } : {})}
        />
      ))}

      {/* The turn that has not landed yet: what it has done so far, and what
          it is writing. Both are drafts — the host's entry replaces them. */}
      {working && (
        <div className="entry working">
          <Thinking rounds={rounds} open live />
          {draft ? (
            <div className="draft">
              <Prose text={draft} />
            </div>
          ) : (
            <div className="dots">
              <span className="spinner" />
              {pending.kind === 'running_tool' ? '正在看页面…' : '正在想…'}
            </div>
          )}
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}
