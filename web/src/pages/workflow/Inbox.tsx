// "For you": the per-person inbox. Unlike "Since I last looked" (everything others did), this
// lists only what needs you: assignments, mentions, questions to you, answers to yours, reopened
// sign-offs, adjustments awaiting your approval, blocking notes on what you signed.
import type { InboxKind } from '@easetax/shared';
import clsx from 'clsx';
import { CheckCheck, Mail, MailOpen } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useInbox } from '../../api/inboxHooks';
import { InboxRow, KIND_META, useOpenInboxItem } from '../../components/workflow/InboxWidget';
import { Empty, ErrorBox, Loading } from '../../components/ui';

type Filter = 'unread' | 'open' | 'all';

const FILTERS: { id: Filter; text: string }[] = [
  { id: 'unread', text: 'Unread' },
  { id: 'open', text: 'Needs action' },
  { id: 'all', text: 'All' },
];

export function Inbox() {
  const inbox = useInbox();
  const openItem = useOpenInboxItem(inbox);
  const [filter, setFilter] = useState<Filter>('unread');
  const [kind, setKind] = useState<InboxKind | ''>('');

  const shown = useMemo(
    () => inbox.items.filter((i) => (filter === 'unread' ? !i.read : filter === 'open' ? !i.done : true) && (!kind || i.kind === kind)),
    [inbox.items, filter, kind],
  );
  const kinds = [...new Set(inbox.items.map((i) => i.kind))];
  const count = (f: Filter) => inbox.items.filter((i) => (f === 'unread' ? !i.read : f === 'open' ? !i.done : true)).length;

  return (
    <div className="mx-auto max-w-[960px] px-6 py-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold">For you</h1>
          <p className="text-sm text-graphite">
            Assignments, mentions, questions to you and approvals waiting on you. Everything others did is under <span className="italic">Since I last looked</span>.
          </p>
        </div>
        <button className="btn-primary" disabled={!inbox.unread} onClick={() => inbox.markRead(inbox.items.map((i) => i.id))}>
          <CheckCheck size={14} /> Mark all read
        </button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded border border-rule" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              className={clsx('px-2.5 py-1 text-xs', filter === f.id ? 'bg-ink font-semibold text-white' : 'text-graphite hover:bg-ruleSoft')}
              onClick={() => setFilter(f.id)}
            >
              {f.text} <span className="num opacity-80">{count(f.id)}</span>
            </button>
          ))}
        </div>
        <select className="input w-auto text-xs" value={kind} onChange={(e) => setKind(e.target.value as InboxKind | '')} aria-label="Kind">
          <option value="">Every kind</option>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_META[k].label}
            </option>
          ))}
        </select>
        <span className="ml-auto text-2xs text-faint">Read marks are kept in this browser for now.</span>
      </div>
      <ErrorBox error={inbox.error} />
      {inbox.isLoading ? (
        <Loading what="your inbox" />
      ) : shown.length === 0 ? (
        <Empty>{filter === 'unread' ? "You're all caught up." : 'Nothing here.'} New assignments, mentions and questions for you appear here and on the inbox icon in the top bar.</Empty>
      ) : (
        <ul className="divide-y divide-ruleSoft rounded border border-rule bg-panel">
          {shown.map((i) => (
            <li key={i.id} className="flex items-stretch">
              <div className="min-w-0 flex-1">
                <InboxRow item={i} onOpen={openItem} />
              </div>
              <button
                className="shrink-0 px-3 text-faint hover:text-ink"
                title={i.read ? 'Mark unread' : 'Mark read'}
                aria-label={i.read ? 'Mark unread' : 'Mark read'}
                onClick={() => (i.read ? inbox.markUnread(i.id) : inbox.markRead([i.id]))}
              >
                {i.read ? <Mail size={14} /> : <MailOpen size={14} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
