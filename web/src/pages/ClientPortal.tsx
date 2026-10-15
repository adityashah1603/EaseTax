// What a client sees: where the return stands, the firm's questions, uploads, approval.
// No workpaper internals: the API scopes questions to the client and masks sensitive data.
import type { CommandResult } from '@easetax/shared';
import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { upload } from '../api/client';
import { useQuestions, useSummary } from '../api/hooks';
import { QuestionCard } from '../components/trace/sections';
import { ErrorBox, Loading } from '../components/ui';
import { fmtDate, fmtNum } from '../lib/format';
import { useSession } from '../state/session';
import { useToast } from '../state/toast';

export function ClientPortal() {
  const { actor } = useSession();
  const summary = useSummary();
  const questions = useQuestions();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<unknown>(null);
  const [uploads, setUploads] = useState<string[]>([]);
  const s = summary.data;
  const cur = s?.versions.find((v) => v.version === s.currentVersion);
  const open = (questions.data ?? []).filter((q) => q.status === 'open');
  const done = (questions.data ?? []).filter((q) => q.status !== 'open');
  const owed = (n: number) => (n >= 0 ? `${fmtNum(n)} owed` : `${fmtNum(-n)} refund`);

  return (
    <div className="mx-auto max-w-[860px] px-6 py-6">
      <h1 className="font-serif text-2xl font-semibold">Hello, {actor?.name.split(' ')[0]}</h1>
      <p className="mb-5 text-sm text-graphite">Your {s?.taxYear ?? ''} return with Miraflores. Answer open questions and send any missing documents here.</p>

      <section className="mb-6 rounded border border-rule bg-panel p-4">
        <h2 className="mb-2 text-sm font-semibold text-graphite">Where your return stands</h2>
        {!cur ? (
          <Loading />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <div className="text-xs text-graphite">Federal (draft, {fmtDate(cur.computedAt)})</div>
              <div className="num font-serif text-2xl font-semibold">{owed(cur.federal.balance_due)}</div>
              <div className="num text-xs text-graphite">
                Total tax {fmtNum(cur.federal.total_tax)} · payments {fmtNum(cur.federal.payments)}
              </div>
            </div>
            <div>
              <div className="text-xs text-graphite">California (part-year)</div>
              <div className="num font-serif text-2xl font-semibold">{owed(cur.california.balance_due)}</div>
              <div className="num text-xs text-graphite">
                Total tax {fmtNum(cur.california.total_tax)} · payments {fmtNum(cur.california.payments)}
              </div>
            </div>
          </div>
        )}
        <p className="mt-3 text-xs text-graphite">These are draft figures and will change as your preparer finishes the review.</p>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-semibold text-graphite">Questions for you {open.length > 0 && <span className="text-pencil">({open.length} open)</span>}</h2>
        {questions.isLoading ? <Loading /> : open.length === 0 ? <p className="text-sm text-faint">No open questions. We'll let you know here if we need anything.</p> : open.map((q) => <QuestionCard key={q.id} q={q} />)}
        {done.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-graphite">Answered ({done.length})</summary>
            <div className="mt-2">{done.map((q) => <QuestionCard key={q.id} q={q} />)}</div>
          </details>
        )}
      </section>

      <section className="mb-6 rounded border border-rule bg-panel p-4">
        <h2 className="mb-1 text-sm font-semibold text-graphite">Send a document</h2>
        <p className="mb-2 text-xs text-graphite">PDFs or photos. Each file is stored with a fingerprint so it can't be changed later.</p>
        <input
          ref={file}
          type="file"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setErr(null);
            try {
              await upload<CommandResult>('/api/attachments', f);
              setUploads((u) => [f.name, ...u]);
              toast.push({ tone: 'ok', text: `Sent ${f.name} to your preparer` });
            } catch (x) {
              setErr(x);
            }
            e.target.value = '';
          }}
        />
        <button className="btn" onClick={() => file.current?.click()}>
          <Upload size={14} /> Choose a file
        </button>
        {uploads.length > 0 && (
          <ul className="mt-2 text-sm text-graphite">
            {uploads.map((u, i) => (
              <li key={i}>Sent: {u}</li>
            ))}
          </ul>
        )}
        <div className="mt-2">
          <ErrorBox error={err} />
        </div>
      </section>

      <section className="rounded border border-rule bg-panel p-4">
        <h2 className="mb-1 text-sm font-semibold text-graphite">Approve and sign (Form 8879)</h2>
        <p className="mb-2 text-sm text-graphite">You'll be able to review the final return and sign here once your preparer and partner have signed off.</p>
        <button className="btn" disabled>
          Approve return
        </button>
      </section>
    </div>
  );
}
