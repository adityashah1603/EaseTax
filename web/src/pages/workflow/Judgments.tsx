// Judgments (brief: "record judgment calls, elections, due diligence and penalty decisions"):
// the calls the engine and our checks say still need a recorded decision, then every
// decision on record grouped by kind. Linked items open the trace drawer.
import type { JudgmentKind } from '@easetax/shared';
import clsx from 'clsx';
import { Gavel } from 'lucide-react';
import { useState } from 'react';
import { useStandards } from '../../api/hooks';
import { JUDGMENT_KINDS, KIND_LABEL, KIND_PLURAL, useJudgmentCalls, useJudgments, type PendingCall } from '../../api/judgmentHooks';
import { useReadiness } from '../../api/workflowHooks';
import { JudgmentCard, JudgmentDialog, LinkedItem, type JudgmentDraft } from '../../components/workflow/JudgmentDialog';
import { Empty, ErrorBox, Loading, SourceChip, Tick } from '../../components/ui';
import { fmtDateTime } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { useSession } from '../../state/session';

const signed = (n: number | undefined) => (!n ? '0' : `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString('en-US')}`);

function OptionsTable({ call }: { call: PendingCall }) {
  if (!call.options.length) return null;
  return (
    <table className="mt-1.5 w-full text-xs">
      <thead>
        <tr className="text-left text-graphite">
          <th className="py-0.5 pr-2 font-semibold">Engine alternative</th>
          <th className="py-0.5 pr-2 text-right font-semibold">Federal tax</th>
          <th className="py-0.5 pr-2 text-right font-semibold">CA tax</th>
          <th className="py-0.5 text-right font-semibold">Penalty</th>
        </tr>
      </thead>
      <tbody>
        {call.options.map((o) => (
          <tr key={o.id} className="border-t border-ruleSoft align-top">
            <td className="py-0.5 pr-2">
              {o.description} <span className="text-faint">({o.id})</span>
            </td>
            <td className="num py-0.5 pr-2 text-right">{signed(o.federal?.total_tax_change)}</td>
            <td className="num py-0.5 pr-2 text-right">{signed(o.california?.total_tax_change)}</td>
            <td className="num py-0.5 text-right">{signed(o.federal?.penalty_change)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Judgments() {
  const judgments = useJudgments();
  const { calls, isLoading, error } = useJudgmentCalls();
  const readiness = useReadiness();
  const standards = useStandards();
  const { can, nameOf } = useSession();
  const drawer = useDrawer();
  const [draft, setDraft] = useState<JudgmentDraft | null>(null);
  const waiting = calls.filter((c) => !c.decided.length);
  const decided = calls.filter((c) => c.decided.length);
  const ddStep = readiness.data?.steps.find((s) => /due diligence/i.test(s.step));
  const ddRule = standards.data?.rules.find((r) => /due diligence/i.test(r));

  const draftFor = (c: PendingCall): JudgmentDraft => ({
    kind: c.kind,
    topic: c.topic,
    alternatives: c.alternatives,
    nodeIds: c.nodeIds,
    issues: c.sources.filter((s) => s.issue && s.issue.status === 'open').map((s) => ({ id: s.issue!.id, title: s.issue!.title })),
    authorityHint: c.authorityHint,
    context: (
      <div className="rounded border border-rule bg-paper px-3 py-2 text-xs text-graphite">
        <div>{c.why}</div>
        {c.kind === 'due_diligence' && ddRule && <div className="mt-0.5">Firm rule: {ddRule}</div>}
        <OptionsTable call={c} />
      </div>
    ),
  });

  const callCard = (c: PendingCall) => (
    <li key={c.key} className={clsx('rounded border px-3 py-2', c.decided.length ? 'border-ruleSoft bg-paper' : 'border-rule bg-panel')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-2xs font-semibold uppercase tracking-wide text-faint">{KIND_LABEL[c.kind]}</span>
            {c.sources.map((s, i) =>
              s.issue ? (
                <button key={i} className="inline-flex items-center gap-1 text-2xs text-graphite hover:underline" onClick={() => drawer.open(s.issue!.nodeIds[0] ?? '')} title={s.issue.title}>
                  <SourceChip source={s.issue.source} /> {s.issue.code}
                </button>
              ) : (
                <span key={i} className="rounded border border-rule px-1.5 text-2xs text-graphite">
                  {s.label}
                </span>
              ),
            )}
          </div>
          <div className="mt-0.5 text-sm font-semibold">{c.topic}</div>
          <div className="text-xs text-graphite">{c.why}</div>
          {c.sources
            .filter((s) => s.issue?.detail)
            .map((s, i) => (
              <div key={i} className="mt-0.5 text-xs text-graphite">
                {s.issue!.detail}
              </div>
            ))}
          <OptionsTable call={c} />
          <div className="mt-1.5 flex flex-wrap gap-1">
            {c.nodeIds.map((id) => (
              <LinkedItem key={id} nodeId={id} />
            ))}
          </div>
          {c.decided.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1.5 text-xs text-ledger-ink">
              <Tick size={12} /> Decided: {c.decided.map((j) => `${j.decision.length > 90 ? `${j.decision.slice(0, 90)}…` : j.decision} (${nameOf(j.by)}, ${fmtDateTime(j.at)})`).join('; ')}
            </div>
          )}
        </div>
        {can('verify') && (
          <button className={c.decided.length ? 'btn-ghost text-xs' : 'btn-primary'} onClick={() => setDraft(draftFor(c))}>
            {c.decided.length ? 'Record another' : 'Record decision'}
          </button>
        )}
      </div>
    </li>
  );

  const byKind = (k: JudgmentKind) => (judgments.data ?? []).filter((j) => j.kind === k).sort((a, b) => b.at.localeCompare(a.at));

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-2xl font-semibold">Judgments</h1>
        {can('verify') && (
          <button className="btn" onClick={() => setDraft({ kind: 'judgment' })}>
            <Gavel size={14} /> Record judgment
          </button>
        )}
      </div>
      <p className="mb-4 max-w-[75ch] text-sm text-graphite">
        Judgment calls, elections, due diligence and penalty decisions, each with the alternatives considered and the authority relied on. Every judgment call records the
        authority relied on; the server refuses one without it.
      </p>

      <section className="mb-6">
        <h2 className="section-title mb-2">
          Calls waiting for a decision {!isLoading && <span className="ml-1 font-normal text-faint">{waiting.length}</span>}
        </h2>
        {error ? (
          <ErrorBox error={error} />
        ) : isLoading ? (
          <Loading />
        ) : waiting.length === 0 ? (
          <Empty>Every call the engine and our checks raised has a recorded decision.</Empty>
        ) : (
          <ul className="space-y-2">{waiting.map(callCard)}</ul>
        )}
        {decided.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-graphite">{decided.length} raised call(s) already decided</summary>
            <ul className="mt-2 space-y-2">{decided.map(callCard)}</ul>
          </details>
        )}
      </section>

      {judgments.error ? (
        <ErrorBox error={judgments.error} />
      ) : !judgments.data ? (
        <Loading what="judgments" />
      ) : (
        JUDGMENT_KINDS.map((k) => {
          const list = byKind(k);
          return (
            <section key={k} className="mb-5">
              <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="section-title">
                  {KIND_PLURAL[k]} <span className="ml-1 font-normal text-faint">{list.length}</span>
                </h2>
                {k === 'due_diligence' && ddStep && (
                  <span className={clsx('text-xs', ddStep.ok ? 'text-ledger-ink' : 'text-amber-ink')}>
                    Filing readiness, “{ddStep.step}”: {ddStep.ok ? 'done' : ddStep.reason ?? 'not yet'}
                  </span>
                )}
              </div>
              {list.length === 0 ? <div className="rounded border border-dashed border-rule px-3 py-2 text-sm text-faint">None recorded.</div> : list.map((j) => <JudgmentCard key={j.id} j={j} />)}
            </section>
          );
        })
      )}

      {draft && <JudgmentDialog draft={draft} currentNodeId={drawer.nodeId} onClose={() => setDraft(null)} />}
    </div>
  );
}
