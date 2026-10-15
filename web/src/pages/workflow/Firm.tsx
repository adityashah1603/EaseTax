// Firm administration (FR-7, FR-5.5): status overview, firm standards, the sensitive-data
// access log, time against budget, and assignments with deadlines.
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiFailure, api } from '../../api/client';
import { useAreas, useStandards, useSummary, type FirmStandards } from '../../api/hooks';
import { useAccessLog, useFilingStatus, useFirmDashboard, useReadiness, useWorkLog, type Assignment } from '../../api/workflowHooks';
import { Panel, Pill, useAction, useRoleGate } from '../../components/workflow/bits';
import { useReplayAt } from '../../components/workflow/replayClock';
import { Empty, ErrorBox, Field, Loading } from '../../components/ui';
import { fmtDate, fmtDateTime, humanize } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { ROLE_LABEL, useSession } from '../../state/session';

export function Firm() {
  return (
    <div className="mx-auto max-w-[1100px] px-6 py-5">
      <h1 className="font-serif text-2xl font-semibold">Firm</h1>
      <p className="mb-4 max-w-[72ch] text-sm text-graphite">
        Status, standards and people for this engagement. Standards and the access log are for the firm administrator; everyone can see where the work stands.
      </p>
      <StatusOverview />
      <div className="grid gap-x-5 lg:grid-cols-2">
        <TimePanel />
        <AssignmentsPanel />
      </div>
      <StandardsEditor />
      <AccessLogPanel />
    </div>
  );
}

function Stat({ n, label, tone, to }: { n: number | string; label: string; tone?: 'bad' | 'ok'; to?: string }) {
  const body = (
    <>
      <div className={clsx('num font-serif text-2xl font-semibold', tone === 'bad' && 'text-pencil', tone === 'ok' && 'text-ledger')}>{n}</div>
      <div className="text-xs text-graphite">{label}</div>
    </>
  );
  return to ? (
    <Link to={to} className="rounded border border-ruleSoft px-3 py-2 hover:border-graphite">
      {body}
    </Link>
  ) : (
    <div className="rounded border border-ruleSoft px-3 py-2">{body}</div>
  );
}

function StatusOverview() {
  const summary = useSummary();
  const readiness = useReadiness();
  const filing = useFilingStatus();
  const areas = useAreas();
  const s = summary.data?.status;
  const r = readiness.data;
  const f = filing.data;
  const logged = (areas.data ?? []).reduce((t, a) => t + a.loggedHours, 0);
  const budget = (areas.data ?? []).reduce((t, a) => t + (a.budgetHours ?? 0), 0);
  const stage = !f ? '…' : f.filed ? 'Filed' : f.submissions.some((x) => x.status === 'pending') ? 'Awaiting agency' : f.submissions.length ? 'Rejected: resubmit' : r?.ready ? 'Ready to file' : 'In preparation';
  return (
    <Panel title="Status" sub={summary.data ? `${summary.data.name} · engine ${summary.data.currentVersion}` : undefined} right={<Pill tone={f?.filed ? 'ok' : 'info'}>{stage}</Pill>}>
      {!s || !r ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          <Stat n={`${r.steps.filter((x) => x.ok).length}/${r.steps.length}`} label="filing steps done" tone={r.ready ? 'ok' : undefined} to="/filing" />
          <Stat n={s.openIssues} label="open issues" tone={s.openIssues ? 'bad' : 'ok'} to="/" />
          <Stat n={s.blockingNotes} label="blocking notes" tone={s.blockingNotes ? 'bad' : 'ok'} to="/" />
          <Stat n={s.openQuestions} label="open questions" to="/" />
          <Stat n={s.pendingAdjustments} label="awaiting partner" tone={s.pendingAdjustments ? 'bad' : undefined} to="/" />
          <Stat n={s.undispositionedDocs} label="docs without disposition" tone={s.undispositionedDocs ? 'bad' : 'ok'} to="/documents" />
          <Stat n={s.signoffs.filter((x) => x.status === 'valid').length} label={`valid sign-offs (${s.signoffs.filter((x) => x.status === 'reopened').length} reopened)`} to="/signoffs" />
          <Stat n={`${logged.toFixed(1)}/${budget.toFixed(1)}`} label="hours logged / budget" tone={logged > budget ? 'bad' : undefined} />
        </div>
      )}
    </Panel>
  );
}

function TimePanel() {
  const areas = useAreas();
  const { time } = useWorkLog();
  const { nameOf } = useSession();
  const gate = useRoleGate(['preparer', 'reviewer', 'partner', 'quality_reviewer'], 'log time');
  const act = useAction();
  const [area, setArea] = useState('');
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const list = areas.data ?? [];
  const chosen = area || list[0]?.id || '';
  return (
    <Panel title="Time against budget" sub="Budget hours by area come from the firm's engagement budget.">
      {areas.isLoading ? (
        <Loading />
      ) : (
        <ul className="mb-3 space-y-1.5">
          {list.map((a) => {
            const b = a.budgetHours;
            const pct = b ? Math.min(100, (a.loggedHours / b) * 100) : 0;
            const over = b !== undefined && a.loggedHours > b;
            return (
              <li key={a.id} className="grid grid-cols-[minmax(0,1fr)_120px_70px] items-center gap-2 text-sm">
                <Link to={`/areas/${a.id}`} className="truncate hover:underline">
                  {a.title}
                </Link>
                <span className="h-2 overflow-hidden rounded bg-ruleSoft" title={b === undefined ? 'No budget for this area' : `${a.loggedHours} of ${b} hours`}>
                  <span className={clsx('block h-full', over ? 'bg-pencil' : 'bg-ledger')} style={{ width: `${b ? Math.max(pct, a.loggedHours ? 3 : 0) : 0}%` }} />
                </span>
                <span className={clsx('num text-right text-xs', over ? 'font-semibold text-pencil' : 'text-graphite')}>
                  {a.loggedHours}
                  {b !== undefined ? ` / ${b}` : ' · no budget'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="grid grid-cols-[minmax(0,1fr)_70px] gap-2 border-t border-ruleSoft pt-2 sm:grid-cols-[minmax(0,1fr)_70px_minmax(0,1fr)_auto]"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act.run('time', () => api('/api/time', { method: 'POST', body: { area: chosen, hours: Number(hours), note: note || undefined } }), `Logged ${hours} h`);
          if (ok) {
            setHours('');
            setNote('');
          }
        }}
      >
        <select className="input" value={chosen} onChange={(e) => setArea(e.target.value)} aria-label="Area">
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </select>
        <input className="input num" inputMode="decimal" placeholder="hours" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Hours" />
        <input className="input" placeholder="what you did (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
        <button className="btn-primary" disabled={!gate.allowed || !(Number(hours) > 0) || act.busy === 'time'} title={gate.why}>
          Log time
        </button>
      </form>
      <ErrorBox error={act.error} />
      {time.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-graphite">{time.length} time entries</summary>
          <ul className="mt-1 space-y-0.5">
            {[...time].reverse().map((t) => (
              <li key={t.id}>
                {fmtDateTime(t.at)} · {nameOf(t.by)} · <span className="num">{t.hours} h</span> on {list.find((a) => a.id === t.area)?.title ?? t.area}
                {t.note && <span className="text-graphite"> · {t.note}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}

function AssignmentsPanel() {
  const { assignments, isLoading } = useWorkLog();
  const { actors, nameOf } = useSession();
  const areas = useAreas();
  const summary = useSummary();
  const dashboard = useFirmDashboard();
  const replayAt = useReplayAt();
  const gate = useRoleGate(['reviewer', 'partner', 'firm_administrator'], 'assign work');
  const act = useAction();
  const staff = actors.filter((a) => a.kind === 'staff');
  const [scope, setScope] = useState('return');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [text, setText] = useState('');
  const today = (replayAt ?? new Date().toISOString()).slice(0, 10);
  const year = summary.data?.taxYear;
  // Statutory dates follow from the tax year; firm-internal deadlines come from the API when it serves them.
  const deadlines = useMemo(() => {
    const served = dashboard.data?.deadlines;
    if (served?.length) return served;
    return year ? [{ what: 'Original due date (federal and California)', date: `${year + 1}-04-15` }, { what: 'Extended due date (federal and California)', date: `${year + 1}-10-15` }] : [];
  }, [dashboard.data, year]);
  const nextDeadline = deadlines.filter((d) => d.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  const scopeLabel = (s: string) => (s === 'return' ? 'Whole return' : (areas.data?.find((a) => `area:${a.id}` === s)?.title ?? s));
  const open = assignments.filter((a) => !a.done).sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  const done = assignments.filter((a) => a.done);

  const lastDue = deadlines
    .filter((d) => /due date/i.test(d.what))
    .map((d) => d.date)
    .sort()
    .at(-1);
  const complete = (a: Assignment) =>
    act.run(
      a.id,
      async () => {
        try {
          return await api(`/api/assignments/${encodeURIComponent(a.id)}/complete`, { method: 'POST' });
        } catch (e) {
          throw e;
        }
      },
      'Assignment completed',
    );

  return (
    <Panel title="Assignments and deadlines" sub={nextDeadline ? `Next deadline: ${nextDeadline.what}, ${fmtDate(nextDeadline.date)}.` : undefined}>
      <ul className="mb-2 flex flex-wrap gap-1.5 text-2xs">
        {deadlines.map((d) => (
          <li key={d.what + d.date}>
            <Pill tone={d.date < today ? 'neutral' : d.date === nextDeadline?.date ? 'warn' : 'info'} title={d.what}>
              {fmtDate(d.date)} · {d.what.replace(/\s*\(.*\)$/, '')}
            </Pill>
          </li>
        ))}
      </ul>
      {dashboard.data === null && <p className="mb-2 text-2xs text-faint">Showing statutory dates only: the firm's internal deadlines are not served by the API yet.</p>}
      {isLoading ? (
        <Loading />
      ) : open.length === 0 ? (
        <Empty>No open assignments.</Empty>
      ) : (
        <ul className="mb-2 divide-y divide-ruleSoft">
          {open.map((a) => {
            const late = a.due && a.due < today;
            const afterDeadline = !!a.due && !!lastDue && a.due > lastDue;
            return (
              <li key={a.id} className="flex items-start gap-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{a.text}</div>
                  <div className="text-xs text-graphite">
                    {nameOf(a.assignee)} · {scopeLabel(a.scope)} · from {nameOf(a.by)}
                    {a.due && (
                      <span className={clsx('ml-1', late ? 'font-semibold text-pencil' : 'text-graphite')}>
                        · due {fmtDate(a.due)}
                        {late && ' (overdue)'}
                      </span>
                    )}
                    {afterDeadline && <span className="ml-1 text-amber-ink">· after a filing deadline</span>}
                  </div>
                </div>
                <button className="btn text-xs" disabled={act.busy === a.id} onClick={() => complete(a)}>
                  Mark complete
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <ErrorBox error={act.error} />
      {done.length > 0 && <p className="mb-2 text-xs text-faint">{done.length} completed.</p>}
      <form
        className="grid gap-2 border-t border-ruleSoft pt-2 sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await act.run('assign', () => api('/api/assignments', { method: 'POST', body: { scope, assignee: assignee || staff[0]?.id, due: due || undefined, text } }), 'Assigned');
          if (ok) {
            setText('');
            setDue('');
          }
        }}
      >
        <input className="input sm:col-span-2" placeholder="What needs doing" value={text} onChange={(e) => setText(e.target.value)} aria-label="Assignment" />
        <select className="input" value={assignee || staff[0]?.id} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee">
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({ROLE_LABEL[s.role]})
            </option>
          ))}
        </select>
        <select className="input" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Scope">
          <option value="return">Whole return</option>
          {(areas.data ?? []).map((a) => (
            <option key={a.id} value={`area:${a.id}`}>
              {a.title}
            </option>
          ))}
        </select>
        <input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
        <button className="btn-primary justify-center" disabled={!gate.allowed || !text.trim() || act.busy === 'assign'} title={gate.why}>
          <Plus size={14} /> Assign
        </button>
      </form>
    </Panel>
  );
}

/** An editable list of strings (verification types, rules, required steps). */
function ListEditor({ items, onChange, readOnly, multiline, placeholder }: { items: string[]; onChange: (v: string[]) => void; readOnly: boolean; multiline?: boolean; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const set = (i: number, v: string) => onChange(items.map((x, j) => (j === i ? v : x)));
  const move = (i: number, d: -1 | 1) => {
    const n = [...items];
    [n[i], n[i + d]] = [n[i + d]!, n[i]!];
    onChange(n);
  };
  return (
    <div>
      <ol className="space-y-1">
        {items.map((x, i) => (
          <li key={i} className="flex items-start gap-1">
            <span className="num mt-1.5 w-5 shrink-0 text-right text-2xs text-faint">{i + 1}</span>
            {multiline ? (
              <textarea className="input min-h-[34px] flex-1" rows={x.length > 90 ? 2 : 1} value={x} readOnly={readOnly} onChange={(e) => set(i, e.target.value)} />
            ) : (
              <input className="input flex-1" value={x} readOnly={readOnly} onChange={(e) => set(i, e.target.value)} />
            )}
            {!readOnly && (
              <span className="flex shrink-0">
                <button type="button" className="btn-ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  <ArrowUp size={12} />
                </button>
                <button type="button" className="btn-ghost" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                  <ArrowDown size={12} />
                </button>
                <button type="button" className="btn-ghost" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remove">
                  <Trash2 size={12} />
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {!readOnly && (
        <div className="mt-1 flex gap-1 pl-6">
          <input
            className="input flex-1"
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim()) {
                e.preventDefault();
                onChange([...items, draft.trim()]);
                setDraft('');
              }
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={!draft.trim()}
            onClick={() => {
              onChange([...items, draft.trim()]);
              setDraft('');
            }}
          >
            <Plus size={13} /> Add
          </button>
        </div>
      )}
    </div>
  );
}

function StandardsEditor() {
  const std = useStandards();
  const gate = useRoleGate(['firm_administrator'], 'change the firm standards');
  const qc = useQueryClient();
  const act = useAction();
  const [draft, setDraft] = useState<FirmStandards | null>(null);
  useEffect(() => {
    if (std.data && !draft) setDraft(structuredClone(std.data));
  }, [std.data, draft]);
  const dirty = !!draft && !!std.data && JSON.stringify(draft) !== JSON.stringify(std.data);
  const ro = !gate.allowed;
  if (!draft) return <Panel title="Firm standards">{std.isLoading ? <Loading /> : <ErrorBox error={std.error} />}</Panel>;
  const patch = (p: Partial<FirmStandards>) => setDraft({ ...draft, ...p });
  const vr = draft.variance_review;
  const save = async () => {
    const ok = await act.run('std', () => api('/api/firm/standards', { method: 'PUT', body: draft }), 'Firm standards saved. Every screen now uses them.');
    if (ok) {
      await qc.invalidateQueries({ queryKey: ['standards'] });
      setDraft(null);
    }
  };
  return (
    <Panel
      title="Firm standards"
      sub={ro ? `${gate.why} Shown read-only.` : 'Verification types, the variance rule and required filing steps drive the workpaper directly. Required steps with no rule behind them become manual checklist items on the filing page.'}
      right={
        !ro && (
          <>
            {dirty && <Pill tone="warn">Unsaved changes</Pill>}
            <button className="btn text-xs" disabled={!dirty} onClick={() => setDraft(structuredClone(std.data!))}>
              Discard
            </button>
            <button className="btn-primary" disabled={!dirty || act.busy === 'std'} onClick={save}>
              Save standards
            </button>
          </>
        )
      }
    >
      <ErrorBox error={act.error} />
      <div className="grid gap-5 lg:grid-cols-2">
        <div>
          <div className="section-title mb-1">Verification types</div>
          <ListEditor items={draft.verification_types} onChange={(v) => patch({ verification_types: v })} readOnly={ro} placeholder="e.g. agreed_to_bank_statement" />
          <div className="section-title mb-1 mt-4">Variance review</div>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Compare to">
              <input className="input" value={vr.compare_to} readOnly={ro} onChange={(e) => patch({ variance_review: { ...vr, compare_to: e.target.value } })} />
            </Field>
            <Field label="Flag if change over %">
              <input className="input num" type="number" min={0} value={vr.flag_if_change_over_percent} readOnly={ro} onChange={(e) => patch({ variance_review: { ...vr, flag_if_change_over_percent: Number(e.target.value) } })} />
            </Field>
            <Field label="and over amount">
              <input className="input num" type="number" min={0} value={vr.and_over_amount} readOnly={ro} onChange={(e) => patch({ variance_review: { ...vr, and_over_amount: Number(e.target.value) } })} />
            </Field>
          </div>
          <p className="-mt-1 text-2xs text-faint">
            A line is flagged when it moves more than {vr.flag_if_change_over_percent}% and more than {vr.and_over_amount.toLocaleString('en-US')} from the prior year.
          </p>
          <div className="section-title mb-1 mt-4">Review levels</div>
          <div className="flex gap-1">
            {draft.review_levels.map((l) => (
              <Pill key={l} tone="neutral">
                {humanize(l)}
              </Pill>
            ))}
          </div>
        </div>
        <div>
          <div className="section-title mb-1">Required steps before filing</div>
          <ListEditor items={draft.required_steps} onChange={(v) => patch({ required_steps: v })} readOnly={ro} placeholder="e.g. Filing package reviewed by partner" />
        </div>
      </div>
      <div className="section-title mb-1 mt-5">Rules</div>
      <p className="mb-1 text-2xs text-faint">Rule text is quoted when the server refuses an action. The checks themselves are code; rewording a rule changes what people are told, not what is enforced.</p>
      <ListEditor items={draft.rules} onChange={(v) => patch({ rules: v })} readOnly={ro} multiline placeholder="Add a rule" />
    </Panel>
  );
}

function AccessLogPanel() {
  const gate = useRoleGate(['firm_administrator'], 'see the access log');
  const log = useAccessLog(gate.allowed);
  const { nameOf } = useSession();
  const drawer = useDrawer();
  const [who, setWho] = useState('all');
  const rows = (log.data ?? []).filter((r) => who === 'all' || r.actor === who);
  return (
    <Panel
      title="Sensitive-data access log"
      sub="Every unmasked view of an SSN, bank or account number or IP PIN, with the reason given. Nobody sees these unmasked without leaving a line here."
      right={
        gate.allowed && (
          <select className="input w-auto text-xs" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Filter by person">
            <option value="all">Everyone</option>
            {[...new Set((log.data ?? []).map((r) => r.actor))].map((a) => (
              <option key={a} value={a}>
                {nameOf(a)}
              </option>
            ))}
          </select>
        )
      }
    >
      {!gate.allowed ? (
        <p className="text-sm text-graphite">{gate.why}</p>
      ) : log.isLoading ? (
        <Loading />
      ) : log.error ? (
        <ErrorBox error={log.error} />
      ) : rows.length === 0 ? (
        <Empty>No sensitive field has been unmasked.</Empty>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-xs text-graphite">
              <th className="py-1 font-semibold">When</th>
              <th className="font-semibold">Who</th>
              <th className="font-semibold">Item</th>
              <th className="font-semibold">Field</th>
              <th className="font-semibold">Reason</th>
            </tr>
          </thead>
          <tbody>
            {[...rows].reverse().map((r, i) => (
              <tr key={i} className="border-b border-ruleSoft align-top">
                <td className="num py-1 text-xs text-graphite">{fmtDateTime(r.at)}</td>
                <td>{nameOf(r.actor)}</td>
                <td>
                  <button className="font-mono text-xs text-blue-ink underline decoration-dotted" onClick={() => drawer.open(r.nodeId)}>
                    {r.nodeId}
                  </button>
                </td>
                <td className="font-mono text-xs">{r.field}</td>
                <td className="text-xs">{r.reason ?? <span className="text-pencil">none given</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
