// App chrome: return identity, role switcher, global search, live presence, navigation.
import type { NodeSummary } from '@easetax/shared';
import clsx from 'clsx';
import { ChevronDown, FileStack, Inbox, LayoutGrid, Search, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useSearch, useSummary } from '../api/hooks';
import { useHotkeys } from '../lib/hotkeys';
import { fmtValue } from '../lib/format';
import { useDrawer } from '../state/drawer';
import { ROLE_LABEL, useSession } from '../state/session';
import { useStream } from '../state/stream';
import { Kbd } from './ui';

export function Shell({ children }: { children: ReactNode }) {
  const { isClient } = useSession();
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        {!isClient && <SideNav />}
        <main className="min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

function TopBar() {
  const summary = useSummary();
  const { isClient } = useSession();
  const s = summary.data;
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b border-rule bg-panel px-4">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="font-serif text-[15px] font-semibold tracking-tight">EaseTax</span>
        {s && (
          <span className="truncate text-sm text-graphite" title={`${s.name} · packet ${s.packetHash.slice(0, 12)}`}>
            {s.name.replace(/ - tax year \d+$/, '')} · {s.taxYear} · {s.clientId} · engine {s.currentVersion}
          </span>
        )}
      </div>
      <div className="flex-1" />
      {!isClient && <GlobalSearch />}
      {!isClient && <PresenceDots />}
      <RoleSwitcher />
    </header>
  );
}

function SideNav() {
  const item = (to: string, icon: ReactNode, text: string, end = false) => (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        clsx('flex items-center gap-2 rounded px-2.5 py-1.5 text-sm', isActive ? 'bg-ink font-semibold text-white' : 'text-graphite hover:bg-ruleSoft hover:text-ink')
      }
    >
      {icon}
      {text}
    </NavLink>
  );
  return (
    <nav className="flex w-[184px] shrink-0 flex-col gap-0.5 border-r border-rule bg-panel p-2" aria-label="Main">
      {item('/', <Inbox size={15} />, 'What needs me', true)}
      {item('/map', <LayoutGrid size={15} />, 'Return map')}
      {item('/documents', <FileStack size={15} />, 'Documents')}
      {item('/signoffs', <ShieldCheck size={15} />, 'Sign-offs')}
      <div className="mt-auto space-y-1 px-2 pb-1 text-2xs text-faint">
        <div>
          <Kbd>/</Kbd> search
        </div>
        <div>
          <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>Enter</Kbd> trace
        </div>
        <div>
          <Kbd>v</Kbd> verify · <Kbd>a</Kbd> adjust · <Kbd>n</Kbd> note
        </div>
      </div>
    </nav>
  );
}

function RoleSwitcher() {
  const { actor, actors, switchTo } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button className="flex items-center gap-2 rounded border border-rule px-2 py-1 text-left hover:border-graphite" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
        <span className="grid h-6 w-6 place-items-center rounded-full bg-ink text-2xs font-semibold text-white">{initials(actor?.name)}</span>
        <span className="leading-tight">
          <span className="block text-sm font-semibold">{actor?.name ?? '…'}</span>
          <span className="block text-2xs text-graphite">
            {actor ? ROLE_LABEL[actor.role] : ''}
            {actor?.kind === 'staff' && (actor.clearance ? ' · cleared for sensitive data' : ' · no sensitive-data clearance')}
          </span>
        </span>
        <ChevronDown size={14} className="text-faint" />
      </button>
      {open && (
        <ul role="listbox" className="absolute right-0 top-full z-50 mt-1 w-[300px] rounded border border-rule bg-panel py-1 shadow-xl">
          <li className="px-3 pb-1 pt-0.5 text-2xs text-faint">Act as (prototype role switcher; the server enforces each role)</li>
          {actors.map((a) => (
            <li key={a.id}>
              <button
                role="option"
                aria-selected={a.id === actor?.id}
                className={clsx('flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-ruleSoft', a.id === actor?.id && 'bg-blue-soft')}
                onClick={() => {
                  switchTo(a.id);
                  setOpen(false);
                  navigate('/');
                }}
              >
                <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ruleSoft text-2xs font-semibold">{initials(a.name)}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{a.name}</span>
                  <span className="block text-2xs text-graphite">
                    {ROLE_LABEL[a.role]}
                    {a.kind === 'staff' && !a.clearance && ' · no clearance'}
                    {a.activeFrom && a.activeFrom > new Date().toISOString().slice(0, 10) && ` · starts ${a.activeFrom}`}
                  </span>
                  {a.note && <span className="block text-2xs text-faint">{a.note}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PresenceDots() {
  const { presence, connected } = useStream();
  const { actorId, nameOf } = useSession();
  const others = [...new Map(presence.filter((p) => p.actor !== actorId).map((p) => [p.actor, p])).values()];
  return (
    <div className="flex items-center gap-1" aria-label="Who is online">
      <span className={clsx('h-2 w-2 rounded-full', connected ? 'bg-ledger' : 'bg-pencil')} title={connected ? 'Live: changes from others appear as they happen' : 'Not connected: reconnecting'} />
      {others.map((p) => (
        <span
          key={p.actor}
          className="grid h-6 w-6 place-items-center rounded-full border-2 border-panel bg-blue text-2xs font-semibold text-white"
          title={`${nameOf(p.actor)}${p.focus ? ` · looking at ${p.focus}` : ''}`}
        >
          {initials(nameOf(p.actor))}
        </span>
      ))}
    </div>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const search = useSearch(q);
  const drawer = useDrawer();
  const navigate = useNavigate();
  const results = search.data ?? [];
  useHotkeys({ '/': () => input.current?.focus() });

  const choose = (r: NodeSummary) => {
    setOpen(false);
    setQ('');
    input.current?.blur();
    if (r.kind === 'doc') navigate(`/documents/${r.id.slice(4)}`);
    else drawer.open(r.id);
  };

  return (
    <div className="relative w-[min(360px,32vw)]">
      <Search size={14} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
      <input
        ref={input}
        className="input pl-7"
        placeholder="Search lines and documents"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setIdx(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setIdx((i) => Math.min(results.length - 1, i + 1));
          else if (e.key === 'ArrowUp') setIdx((i) => Math.max(0, i - 1));
          else if (e.key === 'Enter' && results[idx]) choose(results[idx]!);
          else if (e.key === 'Escape') {
            setOpen(false);
            input.current?.blur();
          }
        }}
        aria-label="Search"
      />
      {!q && <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"><Kbd>/</Kbd></span>}
      {open && q.trim().length >= 2 && (
        <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-[60vh] overflow-auto rounded border border-rule bg-panel py-1 shadow-xl" role="listbox">
          {search.isLoading && <li className="px-3 py-1.5 text-sm text-faint">Searching…</li>}
          {!search.isLoading && results.length === 0 && <li className="px-3 py-1.5 text-sm text-faint">No lines or documents match “{q}”.</li>}
          {results.map((r, i) => (
            <li key={r.id}>
              <button
                role="option"
                aria-selected={i === idx}
                className={clsx('flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm', i === idx ? 'bg-blue-soft' : 'hover:bg-ruleSoft')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(r)}
              >
                <span className="w-[86px] shrink-0 truncate text-xs text-graphite">{r.kind === 'doc' ? r.id.slice(4) : r.sublabel}</span>
                <span className="min-w-0 flex-1 truncate">{r.label}</span>
                {r.value !== undefined && <span className="num shrink-0 text-xs">{fmtValue(r.effectiveValue ?? r.value)}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function initials(name?: string) {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
