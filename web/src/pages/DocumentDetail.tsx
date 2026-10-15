// One document: its pages rendered from printed content with field highlights, and every
// field with the return lines it fed ("where did this document land?").
import clsx from 'clsx';
import { ArrowLeft } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useDocument } from '../api/hooks';
import { DispositionDialog, DISPOSITION_LABEL } from '../components/DispositionDialog';
import { formRows, matchAnchors, SourceRendition } from '../components/source/SourceRendition';
import { ErrorBox, Kbd, Loading, TraceValue } from '../components/ui';
import { fmtDate, fmtValue, isMasked } from '../lib/format';
import { useListNav } from '../lib/useListNav';
import { useDrawer } from '../state/drawer';
import { useSession } from '../state/session';

export function DocumentDetail() {
  const { docId } = useParams();
  const doc = useDocument(docId);
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? 1);
  const ev = params.get('ev');
  const drawer = useDrawer();
  const { can } = useSession();
  const [editing, setEditing] = useState(false);
  const [onlyUnused, setOnlyUnused] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  const setView = (p: number, e: string | null) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.set('page', String(p));
        if (e) n.set('ev', e);
        else n.delete('ev');
        return n;
      },
      { replace: true },
    );

  const d = doc.data;
  const landingByEv = useMemo(() => new Map((d?.landings ?? []).map((l) => [l.evId, l])), [d]);
  const pageData = d?.pages.find((p) => p.page === page);
  const found = useMemo(() => (pageData ? matchAnchors(formRows(pageData.printedContent), pageData.anchors).found : new Set<string>()), [pageData]);
  const fields = (pageData?.anchors ?? []).filter((a) => !onlyUnused || !(landingByEv.get(a.evId)?.lines.length));

  const [cursor, setCursor] = useListNav(
    fields.length,
    {
    Enter: () => fields[cursor] && drawer.open(`ev:${fields[cursor]!.evId}`, { src: `ev:${fields[cursor]!.evId}` }),
    v: () => fields[cursor] && drawer.open(`ev:${fields[cursor]!.evId}`, { act: 'verify', src: `ev:${fields[cursor]!.evId}` }),
    n: () => fields[cursor] && drawer.open(`ev:${fields[cursor]!.evId}`, { act: 'note', src: `ev:${fields[cursor]!.evId}` }),
    },
    (i) => fields[i] && setView(page, fields[i]!.evId),
  );
  useEffect(() => {
    const i = fields.findIndex((f) => f.evId === ev);
    if (i >= 0 && i !== cursor) setCursor(i);
    listRef.current?.querySelector(`[data-ev="${ev}"]`)?.scrollIntoView({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ev, fields.length]);

  if (doc.error) return <div className="p-6"><ErrorBox error={doc.error} /></div>;
  if (!d) return <Loading what="document" />;
  const unusedCount = d.landings.filter((l) => l.lines.length === 0).length;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-rule bg-panel px-6 pb-3 pt-4">
        <Link to="/documents" className="btn-ghost -ml-1.5 mb-1 text-xs">
          <ArrowLeft size={12} /> Documents
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="font-serif text-xl font-semibold">
              {d.id} · {d.title}
            </h1>
            <p className="text-sm text-graphite">
              {d.documentType} from {d.issuer} · tax year {d.taxYear} · received {fmtDate(d.receivedAt)} via {d.uploadedBy} · {d.pageCount} page(s) · {d.fileName}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              {d.disposition ? (
                <span className={clsx('rounded px-1.5 font-semibold', d.disposition.status === 'used' ? 'bg-ledger-soft text-ledger-ink' : 'bg-ruleSoft text-graphite')}>
                  {DISPOSITION_LABEL[d.disposition.status]}
                  {d.disposition.derived ? ' (auto)' : ''}
                </span>
              ) : (
                <span className="rounded bg-pencil px-1.5 font-semibold text-white">No disposition</span>
              )}
              {d.disposition?.note && <span className="text-graphite">{d.disposition.note}</span>}
              <span className="text-graphite">
                · {d.linesFed} line(s) fed · {d.extraction.values} values extracted ({d.extraction.status}){d.extraction.reason ? `: ${d.extraction.reason}` : ''}
              </span>
              {d.markedCorrected && <span className="rounded bg-amber-soft px-1.5 font-semibold text-amber-ink">Marked CORRECTED</span>}
            </p>
          </div>
          {can('disposition') && (
            <button className="btn" onClick={() => setEditing(true)}>
              {d.disposition ? 'Change disposition' : 'Set disposition'}
            </button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,480px)]">
        <div className="min-h-0 overflow-auto bg-[#EEF1ED] px-6 py-4">
          {d.pages.length > 1 && (
            <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Pages">
              {d.pages.map((p) => (
                <button
                  key={p.page}
                  role="tab"
                  aria-selected={p.page === page}
                  className={clsx('rounded border px-2 py-0.5 text-xs', p.page === page ? 'border-ink bg-ink text-white' : 'border-rule bg-panel hover:border-graphite')}
                  onClick={() => setView(p.page, null)}
                >
                  {p.page}
                  {p.anchors.length > 0 && <span className="ml-1 opacity-60">{p.anchors.length}</span>}
                </button>
              ))}
            </div>
          )}
          <div className="mx-auto max-w-[720px]">
            <SourceRendition doc={d} page={page} highlight={ev} onSelect={(e) => setView(page, e)} />
          </div>
        </div>

        <div className="flex min-h-0 flex-col border-l border-rule bg-panel">
          <div className="flex items-center justify-between border-b border-rule px-4 py-2">
            <h2 className="text-sm font-semibold">
              Fields on page {page} <span className="font-normal text-faint">{pageData?.anchors.length ?? 0}</span>
            </h2>
            <label className="flex items-center gap-1.5 text-xs text-graphite">
              <input type="checkbox" checked={onlyUnused} onChange={(e) => setOnlyUnused(e.target.checked)} />
              Only fields that fed nothing ({unusedCount} in document)
            </label>
          </div>
          <ul ref={listRef} className="min-h-0 flex-1 overflow-auto" role="listbox" aria-label="Fields">
            {fields.length === 0 && <li className="px-4 py-6 text-center text-sm text-faint">No extracted fields on this page.</li>}
            {fields.map((a, i) => {
              const land = landingByEv.get(a.evId);
              const sel = a.evId === ev;
              return (
                <li
                  key={a.evId}
                  data-ev={a.evId}
                  role="option"
                  aria-selected={sel}
                  className={clsx('cursor-pointer border-b border-ruleSoft px-4 py-1.5 text-sm', sel ? 'bg-blue-soft' : i === cursor ? 'bg-paper' : 'hover:bg-paper')}
                  onClick={() => (setCursor(i), setView(page, a.evId))}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate">{a.label}</span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      {a.confidence < 0.8 && <span className="rounded bg-amber-soft px-1 text-2xs font-semibold text-amber-ink">{Math.round(a.confidence * 100)}%</span>}
                      {!found.has(a.evId) && (
                        <span className="rounded bg-amber-soft px-1 text-2xs font-semibold text-amber-ink" title="The value as read is not in the printed text">
                          not in print
                        </span>
                      )}
                      <TraceValue nodeId={`ev:${a.evId}`} value={a.value} src={`ev:${a.evId}`} className={clsx(isMasked(a.value) && 'text-graphite')} />
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 text-xs">
                    <span className="text-faint">{a.evId}</span>
                    {land && land.lines.length > 0 ? (
                      land.lines.map((l) => (
                        <button
                          key={l.id}
                          className="text-blue-ink underline decoration-dotted underline-offset-2"
                          onClick={(e) => {
                            e.stopPropagation();
                            drawer.open(l.id, { src: `ev:${a.evId}` });
                          }}
                        >
                          → {l.sublabel} {fmtValue(l.effectiveValue ?? l.value)}
                        </button>
                      ))
                    ) : (
                      <span className="text-graphite">feeds no line</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="border-t border-rule px-4 py-1 text-2xs text-faint">
            <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>Enter</Kbd> trace field · <Kbd>v</Kbd> verify · <Kbd>n</Kbd> note
          </div>
        </div>
      </div>
      {editing && <DispositionDialog doc={d} onClose={() => setEditing(false)} />}
    </div>
  );
}
