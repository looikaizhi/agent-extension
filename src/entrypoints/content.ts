import { extract, extractStructureHash } from '@/core/extractor/extract';
import { pageStructureChanged } from '@/core/extractor/fingerprint';
import { fullTable, project } from '@/core/extractor/project';
import { registry } from '@/core/extractor/registry';
import { bindStep } from '@/core/descriptor/bind';
import { authorDescriptor } from '@/core/descriptor/author';
import type { ExtractProfile, PromptItem, PromptTable } from '@/core/extractor/types';
import { Overlay } from '@/core/overlay/overlay';
import { presenterDom, rectOf } from '@/core/overlay/dom';
import { domWaitPorts, waitForText } from '@/core/wait/wait-for-text';
import { createPresenter } from '@/core/overlay/presenter';
import { DEFAULT_APPEARANCE, type Appearance } from '@/shared/appearance';
import type { ContentRequest, ContentResponse, GuideStep, HighlightAck } from '@/shared/protocol';
import { emit, onRequest } from '@/shared/rpc';
import type { Ref } from '@/shared/types';
import { sameView } from '@/shared/view';

export default defineContentScript({
  matches: ['<all_urls>'],
  // Static registration: Chrome injects this itself on every matching page, so
  // there is no runtime permission moment at all. `ensureInjected` still exists
  // for the two cases static registration cannot cover — the extension being
  // installed or reloaded while a page is already open, and a user who has set
  // this extension's site access to "on click" in chrome://extensions.
  runAt: 'document_idle',
  allFrames: false,
  main() {
    let overlay: Overlay | null = null;
    let off: (() => void) | null = null;
    /** The look the host last told us (`THEME`). This script cannot read
     *  storage, so until the host says, it is the default. */
    let appearance: Appearance = DEFAULT_APPEARANCE;

    /**
     * Two instances can legitimately land in one page: Chrome injects this
     * statically at `document_idle`, while `ensureInjected` may have injected it
     * moments earlier against a page that was not ready yet (and does so again
     * after an extension reload). They own separate `registry` generations, so
     * whichever answered a message first would hand out refs the other cannot
     * resolve — EXTRACT to A, HIGHLIGHT to B, `snapshot_stale` forever.
     *
     * Newest wins: greet the incumbent by shutting it down. Both instances share
     * one isolated world, so this hook is reachable and invisible to the page.
     */
    const SHUTDOWN = '__pageGuideShutdown';
    type Shared = Window & { [SHUTDOWN]?: () => void };
    (window as Shared)[SHUTDOWN]?.();
    (window as Shared)[SHUTDOWN] = () => {
      off?.();
      stopInspect();
      teardown();
      overlay?.destroy();
      overlay = null;
    };

    const ensureOverlay = (): Overlay => {
      overlay ??= new Overlay({
        // The renderer reports what the user did and stops there. Choosing the
        // next step is the flow owner's job — this process does not survive a
        // navigation, so it must not hold anything it cannot rebuild.
        // Hands the keyboard to the target and stops there. The activation is
        // still the user's: a focused button or link fires on Enter/Space, and
        // that keystroke is a real user gesture the page can trust — an
        // `el.click()` from here would be the extension acting, which is the
        // one thing this product does not do («只指路，不开车», CONTEXT.md).
        //
        // It does *not* report `STEP_USED`: the button no longer claims
        // the step was done, so it must not say so. The presenter's activation
        // listener already reports the moment the user really fires it.
        onNext: () => {
          const target = presenter.target;
          if (!(target instanceof HTMLElement)) return;
          target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          target.focus({ preventScroll: true });
        },
        onExit: () => {
          const current = presenter.current;
          if (current) emit({ type: 'SESSION_ENDED', sessionId: current.sessionId, reason: 'user_closed' });
          teardown();
        },
        onRetry: () => presenter.retry(),
        // The message card's own buttons: closed, or a cross-site answer. What
        // the screen does next is the host's to say; a note is only read.
        onCloseMessage: (kind) => {
          overlay?.say(null);
          if (kind === 'ask' || kind === 'answer') emit({ type: 'MESSAGE_CLOSED' });
        },
        onCrossSite: (go) => {
          overlay?.say(null);
          emit({ type: 'CROSS_SITE_DECIDED', confirmed: go });
        },
      }, appearance);
      return overlay;
    };

    /**
     * The step on screen, and everything that keeps it there. Extraction, the
     * sensitive-field set and the overlay itself stay in this file — authoring
     * and `EXTRACT` use them too — and are lent to the presenter.
     */
    const presenter = createPresenter({
      overlay: () => ensureOverlay(),
      bind: (step) => bindHere(step),
      isSensitive: (refs) => sensitiveOf(refs),
      emit,
      dom: presenterDom,
    });

    function teardown(): void {
      presenter.teardown();
      stopWatchingPageStructure();
      overlay?.setWaiting(false);
      overlay?.say(null);
      overlay?.hide();
    }

    /**
     * Late binding — the heart of task 8, and the only interface an agent can
     * actually use.
     *
     * A `ref` names an element *in one snapshot of one page at one moment*. Step
     * 3's target usually does not exist in the DOM while step 1 is on screen
     * (a dialog has not opened, a page has not been navigated to), so no caller
     * — fixed plan, baseline or model — can produce a ref for it up front. What it can
     * produce is a `descriptor`, and turning that into a ref is only possible
     * here, now, against the live page.
     *
     * That also fixes F-7 for free: "重试定位" used to re-resolve the same dead
     * handle and necessarily fail again, while the descriptor sat unread in the
     * same object.
     */
    function bindHere(step: GuideStep): { el: Element | null; also: Element[]; refs: readonly Ref[] } {
      const view = extract(lastProfile);
      const table = fullTable(view);
      // Recomputed from the fresh full set, so S-03 can never be evaluated
      // against a stale — or narrower — view of the page.
      sensitiveRefs = new Set(table.items.filter((i) => i.sensitive).map((i) => i.ref));

      const bound = bindStep(step.descriptor, table);
      if (bound.kind === 'not_found') return { el: null, also: [], refs: [] };
      if (bound.kind === 'unique') {
        return { el: registry.resolve(view.snapshotId, bound.ref), also: [], refs: [bound.ref] };
      }
      // Several matches and no way to choose between them (K-6). Every one gets
      // outlined; picking would be the silent mis-point this design exists to
      // prevent.
      const els = bound.refs
        .map((r) => registry.resolve(view.snapshotId, r))
        .filter((x): x is Element => x !== null);
      return { el: null, also: els, refs: bound.refs };
    }

    /**
     * A second, independent subscription on top
     * of the same DOM-observation machinery `TargetTracker` already uses.
     * `TargetTracker` watches one highlighted element; this watches whatever
     * landmark/heading nodes feed `structureFingerprint` — the exact "一小撮
     * landmark/heading 节点" the Seam names, reached here not by writing a
     * second, narrower DOM scanner but by recomputing the *existing*
     * `structureFingerprint` (already, by construction, insensitive to anything
     * else — `core/extractor/fingerprint.ts`'s own doc comment) after any
     * mutation and comparing against the last hash *this content script*
     * reported. `pageStructureChanged` is the one-line decision; this
     * function is only the DOM plumbing around it.
     *
     * Checked once the page's main thread has nothing more urgent
     * (`presenterDom.whenIdle`), not on every mutation: `TargetTracker`'s own
     * doc comment notes a `MutationObserver` can fire hundreds of times a
     * second on a busy console page, and this watcher's own check walks the
     * whole document. Not after a guessed quiet period, which on a page that
     * keeps changing keeps restarting and never ends; and not in an idle
     * period either, which a page that spends every frame never has. Uses `extractStructureHash()`,
     * never `extract()` — see that function's own doc comment for why calling
     * the *full*, registry-committing extraction from an unrelated background
     * watcher would silently break every other live `HIGHLIGHT` on the page.
     */
    let structureWatch: (() => void) | null = null;
    let lastReportedStructureHash: string | null = null;
    /**
     * The address the last report was about. The structure hash no longer
     * carries the address — which page this is belongs to CONTEXT.md's `View`
     * — so a same-document navigation onto a page with the same landmarks
     * would otherwise go unreported. The hash used to catch that only because
     * the path was hashed in with the structure, and no other trigger does:
     * `chrome.tabs.onUpdated` never completes for a same-document navigation,
     * and the user need not have clicked the step on screen.
     */
    let lastReportedUrl = '';

    function watchPageStructure(): void {
      if (structureWatch) return; // already watching this session
      lastReportedStructureHash = extractStructureHash();
      lastReportedUrl = location.href;
      let pending: (() => void) | null = null;

      const check = () => {
        pending = null;
        const current = presenter.current;
        if (!current) return; // session ended while the check was pending
        const hash = extractStructureHash();
        const url = location.href;
        if (!pageStructureChanged(lastReportedStructureHash, hash) && sameView(lastReportedUrl, url)) return;
        lastReportedStructureHash = hash;
        lastReportedUrl = url;
        emit({ type: 'PAGE_STRUCTURE_CHANGED', sessionId: current.sessionId, structureHash: hash });
      };

      const mo = new MutationObserver(() => {
        pending ??= presenterDom.whenIdle(check);
      });
      mo.observe(document, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['aria-expanded', 'hidden', 'aria-hidden', 'class', 'style', 'role'],
      });

      structureWatch = () => {
        mo.disconnect();
        pending?.();
        pending = null;
      };
    }

    function stopWatchingPageStructure(): void {
      structureWatch?.();
      structureWatch = null;
      lastReportedStructureHash = null;
      lastReportedUrl = '';
    }

    let sensitiveRefs = new Set<string>();
    /** Whether any ref about to be painted is a sensitive field. */
    const sensitiveOf = (refs: readonly Ref[]): boolean => refs.some((r) => sensitiveRefs.has(r));

    // Binding needs the same lens the caller extracted through, so the profile
    // of the last EXTRACT is remembered rather than guessed.
    let lastProfile: ExtractProfile = 'interactive';

    /* ═══════════ authoring: pick an element, get a descriptor ═══════════ */

    let inspecting: { table: PromptTable; byEl: Map<Element, PromptItem>; stop: () => void } | null =
      null;

    /** Nearest ancestor (across shadow boundaries) that we actually extracted. */
    const itemAt = (x: number, y: number): { el: Element; item: PromptItem } | null => {
      if (!inspecting) return null;
      let el: Element | null = document.elementFromPoint(x, y);
      for (let guard = 0; el && guard < 40; guard++) {
        const item = inspecting.byEl.get(el);
        if (item) return { el, item };
        const parent: Element | null =
          el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null);
        el = parent;
      }
      return null;
    };

    function startInspect(): void {
      stopInspect();
      const view = extract(lastProfile);
      const table = fullTable(view);
      const byEl = new Map<Element, PromptItem>();
      for (const item of table.items) {
        const el = registry.resolve(view.snapshotId, item.ref);
        if (el) byEl.set(el, item);
      }

      const ui = ensureOverlay();
      const onMove = (e: PointerEvent) => {
        const hit = itemAt(e.clientX, e.clientY);
        ui.outline(hit ? rectOf(hit.el) : null, hit ? { role: hit.item.role, name: hit.item.name } : undefined);
      };
      // Capture phase and cancelled: the author is pointing at a control, and
      // letting the click through would navigate away from the page they are
      // annotating. This is the one place we touch an event the page wanted —
      // and we swallow it rather than replay it.
      const onClick = (e: MouseEvent) => {
        const hit = itemAt(e.clientX, e.clientY);
        e.preventDefault();
        e.stopPropagation();
        stopInspect();
        if (!hit) return;
        const authored = authorDescriptor(hit.item, table);
        emit({
          type: 'ELEMENT_PICKED',
          descriptor: authored.descriptor,
          label: `${hit.item.role}｜${hit.item.name}`,
          matches: authored.matches,
          correct: authored.correct,
          rung: authored.rung,
        });
      };
      addEventListener('pointermove', onMove, true);
      addEventListener('click', onClick, true);
      inspecting = {
        table,
        byEl,
        stop: () => {
          removeEventListener('pointermove', onMove, true);
          removeEventListener('click', onClick, true);
          ui.outline(null);
        },
      };
    }

    function stopInspect(): void {
      inspecting?.stop();
      inspecting = null;
    }

    off = onRequest(async (req: ContentRequest): Promise<ContentResponse> => {
      switch (req.type) {
        case 'PING':
          return { ok: true, data: { version: '0.1.0', frameId: 0, title: document.title } };

        case 'EXTRACT': {
          lastProfile = req.profile;
          const view = extract(req.profile, req.frameId ?? 0);
          // Sensitivity is tracked over the *full* set, not the projected one:
          // a password field pruned for being off screen is still a password
          // field, and late binding can reach it.
          sensitiveRefs = new Set(
            fullTable(view)
              .items.filter((i) => i.sensitive)
              .map((i) => i.ref),
          );
          return { ok: true, data: project(view, req.budget) };
        }

        case 'HIGHLIGHT':
          // Starts once per session (idempotent — see the guard inside), and
          // keeps running across every subsequent step of the same guide, not
          // just this one command: the page changing by itself is one of the
          // observation sources (CONTEXT.md `Reading`), whichever step happens
          // to be on screen when it happens.
          watchPageStructure();
          // A step on screen supersedes whatever the card was saying; an
          // outline is what the card is about, and leaves it.
          if (req.command.mode === 'guide') overlay?.say(null);
          return presenter.show(req.command);

        case 'INSPECT':
          if (req.on) startInspect();
          else stopInspect();
          return { ok: true, data: null };

        case 'CLEAR':
          stopInspect();
          teardown();
          return { ok: true, data: null };

        case 'DEBUG_GET_OVERLAY_STATE':
          return { ok: true, data: overlay ? { ...overlay.getState(), watch: presenter.watch } : null };

        case 'WAIT_FOR':
          // `wait_for`: reads the page until a piece of text appears or goes.
          // The host caps the time; this only honours it.
          return { ok: true, data: await waitForText(domWaitPorts, req.until, req.text, req.timeoutMs) };

        case 'WAITING_FOR_PANEL':
          // Our own card, and nothing of the page's. An overlay that was never
          // made has nothing to take down.
          if (req.waiting || overlay) ensureOverlay().setWaiting(req.waiting);
          return { ok: true, data: null };

        case 'SAY':
          if (req.message || overlay) ensureOverlay().say(req.message);
          return { ok: true, data: null };

        case 'THEME':
          // Kept for the overlay not made yet; repainted on the one that is.
          appearance = req.appearance;
          overlay?.setAppearance(appearance);
          return { ok: true, data: null };
      }
    });

    addEventListener('pagehide', () => {
      const current = presenter.current;
      if (current) emit({ type: 'SESSION_ENDED', sessionId: current.sessionId, reason: 'navigated' });
    });
  },
});
