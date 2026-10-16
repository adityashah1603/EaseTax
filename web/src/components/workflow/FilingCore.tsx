// Filing, before and at submission: the readiness checklist, extension, client approval
// state, submit (freeze), and e-file submissions with their results (FR-6.1/6.2, §7.11).
import type { FilingStatusDto, ReadinessDto, ReadinessStepDto, SubmissionDto } from '@easetax/shared';
import clsx from 'clsx';
import { AlertTriangle, Check, ExternalLink, Lock, RotateCcw, Send, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { useEvents, useIssues } from '../../api/hooks';
import { useReadiness, useWhatIfs, type FilingResult } from '../../api/workflowHooks';
import { fmtDateTime, fmtNum, humanize } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { useSession } from '../../state/session';
import { ErrorBox, Field, Modal } from '../ui';
import { Hash, Panel, Pill, useAction, useRoleGate } from './bits';

const FILERS = ['reviewer', 'partner'] as const;

/** Where to go to fix a step, beyond opening its nodes in the trace drawer. */
function fixLink(step: string): { to: string; text: string } | null {
  if (/documents accounted/i.test(step)) return { to: '/documents', text: 'Documents' };
  if (/sign.?off/i.test(step)) return { to: '/signoffs', text: 'Sign-offs' };
  if (/diagnostics/i.test(step)) return { to: '/', text: 'Work queue' };
  if (/variances/i.test(step)) return { to: '/map', text: 'Return map' };
  return null;
}

function NodeChips({ ids, max = 5 }: { ids: string[] | undefined; max?: number }) {
  const drawer = useDrawer();
  if (!ids?.length) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {ids.slice(0, max).map((id) => (
        <button key={id} className="rounded border border-rule px-1.5 font-mono text-2xs text-blue-ink hover:border-blue hover:bg-blue-soft" onClick={() => drawer.open(id)} title="Open the trace">
          {id.length > 34 ? `${id.slice(0, 32)}…` : id}
        </button>
      ))}
      {ids.length > max && <span className="text-2xs text-faint">+{ids.length - max} more</span>}
    </span>
  );
}

export function ReadinessPanel({ r }: { r: ReadinessDto }) {
  const gate = useRoleGate([...FILERS], 'record filing steps');
  const act = useAction();
  const [marking, setMarking] = useState<ReadinessStepDto | null>(null);
  const [note, setNote] = useState('');
  const done = r.steps.filter((s) => s.ok).length;
  return (
    <Panel
      id="readiness"
      title="Ready to file?"
      sub={
        <>
          The firm's required steps, computed from the workpaper as of event #{r.seq}, plus live blockers. Submit stays disabled until every line is clear.{' '}
          <span className="font-semibold">
            {done} of {r.steps.length} steps done
            {r.blockers.length > 0 && `, ${r.blockers.length} blocker(s)`}.
          </span>
        </>
      }
      right={r.ready ? <Pill tone="ok">Ready to file</Pill> : <Pill tone="bad">Not ready</Pill>}
    >
      <ol className="divide-y divide-ruleSoft">
        {r.steps.map((s, i) => {
          const link = fixLink(s.step);
          return (
            <li key={s.step} className="flex items-start gap-3 py-2">
              <span className={clsx('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full', s.ok ? 'bg-ledger text-white' : 'border border-pencil text-pencil')} aria-label={s.ok ? 'Done' : 'Not done'}>
                {s.ok ? <Check size={12} strokeWidth={3} /> : <span className="text-2xs font-semibold">{i + 1}</span>}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className={clsx(s.ok ? 'text-ink' : 'font-semibold')}>{s.step}</span>
                  {s.kind === 'manual' && <Pill tone="neutral" title="No rule computes this step; a person records it">manual</Pill>}
                </div>
                {!s.ok && s.reason && <div className="text-xs text-pencil-ink">{s.reason}</div>}
                {!s.ok && <NodeChips ids={s.nodeIds} />}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {!s.ok && link && (
                  <Link to={link.to} className="btn-ghost text-xs">
                    {link.text} <ExternalLink size={11} />
                  </Link>
                )}
                {s.kind === 'manual' && !s.ok && (
                  <button className="btn text-xs" disabled={!gate.allowed} title={gate.why} onClick={() => (setNote(''), setMarking(s))}>
                    Mark done
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {r.blockers.length > 0 && (
        <div className="mt-2 rounded border border-pencil/40 bg-pencil-soft/50 px-3 py-2">
          <div className="mb-1 text-xs font-semibold text-pencil-ink">Also blocking</div>
          <ul className="space-y-1 text-sm">
            {r.blockers.map((b, i) => (
              <li key={i} className="flex items-start gap-2">
                <AlertTriangle size={13} className="mt-0.5 shrink-0 text-pencil" />
                <span className="min-w-0">
                  {b.text}
                  <NodeChips ids={b.nodeIds} max={3} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {marking && (
        <Modal title="Record step as done" onClose={() => setMarking(null)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await act.run('manual', () => api<FilingResult>('/api/filing/steps/manual', { method: 'POST', body: { step: marking.step, note: note || undefined } }), `Recorded: ${marking.step}`);
              if (ok) setMarking(null);
            }}
          >
            <p className="mb-3 text-sm">{marking.step}</p>
            <Field label="Note (what was done, where it is filed)">
              <textarea className="input min-h-[70px]" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <ErrorBox error={act.error} />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setMarking(null)}>
                Cancel
              </button>
              <button className="btn-primary" disabled={act.busy === 'manual'}>
                Record as done
              </button>
            </div>
          </form>
        </Modal>
      )}
    </Panel>
  );
}

export function ExtensionPanel({ st }: { st: FilingStatusDto }) {
  const gate = useRoleGate([...FILERS], 'record the extension');
  const plan = useWhatIfs().data?.extension;
  const [open, setOpen] = useState(false);
  const [fed, setFed] = useState('');
  const [ca, setCa] = useState('');
  const act = useAction();
  const { nameOf } = useSession();
  const ext = st.extension;
  return (
    <Panel
      title="Extension"
      sub="Form 4868 (federal) and FTB 3519 (California), with the payment sent with each."
      right={
        <button
          className="btn text-xs"
          disabled={!gate.allowed}
          title={gate.why}
          onClick={() => {
            setFed(String(ext?.federal ?? plan?.federal?.paid_with_form_4868 ?? 0));
            setCa(String(ext?.california ?? plan?.california?.paid_with_ftb_3519 ?? 0));
            setOpen(true);
          }}
        >
          {ext ? 'Re-record' : 'Record extension'}
        </button>
      }
    >
      {ext ? (
        <div className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <div className="text-xs text-graphite">Form 4868 paid</div>
            <div className="num font-serif text-xl font-semibold">{fmtNum(ext.federal)}</div>
          </div>
          <div>
            <div className="text-xs text-graphite">FTB 3519 paid</div>
            <div className="num font-serif text-xl font-semibold">{fmtNum(ext.california)}</div>
          </div>
          <div className="text-xs text-graphite">
            Recorded by {nameOf(ext.by)}
            <br />
            {fmtDateTime(ext.at)}
          </div>
        </div>
      ) : (
        <p className="text-sm text-graphite">
          No extension recorded.{' '}
          {plan && (
            <>
              The engine's plan (from {plan.based_on_version ?? 'an earlier version'}) is {fmtNum(plan.federal?.paid_with_form_4868 ?? 0)} with Form 4868 and {fmtNum(plan.california?.paid_with_ftb_3519 ?? 0)} with FTB 3519.
            </>
          )}
        </p>
      )}
      {open && (
        <Modal title="Record extension" onClose={() => setOpen(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const ok = await act.run('ext', () => api<FilingResult>('/api/filing/extension', { method: 'POST', body: { federal: Number(fed), california: Number(ca) } }), 'Extension recorded');
              if (ok) setOpen(false);
            }}
          >
            <Field label="Paid with Form 4868 (federal)">
              <input className="input num" inputMode="decimal" value={fed} onChange={(e) => setFed(e.target.value)} />
            </Field>
            <Field label="Paid with FTB 3519 (California)">
              <input className="input num" inputMode="decimal" value={ca} onChange={(e) => setCa(e.target.value)} />
            </Field>
            <ErrorBox error={act.error} />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary" disabled={act.busy === 'ext'}>
                Record
              </button>
            </div>
          </form>
        </Modal>
      )}
    </Panel>
  );
}

export function ApprovalPanel({ st }: { st: FilingStatusDto }) {
  const { nameOf } = useSession();
  const ap = st.clientApproval;
  return (
    <Panel
      title="Client approval and e-file authorization"
      sub="The client approves in the portal and signs Forms 8879 / FTB 8879 with their PINs. Only a salted hash is kept, tied to the return as approved."
      right={!ap ? <Pill tone="neutral">Not yet approved</Pill> : ap.current ? <Pill tone="ok">Approved, current</Pill> : <Pill tone="bad">Stale: return changed since</Pill>}
    >
      {!ap ? (
        <p className="text-sm text-graphite">Waiting on the client. They see an “Approve and sign” step in the client portal.</p>
      ) : (
        <div className="text-sm">
          <p>
            Approved by <span className="font-semibold">{nameOf(ap.by)}</span> on {fmtDateTime(ap.at)}. Signers:{' '}
            {Object.keys(ap.pins)
              .map((k) => nameOf(k))
              .join(', ')}{' '}
            <span className="text-faint">(PINs {Object.values(ap.pins).join(' ')})</span>.
          </p>
          <p className="mt-1 text-xs text-graphite">
            Return as approved: <Hash value={ap.returnHash} label="Return scope hash" />
          </p>
          {!ap.current && (
            <p className="mt-2 rounded bg-pencil-soft px-2 py-1 text-xs text-pencil-ink">
              A line on the return changed after the client approved it. The approval no longer covers what would be filed; ask the client to review and sign again.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}

/** Group submissions by the submit that created them (one frozen snapshot each). */
function rounds(subs: SubmissionDto[]) {
  const m = new Map<string, SubmissionDto[]>();
  for (const s of subs) m.set(s.snapshotId, [...(m.get(s.snapshotId) ?? []), s]);
  return [...m.entries()].map(([snapshotId, list]) => ({ snapshotId, list, at: list[0]!.submittedAt, by: list[0]!.submittedBy, hash: list[0]!.contentHash }));
}

export function SubmitPanel({ r, st }: { r: ReadinessDto; st: FilingStatusDto }) {
  const gate = useRoleGate([...FILERS], 'submit the return');
  const act = useAction();
  const [confirm, setConfirm] = useState(false);
  const pending = (['federal', 'california'] as const).filter((j) => !st.submissions.some((s) => s.jurisdiction === j && (s.status === 'accepted' || s.status === 'pending')));
  const resubmission = st.submissions.length > 0;
  const disabledWhy = !gate.allowed ? gate.why : !r.ready ? 'Readiness is not clean yet' : !pending.length ? 'Both jurisdictions are submitted or accepted; open an amendment for changes' : undefined;
  const last = rounds(st.submissions).at(-1);
  return (
    <Panel
      id="submit"
      title={resubmission ? 'Resubmit' : 'Submit and freeze'}
      sub="Submitting freezes the effective return and all workpaper state at this event into an immutable snapshot with a SHA-256 content hash, then records one submission per jurisdiction."
      right={
        <button className="btn-primary" disabled={!!disabledWhy || act.busy === 'submit'} title={disabledWhy} onClick={() => setConfirm(true)}>
          <Send size={14} /> {resubmission ? `Resubmit ${pending.join(' and ')}` : 'Submit return'}
        </button>
      }
    >
      {disabledWhy && <p className="mb-2 text-sm text-graphite">{disabledWhy}.</p>}
      {last ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <Lock size={13} /> Frozen snapshot
          </span>
          <code className="font-mono text-xs">{last.snapshotId}</code>
          <span className="text-xs text-graphite">
            content hash <code className="break-all font-mono text-2xs">{last.hash}</code>
          </span>
        </div>
      ) : (
        <p className="text-sm text-faint">Nothing submitted yet.</p>
      )}
      {confirm && (
        <Modal title={resubmission ? 'Resubmit the return' : 'Submit the return'} onClose={() => setConfirm(false)}>
          <p className="mb-2 text-sm">
            This freezes the return as it stands now (event #{r.seq}) and records {pending.length} submission(s): {pending.map(humanize).join(', ')}.
          </p>
          <p className="mb-3 text-xs text-graphite">Later changes don't touch the frozen copy; they go into an amendment against it.</p>
          <ErrorBox error={act.error} />
          <div className="mt-3 flex justify-end gap-2">
            <button className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              data-autofocus
              disabled={act.busy === 'submit'}
              onClick={async () => {
                const res = await act.run(
                  'submit',
                  () => api<FilingResult<{ snapshot: { id: string; contentHash: string } }>>('/api/filing/submit', { method: 'POST' }),
                  (x) => `Submitted. Snapshot ${x.data?.snapshot.id.slice(0, 8)}… frozen`,
                );
                if (res) setConfirm(false);
              }}
            >
              Freeze and submit
            </button>
          </div>
        </Modal>
      )}
    </Panel>
  );
}

const STATUS_TONE: Record<SubmissionDto['status'], 'ok' | 'bad' | 'warn' | 'neutral'> = { accepted: 'ok', rejected: 'bad', not_transmitted: 'warn', pending: 'neutral' };

export function SubmissionsPanel({ st }: { st: FilingStatusDto }) {
  const gate = useRoleGate([...FILERS], 'record e-file results');
  const act = useAction();
  const { nameOf } = useSession();
  const issues = useIssues();
  const drawer = useDrawer();
  const [manual, setManual] = useState<SubmissionDto | null>(null);
  const rs = rounds(st.submissions);
  // Issues our checks tied to agency e-file records (e.g. the dependent TIN mismatch).
  const efileIssues = (issues.data ?? []).filter((i) => i.nodeIds.some((n) => n.startsWith('agency:/efile')));
  const fixesFor = (msg: string) => efileIssues.filter((i) => msg.includes(i.title.split(':')[0]!.trim()));

  return (
    <Panel
      title="E-file submissions"
      sub="Each submit is one round. Agency results can be replayed from the packet's e-file records, or recorded by hand."
      right={st.filed ? <Pill tone="ok">Filed: accepted in both</Pill> : undefined}
    >
      {rs.length === 0 ? (
        <p className="text-sm text-faint">No submissions yet.</p>
      ) : (
        <ol className="space-y-3">
          {rs.map((round, n) => (
            <li key={round.snapshotId} className="rounded border border-ruleSoft">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-ruleSoft bg-paper px-3 py-1.5 text-xs text-graphite">
                <span className="font-semibold text-ink">{n === 0 ? 'Original submission' : `Resubmission ${n}`}</span>
                <span>
                  by {nameOf(round.by)}, {fmtDateTime(round.at)}
                </span>
                <span>
                  snapshot <code className="font-mono">{round.snapshotId.slice(0, 8)}…</code> <Hash value={round.hash} />
                </span>
              </div>
              <ul className="divide-y divide-ruleSoft">
                {round.list.map((s) => (
                  <li key={s.id} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="w-[90px] font-semibold">{humanize(s.jurisdiction)}</span>
                      <Pill tone={STATUS_TONE[s.status]}>{humanize(s.status)}</Pill>
                      <span className="font-mono text-2xs text-faint">{s.id}</span>
                      {s.agencySubmissionId && <span className="font-mono text-2xs text-graphite">agency #{s.agencySubmissionId}</span>}
                      {s.resultAt && <span className="text-2xs text-faint">result {fmtDateTime(s.resultAt)}</span>}
                      <span className="flex-1" />
                      {s.status === 'pending' && (
                        <>
                          <button
                            className="btn text-xs"
                            disabled={!gate.allowed || act.busy === s.id}
                            title={gate.why ?? "Replay the agency's scripted response from the packet (tax_agency_records.efile)"}
                            onClick={() =>
                              act.run(s.id, () => api<FilingResult<{ status: string }>>(`/api/filing/submissions/${s.id}/result`, { method: 'POST', body: { replay: true } }), (x) => `${humanize(s.jurisdiction)}: ${humanize(String(x.data?.status ?? 'recorded'))}`)
                            }
                          >
                            <RotateCcw size={12} /> Replay agency result
                          </button>
                          <button className="btn-ghost text-xs" disabled={!gate.allowed} title={gate.why} onClick={() => setManual(s)}>
                            Record by hand
                          </button>
                        </>
                      )}
                    </div>
                    {s.errors && s.errors.length > 0 && (
                      <ul className="mt-1.5 space-y-1.5">
                        {s.errors.map((err) => {
                          const fixes = fixesFor(err.message);
                          return (
                            <li key={err.code} className="rounded border-l-4 border-l-pencil bg-pencil-soft/50 px-2.5 py-1.5 text-sm">
                              <span className="font-mono text-xs font-semibold text-pencil-ink">{err.code}</span> {err.message}
                              {fixes.map((f) => (
                                <div key={f.id} className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                                  <span className="text-graphite">Fix:</span>
                                  <button className="text-left text-blue-ink underline decoration-dotted underline-offset-2" onClick={() => drawer.open(f.nodeIds[0]!)}>
                                    {f.title}
                                  </button>
                                  <Pill tone={f.status === 'open' ? 'bad' : 'ok'}>{f.status === 'open' ? 'issue open' : `issue ${f.status}`}</Pill>
                                  {f.nodeIds.find((x) => x.startsWith('household:')) && (
                                    <button className="btn-ghost text-xs" onClick={() => drawer.open(f.nodeIds.find((x) => x.startsWith('household:'))!, { act: 'record' })}>
                                      Correct the record (with the client's confirmation)
                                    </button>
                                  )}
                                </div>
                              ))}
                              {fixes.length === 0 && err.code !== 'STATE-HOLD' && s.status === 'rejected' && <RejectionFix s={s} />}
                              {err.code === 'STATE-HOLD' && <div className="mt-1 text-xs text-graphite">Clears when the federal return is accepted; resubmit both together.</div>}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {st.submissions.some((s) => s.status === 'rejected' || s.status === 'not_transmitted') && !st.filed && (
        <p className="mt-2 text-xs text-graphite">
          After fixing what the agency rejected, resubmit from <button className="text-blue-ink underline" onClick={() => document.getElementById('submit')?.scrollIntoView({ behavior: 'smooth' })}>Resubmit</button> above. Rejected jurisdictions go again; accepted ones are not resent.
        </p>
      )}
      <ErrorBox error={act.error} />
      {manual && <ManualResult s={manual} onClose={() => setManual(null)} />}
    </Panel>
  );
}

/**
 * D-62: a rejection the system can't map to a cause clears only when a preparer records what
 * fixed it (citing the change) and a different reviewer or partner confirms it.
 */
function RejectionFix({ s }: { s: SubmissionDto }) {
  const readiness = useReadiness();
  const events = useEvents();
  const { nameOf } = useSession();
  const act = useAction();
  const fixer = useRoleGate(['preparer', 'reviewer', 'partner'], 'record a fix');
  const confirmer = useRoleGate([...FILERS], 'confirm a fix');
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [ref, setRef] = useState('');
  const mine = (readiness.data?.blockers ?? []).filter((b) => b.code.startsWith('EFILE_REJECTION_FIX') && b.text.includes(`${s.jurisdiction} `));
  const missing = mine.some((b) => b.code === 'EFILE_REJECTION_FIX_MISSING');
  const unconfirmed = mine.some((b) => b.code === 'EFILE_REJECTION_FIX_UNCONFIRMED');
  // Recent value changes to cite: adjustments and corrections, newest first.
  const recent = (events.data ?? [])
    .filter((e) => /^(adjustment\.proposed|read\.corrected|household\.corrected)$/.test(e.type))
    .slice(-8)
    .reverse()
    .map((e) => {
      const p = e.payload as { nodeId?: string; evId?: string; personId?: string };
      const node = p.nodeId ?? (p.evId ? `ev:${p.evId}` : p.personId ? `household:${p.personId}` : '');
      return { node, text: `${humanize(e.type)} · ${node} · ${nameOf(e.actor)}${e.reason ? ` · "${e.reason}"` : ''}` };
    })
    .filter((x) => x.node);
  const chosen = ref || recent[0]?.node || '';
  if (!missing && !unconfirmed) return <div className="mt-1 text-xs font-semibold text-ledger-ink">Fix recorded and confirmed; ready to resubmit.</div>;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
      {missing ? (
        <>
          <span className="text-graphite">No workpaper issue explains this error. Record what fixed it before resubmitting.</span>
          <button className="btn text-xs" disabled={!fixer.allowed} title={fixer.why} onClick={() => setOpen(true)}>
            Record the fix
          </button>
        </>
      ) : (
        <>
          <span className="text-graphite">A fix is recorded; a reviewer or partner other than its author must confirm it.</span>
          <button
            className="btn text-xs"
            disabled={!confirmer.allowed || act.busy === 'confirm'}
            title={confirmer.why}
            onClick={() => act.run('confirm', () => api<FilingResult>(`/api/filing/submissions/${s.id}/fix/confirm`, { method: 'POST' }), () => 'Fix confirmed')}
          >
            Confirm fix
          </button>
        </>
      )}
      <ErrorBox error={act.error} />
      {open && (
        <Modal title={`Record the fix for ${humanize(s.jurisdiction)}`} onClose={() => setOpen(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const done = await act.run('fix', () => api<FilingResult>(`/api/filing/submissions/${s.id}/fix`, { method: 'POST', body: { note, refs: chosen ? [chosen] : [] } }), () => 'Fix recorded; awaiting confirmation');
              if (done) setOpen(false);
            }}
          >
            <Field label="What fixed it" hint="Required. Kept with the submission's history.">
              <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Field label="The change that fixed it" hint="Pick a recent adjustment or correction, or type a line / item id (e.g. line:v3:F1040.11).">
              <select className="input mb-1" value={recent.some((r) => r.node === chosen) ? chosen : ''} onChange={(e) => setRef(e.target.value)}>
                {recent.map((r, i) => (
                  <option key={i} value={r.node}>
                    {r.text}
                  </option>
                ))}
                <option value="">Other (type below)</option>
              </select>
              <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} placeholder={chosen || 'line:v3:…'} />
            </Field>
            <ErrorBox error={act.error} />
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary" disabled={!note.trim() || !chosen || act.busy === 'fix'}>
                Record fix
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function ManualResult({ s, onClose }: { s: SubmissionDto; onClose: () => void }) {
  const act = useAction();
  const [status, setStatus] = useState<'accepted' | 'rejected' | 'not_transmitted'>('accepted');
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState('');
  const [agencyId, setAgencyId] = useState('');
  return (
    <Modal title={`Record result: ${s.id}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const body = { status, agencySubmissionId: agencyId || undefined, errors: status === 'accepted' || !code ? [] : [{ code, message: msg }] };
          const ok = await act.run('manual', () => api<FilingResult>(`/api/filing/submissions/${s.id}/result`, { method: 'POST', body }), `Result recorded: ${humanize(status)}`);
          if (ok) onClose();
        }}
      >
        <Field label="Status">
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="not_transmitted">Not transmitted</option>
          </select>
        </Field>
        <Field label="Agency submission id (optional)">
          <input className="input font-mono" value={agencyId} onChange={(e) => setAgencyId(e.target.value)} />
        </Field>
        {status !== 'accepted' && (
          <>
            <Field label="Error code">
              <input className="input font-mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="R0000-504-02" />
            </Field>
            <Field label="Message">
              <input className="input" value={msg} onChange={(e) => setMsg(e.target.value)} />
            </Field>
          </>
        )}
        <ErrorBox error={act.error} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            <X size={13} /> Cancel
          </button>
          <button className="btn-primary" disabled={act.busy === 'manual'}>
            Record
          </button>
        </div>
      </form>
    </Modal>
  );
}
