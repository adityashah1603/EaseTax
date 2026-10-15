// After filing (FR-6.2–6.5, §7.11): the filed return's client copy, amendments against the
// frozen snapshot, notice response cases, and roll-forward to next year.
import type { FilingStatusDto, FrozenLine, RollChange, RollHistoryPoint, RollOpenItem, RollProvenance, RollforwardDocument } from '@easetax/shared';
import { nodeKind } from '@easetax/shared';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { FileDown, FileText, Forward, Printer } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { ApiFailure, api } from '../../api/client';
import { useSummary } from '../../api/hooks';
import { useAmendment, useSnapshot, type FilingResult, type FilingSnapshotDto, type NoticeRecord } from '../../api/workflowHooks';
import { fmtDate, fmtDateTime, fmtNum, fmtValue, humanize } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { useSession } from '../../state/session';
import { Empty, ErrorBox, Field, Loading, TraceValue } from '../ui';
import { Hash, Panel, Pill, fetchAsActor, openBlob, saveBlob, useAction, useRoleGate, type Tone } from './bits';

const STAFF_WORK = ['preparer', 'reviewer', 'partner'] as const;

/** D-28: the filed return is the snapshot behind the latest accepted federal submission, else the latest filing snapshot. */
export function filedSnapshotOf(st: FilingStatusDto): string | undefined {
  const acc = st.submissions.filter((s) => s.jurisdiction === 'federal' && s.status === 'accepted').at(-1);
  return acc?.snapshotId ?? st.snapshots.filter((s) => s.kind === 'filing').at(-1)?.id;
}

const esc = (v: unknown) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The client's copy as a self-contained, printable page built from the frozen snapshot. */
function clientCopyHtml(snap: FilingSnapshotDto, name: string, st: FilingStatusDto): string {
  const c = snap.content;
  const forms = new Map<string, FrozenLine[]>();
  for (const l of c.lines) forms.set(l.form, [...(forms.get(l.form) ?? []), l]);
  const subs = st.submissions.filter((s) => s.snapshotId === snap.id);
  const fed = c.summary.federal;
  const ca = c.summary.california;
  const money = (n: unknown) => (typeof n === 'number' ? fmtNum(n) : esc(fmtValue(n)));
  const sumRows = (o: Record<string, number>) =>
    Object.entries(o)
      .map(([k, v]) => `<tr><th>${esc(humanize(k))}</th><td class="n">${money(v)}</td></tr>`)
      .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(name)} ${c.taxYear} return (client copy)</title>
<style>body{font:13px/1.45 Georgia,serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1a2420;background:#fff}h1{font-size:22px;margin:0}h2{font-size:15px;border-bottom:2px solid #1a2420;padding-bottom:2px;margin-top:22px;break-after:avoid}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #dce1db;padding:3px 6px;text-align:left;vertical-align:top;font-weight:normal}th{color:#56625c}.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.ln{width:70px;color:#56625c}.meta{color:#56625c;font-size:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}code{font-size:11px;word-break:break-all}.adj{color:#2c5ba0}@media print{body{margin:0}}</style></head><body>
<h1>${esc(name)}</h1>
<p class="meta">Tax year ${c.taxYear} · client ${esc(c.clientId)} · prepared by Miraflores · engine ${esc(c.version)}</p>
<p class="meta">This is your copy of the return as filed. It was frozen at event #${c.seq}; content hash <code>${esc(snap.contentHash)}</code>.</p>
${subs.length ? `<table>${subs.map((s) => `<tr><th>${esc(humanize(s.jurisdiction))}</th><td>${esc(humanize(s.status))}</td><td>${esc(s.agencySubmissionId ?? '')}</td><td>${esc(fmtDate(s.resultAt ?? s.submittedAt))}</td></tr>`).join('')}</table>` : ''}
<div class="grid"><div><h2>Federal (Form 1040)</h2><table>${sumRows(fed)}</table></div><div><h2>California (540NR)</h2><table>${sumRows(ca)}</table></div></div>
${[...forms.entries()]
  .map(
    ([form, ls]) =>
      `<h2>${esc(form)}</h2><table>${ls
        .map((l) => `<tr><td class="ln">${esc(l.line)}</td><td>${esc(l.label)}</td><td class="n${l.adjusted ? ' adj' : ''}">${money(l.value)}</td></tr>`)
        .join('')}</table>`,
  )
  .join('')}
</body></html>`;
}

export function ClientCopyPanel({ st }: { st: FilingStatusDto }) {
  const id = filedSnapshotOf(st);
  const snap = useSnapshot(id);
  const summary = useSummary();
  const name = summary.data?.name.replace(/ - tax year \d+$/, '') ?? 'Client';
  const c = snap.data?.content;
  const open = () => snap.data && openBlob(new Blob([clientCopyHtml(snap.data, name, st)], { type: 'text/html' }));
  return (
    <Panel
      title="Filed return: client copy"
      sub={st.filed ? 'Rendered from the frozen snapshot behind the accepted federal submission (D-28), not from the live workpaper.' : 'Not accepted yet; this shows the latest frozen submission.'}
      right={
        <>
          <button className="btn text-xs" disabled={!snap.data} onClick={open}>
            <Printer size={13} /> Open printable copy
          </button>
          <button className="btn-ghost text-xs" disabled={!snap.data} onClick={() => snap.data && saveBlob(new Blob([clientCopyHtml(snap.data, name, st)], { type: 'text/html' }), `${c?.clientId}-${c?.taxYear}-client-copy.html`)}>
            <FileDown size={13} /> Save
          </button>
        </>
      }
    >
      {!id ? (
        <p className="text-sm text-faint">Nothing has been frozen yet. The client copy appears once the return is submitted.</p>
      ) : snap.isLoading ? (
        <Loading what="the frozen return" />
      ) : snap.error ? (
        <ErrorBox error={snap.error} />
      ) : c ? (
        <div className="grid gap-4 text-sm sm:grid-cols-[1fr_1fr_1.2fr]">
          <div>
            <div className="text-xs text-graphite">Federal balance due</div>
            <div className="num font-serif text-xl font-semibold">{fmtNum(c.summary.federal.balance_due ?? 0)}</div>
            <div className="num text-xs text-graphite">total tax {fmtNum(c.summary.federal.total_tax ?? 0)}</div>
          </div>
          <div>
            <div className="text-xs text-graphite">California balance due</div>
            <div className="num font-serif text-xl font-semibold">{fmtNum(c.summary.california.balance_due ?? 0)}</div>
            <div className="num text-xs text-graphite">total tax {fmtNum(c.summary.california.total_tax ?? 0)}</div>
          </div>
          <div className="text-xs text-graphite">
            {c.lines.length} lines on {new Set(c.lines.map((l) => l.form)).size} forms, {c.lines.filter((l) => l.adjusted).length} adjusted in the workpaper. Frozen at event #{c.seq}, engine {c.version}.
            <div className="mt-1">
              Snapshot <code className="font-mono">{id.slice(0, 8)}…</code> <Hash value={snap.data?.contentHash} />
            </div>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

export function AmendmentsPanel({ st }: { st: FilingStatusDto }) {
  const gate = useRoleGate(['reviewer', 'partner'], 'open an amendment');
  const act = useAction();
  const { nameOf } = useSession();
  const filingSnaps = st.snapshots.filter((s) => s.kind === 'filing');
  const filed = filedSnapshotOf(st);
  const [base, setBase] = useState('');
  const [reason, setReason] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const chosen = sel ?? st.amendments.at(-1)?.id ?? null;
  const diff = useAmendment(chosen);
  const drawer = useDrawer();
  return (
    <Panel title="Amendments" sub="An amendment layers later changes on top of a frozen snapshot. Its diff is the current effective return against what was filed.">
      {filingSnaps.length === 0 ? (
        <p className="text-sm text-faint">Nothing filed yet: there is no snapshot to amend.</p>
      ) : (
        <form
          className="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] sm:items-end"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await act.run(
              'amend',
              () => api<FilingResult<{ amendmentId: string }>>('/api/amendments', { method: 'POST', body: { baseSnapshotId: base || filed, reason } }),
              'Amendment opened',
            );
            if (r?.data) {
              setSel(r.data.amendmentId);
              setReason('');
            }
          }}
        >
          <Field label="Start from snapshot">
            <select className="input" value={base || filed} onChange={(e) => setBase(e.target.value)}>
              {filingSnaps.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id.slice(0, 8)}… · event #{s.seq} · {fmtDate(s.at)}
                  {s.id === filed ? ' (filed return)' : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reason for the amendment">
            <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. corrected 1099-B received after filing" />
          </Field>
          <div className="mb-3">
            <button className="btn-primary" disabled={!gate.allowed || !reason.trim() || act.busy === 'amend'} title={gate.why}>
              Open amendment
            </button>
          </div>
        </form>
      )}
      <ErrorBox error={act.error} />
      {st.amendments.length > 0 && (
        <div className="mt-2">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {st.amendments.map((a, i) => (
              <button
                key={a.id}
                className={clsx('rounded-full border px-2.5 py-0.5 text-xs', a.id === chosen ? 'border-ink bg-ink text-white' : 'border-rule hover:border-graphite')}
                onClick={() => setSel(a.id)}
                title={a.reason}
              >
                Amendment {i + 1} · {nameOf(a.by)} · {fmtDate(a.at)}
              </button>
            ))}
          </div>
          {diff.isLoading ? (
            <Loading what="the diff" />
          ) : diff.error ? (
            <ErrorBox error={diff.error} />
          ) : diff.data ? (
            <div>
              <p className="mb-2 text-xs text-graphite">
                “{diff.data.amendment.reason}” · against snapshot <code className="font-mono">{diff.data.base.snapshotId.slice(0, 8)}…</code> (event #{diff.data.base.seq}) <Hash value={diff.data.base.contentHash} />
              </p>
              {diff.data.diffs.length === 0 ? (
                <Empty>No line differs from the filed return yet. Adjustments made from now on appear here.</Empty>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-rule text-left text-xs text-graphite">
                      <th className="py-1 font-semibold">Line</th>
                      <th className="font-semibold">Description</th>
                      <th className="text-right font-semibold">As filed</th>
                      <th className="text-right font-semibold">Now</th>
                      <th className="text-right font-semibold">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diff.data.diffs.map((d) => (
                      <tr key={d.key} className="border-b border-ruleSoft">
                        <td className="py-1 font-mono text-xs">{d.key}</td>
                        <td className="truncate">{d.label}</td>
                        <td className="num text-right text-graphite">{fmtValue(d.filed)}</td>
                        <td className="text-right">
                          <TraceValue nodeId={d.nodeId} value={d.current} />
                        </td>
                        <td className="num text-right text-xs">
                          {typeof d.filed === 'number' && typeof d.current === 'number' ? fmtNum(d.current - d.filed) : humanize(d.change)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {diff.data.changesSinceFiling.length > 0 && (
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer text-graphite">{diff.data.changesSinceFiling.length} adjustment event(s) since filing</summary>
                  <ul className="mt-1 space-y-0.5">
                    {diff.data.changesSinceFiling.map((e) => (
                      <li key={e.id}>
                        #{e.seq} {nameOf(e.actor)} {humanize(e.type)} {fmtDateTime(e.at)}
                        {(e.payload as { nodeId?: string }).nodeId && (
                          <button className="ml-1 text-blue-ink underline decoration-dotted" onClick={() => drawer.open((e.payload as { nodeId: string }).nodeId)}>
                            {(e.payload as { nodeId: string }).nodeId}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

/**
 * Agency notices. The API has no notice list, so read the agency records one by one through
 * the node endpoint (agency:/notices/N) until one is missing.
 */
function useNotices() {
  return useQuery({
    queryKey: ['notices'],
    staleTime: Infinity,
    queryFn: async () => {
      const out: NoticeRecord[] = [];
      for (let i = 0; i < 20; i++) {
        try {
          const d = await api<{ raw: NoticeRecord }>(`/api/nodes/${encodeURIComponent(`agency:/notices/${i}`)}`);
          if (!d.raw || typeof d.raw !== 'object' || !('id' in d.raw)) break;
          out.push(d.raw);
        } catch (e) {
          if (e instanceof ApiFailure && e.status === 404) break;
          throw e;
        }
      }
      return out;
    },
  });
}

interface CaseTrace {
  id: string;
  kind: string;
  label: string;
  edge?: string;
  value?: unknown;
  engineValue?: unknown;
  adjusted?: boolean;
  confidence?: number;
  children: CaseTrace[];
  repeated?: boolean;
}
interface CaseBundle {
  caseId: string;
  contentHash?: string;
  notice: { id: string; agency: string; type: string; taxYear: number; dated: string; responseDue?: string; itemsUnderExamination: string[] };
  filedReturn: { snapshotId: string; contentHash: string; seq: number; engineVersion: string; submissions: { id: string; jurisdiction: string; status: string; agencySubmissionId?: string }[] };
  items: {
    item: number;
    text: string;
    lines: (FrozenLine | null)[];
    traces: CaseTrace[];
    documents: { id: string; title: string; issuer: string; inTrace: boolean; values: unknown[] }[];
    reconciliation?: Record<string, number>;
    workpaper: Record<string, unknown[]>;
  }[];
  signoffs: { scope: string; level: string; by: string; at: string; status: string }[];
}

function TraceTree({ t, depth = 0 }: { t: CaseTrace; depth?: number }) {
  const drawer = useDrawer();
  const [open, setOpen] = useState(depth < 2);
  return (
    <li className="my-0.5">
      <span className="inline-flex flex-wrap items-baseline gap-1.5 text-xs">
        {t.children.length > 0 ? (
          <button className="w-3 text-faint" onClick={() => setOpen(!open)} aria-label={open ? 'Collapse' : 'Expand'}>
            {open ? '−' : '+'}
          </button>
        ) : (
          <span className="w-3" />
        )}
        <span className="rounded bg-blue-soft px-1 font-mono text-2xs text-blue-ink">{t.kind}</span>
        <button className="text-left hover:underline" onClick={() => drawer.open(t.id)} title="Open the live trace">
          {t.label}
        </button>
        {t.value !== undefined && <span className="num font-semibold">{fmtValue(t.value)}</span>}
        {t.adjusted && <span className="text-amber-ink">(engine {fmtValue(t.engineValue)})</span>}
        {t.confidence !== undefined && t.confidence < 0.9 && <span className="text-pencil">confidence {t.confidence}</span>}
        {t.repeated && <i className="text-faint">(see above)</i>}
      </span>
      {open && t.children.length > 0 && (
        <ul className="ml-1.5 border-l border-dotted border-faint pl-3">
          {t.children.map((c, i) => (
            <TraceTree key={`${c.id}-${i}`} t={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function CaseView({ caseId }: { caseId: string }) {
  const q = useQuery({ queryKey: ['notice-case', caseId], staleTime: Infinity, queryFn: async () => JSON.parse(await (await fetchAsActor(`/api/notices/${encodeURIComponent(caseId)}/export?format=json`)).text()) as CaseBundle });
  const [err, setErr] = useState<unknown>(null);
  const exp = async (format: 'json' | 'html') => {
    setErr(null);
    try {
      const blob = await fetchAsActor(`/api/notices/${encodeURIComponent(caseId)}/export?format=${format}`);
      if (format === 'html') openBlob(new Blob([blob], { type: 'text/html' }));
      else saveBlob(blob, `${caseId}.json`);
    } catch (e) {
      setErr(e);
    }
  };
  const b = q.data;
  return (
    <div className="rounded border border-ruleSoft">
      <div className="flex flex-wrap items-center gap-2 border-b border-ruleSoft bg-paper px-3 py-1.5 text-xs">
        <span className="font-semibold">{caseId}</span>
        {b?.contentHash && <Hash value={b.contentHash} label="Bundle hash" />}
        <span className="flex-1" />
        <button className="btn text-xs" onClick={() => exp('html')}>
          <FileText size={12} /> Export HTML
        </button>
        <button className="btn text-xs" onClick={() => exp('json')}>
          <FileDown size={12} /> Export JSON
        </button>
      </div>
      <div className="px-3 py-2">
        <ErrorBox error={err ?? q.error} />
        {q.isLoading && <Loading what="the bundle" />}
        {b && (
          <>
            <p className="mb-2 text-xs text-graphite">
              Answered from the return as filed: snapshot <code className="font-mono">{b.filedReturn.snapshotId.slice(0, 8)}…</code> <Hash value={b.filedReturn.contentHash} /> (event #{b.filedReturn.seq}, engine{' '}
              {b.filedReturn.engineVersion}).{' '}
              {b.filedReturn.submissions.map((s) => `${humanize(s.jurisdiction)} ${s.status}${s.agencySubmissionId ? ` #${s.agencySubmissionId}` : ''}`).join('; ')}
            </p>
            {b.items.map((it) => (
              <div key={it.item} className="mb-3 border-t border-ruleSoft pt-2">
                <div className="text-sm font-semibold">Item {it.item}</div>
                <p className="mb-1.5 text-sm italic text-graphite">{it.text}</p>
                <div className="grid gap-3 lg:grid-cols-2">
                  <div>
                    <div className="section-title mb-1">Lines as filed</div>
                    {it.lines.filter(Boolean).map((l) => (
                      <div key={l!.key} className="flex justify-between gap-2 text-sm">
                        <span className="truncate">
                          {l!.form} {l!.line} · {l!.label}
                        </span>
                        <span className="num shrink-0 font-semibold">
                          {fmtValue(l!.value)}
                          {l!.adjusted && <span className="ml-1 text-xs font-normal text-amber-ink">(engine {fmtValue(l!.engineValue)})</span>}
                        </span>
                      </div>
                    ))}
                    {it.reconciliation && (
                      <table className="mt-2 w-full text-xs">
                        <tbody>
                          {Object.entries(it.reconciliation).map(([k, v]) => (
                            <tr key={k} className="border-b border-ruleSoft">
                              <td className="py-0.5 text-graphite">{humanize(k.replace(/([A-Z])/g, ' $1'))}</td>
                              <td className="num text-right">{fmtNum(v)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    <div className="section-title mb-1 mt-2">In the bundle</div>
                    <div className="flex flex-wrap gap-1">
                      <Pill tone="info">{it.documents.length} documents ({it.documents.filter((d) => d.inTrace).length} in trace)</Pill>
                      {Object.entries(it.workpaper).map(([k, v]) => (
                        <Pill key={k} tone={v.length ? 'neutral' : 'warn'}>
                          {v.length} {humanize(k.replace(/([A-Z])/g, ' $1')).toLowerCase()}
                        </Pill>
                      ))}
                    </div>
                  </div>
                  <div>
                    <div className="section-title mb-1">Trace to sources</div>
                    <ul className="max-h-[260px] overflow-auto">
                      {it.traces.map((t) => (
                        <TraceTree key={t.id} t={t} />
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ))}
            <div className="border-t border-ruleSoft pt-2 text-xs text-graphite">
              Sign-offs at filing: {b.signoffs.length ? b.signoffs.map((s) => `${s.level} on ${s.scope} (${s.status})`).join('; ') : 'none in the snapshot'}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function NoticePanel({ st }: { st: FilingStatusDto }) {
  const gate = useRoleGate([...STAFF_WORK], 'assemble a notice response');
  const notices = useNotices();
  const act = useAction();
  const { nameOf } = useSession();
  const [sel, setSel] = useState<string | null>(null);
  const answerable = (notices.data ?? []).filter((n) => (n.items_under_examination ?? []).length > 0);
  const chosen = sel ?? st.noticeCases.at(-1)?.caseId ?? null;
  return (
    <Panel title="Notices" sub="A response case collects, for each item under examination, the filed values, their full trace to source documents, evidence, decisions and sign-offs, read only from the filed snapshot. It exports as a self-contained bundle.">
      {notices.isLoading && <Loading what="agency notices" />}
      <ErrorBox error={notices.error} />
      <ul className="mb-3 divide-y divide-ruleSoft">
        {(notices.data ?? []).map((n) => {
          const cases = st.noticeCases.filter((c) => c.noticeId === n.id);
          const canOpen = answerable.includes(n);
          return (
            <li key={n.id} className="flex flex-wrap items-start gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  <span className="font-semibold">
                    {n.agency} {n.type}
                  </span>{' '}
                  <span className="text-graphite">
                    · tax year {n.tax_year} · dated {fmtDate(n.dated)}
                    {n.response_due && ` · response due ${fmtDate(n.response_due)}`}
                  </span>
                </div>
                {n.items_under_examination ? (
                  <ol className="ml-4 list-decimal text-xs text-graphite">
                    {n.items_under_examination.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ol>
                ) : (
                  <div className="text-xs text-graphite">
                    {n.summary} {n.status && <span className="text-faint">{n.status}</span>}
                  </div>
                )}
                {cases.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {cases.map((c) => (
                      <button
                        key={c.caseId}
                        onClick={() => setSel(c.caseId)}
                        className={clsx('rounded-full border px-2 py-0.5 text-2xs', c.caseId === chosen ? 'border-ink bg-ink text-white' : 'border-rule hover:border-graphite')}
                      >
                        Case {c.caseId.slice(-8)} · {nameOf(c.by)} · {fmtDate(c.at)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {canOpen && (
                <button
                  className="btn text-xs"
                  disabled={!gate.allowed || act.busy === n.id}
                  title={gate.why}
                  onClick={async () => {
                    const r = await act.run(n.id, () => api<FilingResult<{ caseId: string }>>(`/api/notices/${encodeURIComponent(n.id)}/case`, { method: 'POST', body: {} }), 'Response case assembled from the filed return');
                    if (r?.data) setSel(r.data.caseId);
                  }}
                >
                  Open response case
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorBox error={act.error} />
      {chosen && <CaseView caseId={chosen} />}
    </Panel>
  );
}

// ---------------------------------------------------------------- roll-forward

/** Drawer-openable ids (issue / judgment / note ids are not nodes; their items open their primary node). */
const isNode = (id: string | undefined): id is string => !!id && !!nodeKind(id) && !id.startsWith('version:');

const fmtHist = (v: unknown) => (typeof v === 'number' ? fmtNum(v) : v === null || v === undefined ? '—' : String(v));

/** 2024 → 2025 → 2026 inline; each figure with a node opens the trace drawer on it. */
function RollHistory({ points }: { points: RollHistoryPoint[] }) {
  const drawer = useDrawer();
  if (!points.length) return null;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1 text-2xs text-graphite">
      {points.map((h, i) => (
        <span key={i} className="inline-flex items-baseline gap-1">
          {i > 0 && <span className="text-faint">→</span>}
          <span className="text-faint">{h.year}</span>
          {isNode(h.nodeId) ? (
            <button
              type="button"
              className="num max-w-[16rem] truncate underline decoration-faint decoration-dotted underline-offset-2 hover:bg-blue-soft hover:text-blue-ink"
              title={`${h.label}${h.note ? ` · ${h.note}` : ''} — trace ${h.nodeId}`}
              onClick={(e) => {
                e.stopPropagation();
                drawer.open(h.nodeId!);
              }}
            >
              {fmtHist(h.value)}
            </button>
          ) : (
            <span className={clsx('num max-w-[16rem] truncate', h.year > 2025 && 'font-semibold text-ink')} title={`${h.label}${h.note ? ` · ${h.note}` : ''}`}>
              {fmtHist(h.value)}
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

const CHANGE_TONE: Record<RollChange['kind'], Tone> = {
  adjustment: 'info',
  read_correction: 'info',
  judgment: 'ok',
  variance_explanation: 'neutral',
  issue: 'warn',
  note: 'neutral',
  question: 'neutral',
};

/** Sources and 2025 changes behind an item, folded so the list stays scannable. */
function RollProvenanceDetails({ item }: { item: RollProvenance }) {
  const drawer = useDrawer();
  return (
    <details className="mt-0.5 text-2xs" onClick={(e) => e.stopPropagation()}>
      <summary className="cursor-pointer select-none text-faint hover:text-blue-ink">
        {item.sources.length} source{item.sources.length === 1 ? '' : 's'}
        {item.changes.length > 0 && ` · ${item.changes.length} change${item.changes.length === 1 ? '' : 's'} in 2025`}
      </summary>
      <div className="mt-1 flex flex-wrap gap-1">
        {item.sources.map((s) =>
          isNode(s) ? (
            <button key={s} type="button" className="rounded border border-rule px-1 font-mono text-blue-ink hover:bg-blue-soft" onClick={() => drawer.open(s)}>
              {s}
            </button>
          ) : (
            <span key={s} className="rounded border border-ruleSoft px-1 font-mono text-graphite" title="Issue, judgment, note or question id; the item opens on its node">
              {s}
            </span>
          ),
        )}
      </div>
      {item.changes.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {item.changes.map((c) => (
            <li key={`${c.kind}:${c.id}`} className="flex items-baseline gap-1.5">
              <Pill tone={CHANGE_TONE[c.kind]}>{humanize(c.kind)}</Pill>
              {isNode(c.nodeId) ? (
                <button type="button" className="text-left hover:text-blue-ink hover:underline" onClick={() => drawer.open(c.nodeId!)}>
                  {c.summary}
                </button>
              ) : (
                <span>{c.summary}</span>
              )}
              <span className="whitespace-nowrap text-faint">
                {c.status && `${c.status} · `}
                {c.by}
                {c.at && ` · ${fmtDate(c.at)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** One roll-forward item: clicking it opens the trace drawer on its primary source. */
function RollItem({ item, title, sub, amount, lead }: { item: RollProvenance; title: ReactNode; sub?: string; amount?: unknown; lead?: ReactNode }) {
  const drawer = useDrawer();
  const open = () => item.primary && drawer.open(item.primary);
  return (
    <li
      className={clsx('border-b border-ruleSoft py-1', item.primary && 'cursor-pointer hover:bg-paper')}
      onClick={open}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), open())}
      tabIndex={item.primary ? 0 : undefined}
      title={item.primary ? `Trace ${item.primary}` : undefined}
    >
      <div className="flex items-baseline gap-2 text-xs">
        {lead}
        <span className="min-w-0 flex-1">
          {title}
          {sub && <span className="ml-1 text-2xs text-faint">{sub}</span>}
        </span>
        {amount !== undefined && <span className="num font-semibold">{fmtHist(amount)}</span>}
      </div>
      <RollHistory points={item.history} />
      <RollProvenanceDetails item={item} />
    </li>
  );
}

function RollGroup({ title, count, children, open = true }: { title: string; count: number; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="mb-2">
      <summary className="section-title mb-1 cursor-pointer select-none">
        {title} ({count})
      </summary>
      <ul>{children}</ul>
    </details>
  );
}

const OPEN_KIND_TITLE: Record<RollOpenItem['kind'], string> = {
  issue: 'Open issues',
  question: 'Open client questions',
  note: 'Open review notes',
  outside_filing: 'Filings outside the return',
  engine_diagnostic: 'Engine carryforward / not-computed items',
  judgment: 'Elections and judgments to apply again',
  prior_preparer: 'Left open by the prior preparer (2024)',
};

export function RollForwardPanel({ st }: { st: FilingStatusDto }) {
  const gate = useRoleGate([...STAFF_WORK], 'roll the file forward');
  const act = useAction();
  const latest = st.snapshots.filter((s) => s.kind === 'rollforward').at(-1);
  const snap = useSnapshot(latest?.id);
  const doc = snap.data?.content as unknown as RollforwardDocument | undefined;
  const openByKind = useMemo(() => {
    const m = new Map<RollOpenItem['kind'], RollOpenItem[]>();
    for (const o of doc?.openItems ?? []) m.set(o.kind, [...(m.get(o.kind) ?? []), o]);
    return [...m.entries()];
  }, [doc]);
  // Documents rolled before items carried provenance have no `sources`; ask for a fresh roll.
  const legacy = !!doc && !doc.builtFrom;
  return (
    <Panel
      title={`Roll forward to ${doc?.toYear ?? 2026}`}
      sub="Carryovers, basis, the asset register, open items and estimate planning. Every item traces to the 2025 node it came from, with its 2024 → 2025 → 2026 history and the 2025 work that changed it."
      right={
        <button
          className="btn-primary"
          disabled={!gate.allowed || act.busy === 'roll'}
          title={gate.why}
          onClick={() => act.run('roll', () => api<FilingResult>('/api/rollforward', { method: 'POST', body: { toYear: 2026 } }), 'Rolled forward to 2026')}
        >
          <Forward size={14} /> {latest ? 'Roll forward again' : 'Roll forward'}
        </button>
      }
    >
      <ErrorBox error={act.error} />
      {!latest ? (
        <p className="text-sm text-faint">Not rolled forward yet.</p>
      ) : snap.isLoading ? (
        <Loading />
      ) : legacy ? (
        <p className="text-sm text-faint">This roll-forward predates item-level tracing. Roll forward again to trace each item back to 2025.</p>
      ) : doc ? (
        <div className="space-y-3 text-sm">
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-graphite">
            <span>
              {doc.fromYear} → {doc.toYear}.
            </span>
            {doc.builtFrom.kind === 'filed_snapshot' ? (
              <Pill tone={doc.builtFrom.accepted ? 'ok' : 'warn'} title="D-28: the filed return is the snapshot behind the accepted federal submission">
                From the filed return
              </Pill>
            ) : (
              <Pill tone="warn" title="Nothing filed yet: values are the live workpaper's and can still change">
                From the live workpaper
              </Pill>
            )}
            <span>{doc.builtFrom.text}, event #{doc.builtFrom.seq}.</span>
            <span>
              Document <code className="font-mono">{latest.id.slice(0, 8)}…</code> <Hash value={latest.contentHash} />
            </span>
          </p>
          <p className="text-2xs text-faint">Click any item to trace it; click a year's figure to trace that figure.</p>
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <RollGroup title="Carryovers out" count={doc.carryovers.length}>
                {doc.carryovers.map((c) => (
                  <RollItem key={`${c.jurisdiction}.${c.key}`} item={c} title={c.label} amount={c.amount} lead={<span className="w-6 shrink-0 text-2xs text-graphite">{c.jurisdiction === 'california' ? 'CA' : 'Fed'}</span>} />
                ))}
              </RollGroup>
              <RollGroup title="Basis" count={doc.basis.length}>
                {doc.basis.map((b) => (
                  <RollItem key={b.what} item={b} title={b.what} sub={b.note} amount={b.amount} />
                ))}
              </RollGroup>
              <RollGroup title="Asset register (in service)" count={doc.assets.length}>
                {doc.assets.map((a) => (
                  <RollItem key={a.assetId} item={a} title={a.description} sub={`${a.method} · ${a.lifeYears} yr · cost ${fmtNum(a.cost)}`} amount={a.federalAccumulated} />
                ))}
              </RollGroup>
              {doc.disposedAssets.length > 0 && (
                <RollGroup title="Disposed in 2025 (leave the register)" count={doc.disposedAssets.length} open={false}>
                  {doc.disposedAssets.map((a) => (
                    <RollItem key={a.assetId} item={a} title={a.description} sub={`disposed ${fmtDate(a.disposed)}`} />
                  ))}
                </RollGroup>
              )}
            </div>
            <div>
              <div className="section-title mb-1">{doc.toYear} estimates</div>
              {(['federal', 'california'] as const).map((j) => (
                <div key={j} className="mb-2">
                  <div className="text-xs">
                    <span className="font-semibold">{humanize(j)}</span>: required annual payment <span className="num font-semibold">{fmtNum(doc.planning[j].requiredAnnualPayment)}</span>
                    {doc.planning[j].safeHarbor && <span className="block text-2xs text-faint">{doc.planning[j].safeHarbor}</span>}
                  </div>
                  <div className="flex flex-wrap gap-1.5 text-2xs">
                    {doc.planning[j].installments.map((x) => (
                      <span key={x.due} className="num rounded border border-rule px-1.5">
                        {fmtDate(x.due)}: {fmtNum(x.amount)}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-2xs text-faint">{doc.planning.note}</p>
              <RollGroup title="Planning rests on" count={doc.planning.items.length}>
                {doc.planning.items.map((p) => (
                  <RollItem key={p.key} item={p} title={p.text ?? p.label} amount={p.amount} />
                ))}
              </RollGroup>
              <div className="section-title mb-1 mt-3">Carried into next year</div>
              <p className="mb-1 text-xs">
                {doc.assets.length} assets in service, {doc.disposedAssets.length} disposed. {doc.openItems.length} open items.
              </p>
              {openByKind.map(([kind, items]) => (
                <RollGroup key={kind} title={OPEN_KIND_TITLE[kind] ?? humanize(kind)} count={items.length} open={kind !== 'issue' && items.length <= 8}>
                  {items.map((o, i) => (
                    <RollItem key={`${o.id ?? i}`} item={o} title={o.text} />
                  ))}
                </RollGroup>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
