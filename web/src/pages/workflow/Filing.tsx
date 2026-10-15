// Filing and after (FR-6): one page that walks the return from "ready?" through submission,
// rejection and resubmission, to the filed copy, amendments, notices and next year.
import clsx from 'clsx';
import { useFilingStatus, useReadiness } from '../../api/workflowHooks';
import { AmendmentsPanel, ClientCopyPanel, NoticePanel, RollForwardPanel } from '../../components/workflow/AfterFiling';
import { ApprovalPanel, ExtensionPanel, ReadinessPanel, SubmissionsPanel, SubmitPanel } from '../../components/workflow/FilingCore';
import { ErrorBox, Loading } from '../../components/ui';
import { useSession } from '../../state/session';

const STAGES = [
  { id: 'readiness', text: 'Ready?' },
  { id: 'submit', text: 'Submit' },
  { id: 'efile', text: 'E-file' },
  { id: 'after', text: 'After filing' },
];

export function Filing() {
  const readiness = useReadiness();
  const status = useFilingStatus();
  const { actor } = useSession();
  const r = readiness.data;
  const st = status.data;
  const stage = !st || !r ? 0 : st.filed ? 3 : st.submissions.length ? 2 : r.ready ? 1 : 0;
  const filer = actor?.role === 'reviewer' || actor?.role === 'partner';

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold">Filing</h1>
          <p className="max-w-[72ch] text-sm text-graphite">
            Submitting freezes the return. Everything after (rejections, the client's copy, amendments, a notice in 2028) reads from that frozen snapshot, never the live workpaper.
            {!filer && ' Submitting, extensions, amendments and e-file results are for reviewers and partners; any preparer can assemble a notice case or roll forward.'}
          </p>
        </div>
        <ol className="flex items-center gap-1 text-xs" aria-label="Filing progress">
          {STAGES.map((s, i) => (
            <li key={s.id} className="flex items-center gap-1">
              <button onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })} className={clsx('rounded-full px-2.5 py-0.5', i < stage ? 'bg-ledger-soft text-ledger-ink' : i === stage ? 'bg-ink font-semibold text-white' : 'border border-rule text-faint')}>
                {s.text}
              </button>
              {i < STAGES.length - 1 && <span className="text-faint">›</span>}
            </li>
          ))}
        </ol>
      </div>

      <ErrorBox error={readiness.error ?? status.error} />
      {!r || !st ? (
        <Loading what="filing status" />
      ) : (
        <>
          <ReadinessPanel r={r} />
          <div className="grid gap-x-5 lg:grid-cols-2">
            <ExtensionPanel st={st} />
            <ApprovalPanel st={st} />
          </div>
          <SubmitPanel r={r} st={st} />
          <div id="efile" className="scroll-mt-4">
            <SubmissionsPanel st={st} />
          </div>
          <div id="after" className="scroll-mt-4">
            <ClientCopyPanel st={st} />
            <AmendmentsPanel st={st} />
            <NoticePanel st={st} />
            <RollForwardPanel st={st} />
          </div>
        </>
      )}
    </div>
  );
}
