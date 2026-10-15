// The per-person inbox in the top bar: a badge with the unread count and a dropdown of the
// latest items. Also exports the row and "open" behaviour shared with the /inbox page and the
// client portal's "Updates for you" section.
import type { InboxItemDto, InboxKind } from '@easetax/shared';
import clsx from 'clsx';
import { AtSign, CheckCheck, ClipboardList, Inbox as InboxIcon, MessageCircle, PenLine, Reply, RotateCcw, Scale } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInbox, type Inbox } from '../../api/inboxHooks';
import { fmtDate, fmtDateTime } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { useSession } from '../../state/session';

export const KIND_META: Record<InboxKind, { label: string; icon: ReactNode }> = {
  assigned: { label: 'Assigned to you', icon: <ClipboardList size={14} /> },
  mentioned: { label: 'Mentioned you', icon: <AtSign size={14} /> },
  question: { label: 'Question for you', icon: <MessageCircle size={14} /> },
  answer: { label: 'Answer', icon: <Reply size={14} /> },
  signoff_reopened: { label: 'Sign-off reopened', icon: <RotateCcw size={14} /> },
  approval_needed: { label: 'Needs your approval', icon: <Scale size={14} /> },
  blocking_note: { label: 'Blocking note', icon: <MessageCircle size={14} /> },
  adjustment_decided: { label: 'Adjustment decided', icon: <Scale size={14} /> },
  note_replied: { label: 'Reply to your note', icon: <Reply size={14} /> },
  approval_opened: { label: 'Ready to approve', icon: <PenLine size={14} /> },
  approval_stale: { label: 'Approval needs renewing', icon: <RotateCcw size={14} /> },
};

/** Open an item: the trace drawer on its first node, else its route. Marks it read. */
export function useOpenInboxItem(inbox: Pick<Inbox, 'markRead'>) {
  const drawer = useDrawer();
  const navigate = useNavigate();
  return useCallback(
    (i: InboxItemDto) => {
      inbox.markRead([i.id]);
      if (i.nodeIds[0]) drawer.open(i.nodeIds[0]);
      else if (i.route) navigate(i.route);
    },
    [inbox, drawer, navigate],
  );
}

export function InboxRow({ item, onOpen, compact }: { item: InboxItemDto; onOpen?: (i: InboxItemDto) => void; compact?: boolean }) {
  const { nameOf } = useSession();
  const meta = KIND_META[item.kind];
  const overdue = !item.done && item.due && item.due < new Date().toISOString().slice(0, 10);
  const body = (
    <>
      <span className={clsx('mt-0.5 shrink-0', item.read ? 'text-faint' : 'text-pencil')}>{meta.icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="text-2xs font-semibold uppercase tracking-wide text-graphite">{meta.label}</span>
          {item.done && <span className="text-2xs text-ledger-ink">done</span>}
          {item.due && !item.done && <span className={clsx('text-2xs', overdue ? 'font-semibold text-pencil' : 'text-graphite')}>due {fmtDate(item.due)}</span>}
          <span className="num ml-auto shrink-0 text-2xs text-faint">{fmtDateTime(item.at)}</span>
        </span>
        <span className={clsx('block text-sm', !item.read && 'font-semibold', compact && 'truncate')}>{item.title}</span>
        {item.detail && <span className={clsx('block text-xs text-graphite', compact && 'truncate')}>{item.detail}</span>}
        {!compact && <span className="block text-2xs text-faint">from {nameOf(item.actor)}</span>}
      </span>
    </>
  );
  return onOpen ? (
    <button className={clsx('flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-ruleSoft', !item.read && 'bg-blue-soft')} onClick={() => onOpen(item)}>
      {body}
    </button>
  ) : (
    <div className="flex w-full items-start gap-2 px-3 py-1.5">{body}</div>
  );
}

export function InboxWidget() {
  const inbox = useInbox();
  const openItem = useOpenInboxItem(inbox);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const n = inbox.unread;

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  // Unread first, then newest; the dropdown is a glance, the page has everything.
  const shown = [...inbox.items].sort((a, b) => Number(a.read) - Number(b.read) || b.seq - a.seq).slice(0, 8);

  return (
    <div className="relative" ref={ref}>
      <button
        className="relative grid h-8 w-8 place-items-center rounded hover:bg-ruleSoft"
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={n ? `${n} unread item(s) for you` : 'Nothing new for you'}
        aria-label={`Your inbox: ${n} unread`}
      >
        <InboxIcon size={16} className={n ? 'text-ink' : 'text-faint'} />
        {n > 0 && <span className="num absolute -right-0.5 -top-0.5 min-w-[17px] rounded-full bg-pencil px-1 text-center text-2xs font-semibold leading-[17px] text-white">{n > 99 ? '99+' : n}</span>}
      </button>
      {open && (
        <div role="dialog" aria-label="Your inbox" className="absolute right-0 top-full z-50 mt-1 w-[400px] max-w-[calc(100vw-32px)] rounded border border-rule bg-panel shadow-xl">
          <div className="flex items-center justify-between border-b border-ruleSoft px-3 py-2">
            <span className="text-sm font-semibold">For you</span>
            <button className="btn-ghost text-xs" disabled={!n} onClick={() => inbox.markRead(inbox.items.map((i) => i.id))}>
              <CheckCheck size={13} /> Mark all read
            </button>
          </div>
          {shown.length === 0 ? (
            <p className="px-3 py-4 text-sm text-faint">{inbox.isLoading ? 'Loading…' : 'Nothing needs you right now. Assignments, mentions and questions for you land here.'}</p>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-ruleSoft overflow-auto">
              {shown.map((i) => (
                <li key={i.id}>
                  <InboxRow
                    item={i}
                    compact
                    onOpen={(x) => {
                      setOpen(false);
                      openItem(x);
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end border-t border-ruleSoft px-3 py-1.5">
            <button
              className="btn-ghost text-xs"
              onClick={() => {
                setOpen(false);
                navigate('/inbox');
              }}
            >
              Open the inbox{inbox.items.length > shown.length ? ` (${inbox.items.length})` : ''}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Client portal: a short "Updates for you" list (questions, approval opened or stale). */
export function ClientInboxSection() {
  const inbox = useInbox();
  const unread = inbox.items.filter((i) => !i.read);
  if (!inbox.items.length) return null;
  return (
    <section className="mb-6 rounded border border-rule bg-panel">
      <div className="flex items-center justify-between border-b border-ruleSoft px-4 py-2">
        <h2 className="text-sm font-semibold text-graphite">
          Updates for you {unread.length > 0 && <span className="text-pencil">({unread.length} new)</span>}
        </h2>
        <button className="btn-ghost text-xs" disabled={!unread.length} onClick={() => inbox.markRead(unread.map((i) => i.id))}>
          <CheckCheck size={13} /> Mark all read
        </button>
      </div>
      <ul className="divide-y divide-ruleSoft">
        {(unread.length ? unread : inbox.items.slice(0, 3)).map((i) => (
          <li key={i.id}>
            <InboxRow item={i} onOpen={(x) => inbox.markRead([x.id])} />
          </li>
        ))}
      </ul>
    </section>
  );
}
