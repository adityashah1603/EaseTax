// What a client sees: where the return stands, the firm's questions, uploads, approval.
// No workpaper internals: the API scopes questions to the client and masks sensitive data.
import type { CommandResult } from '@easetax/shared';
import { CheckCircle2, PenLine, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, upload } from '../api/client';
import { useInvalidateAll, useQuestions, useSummary } from '../api/hooks';
import { useFilingStatus, type FilingResult } from '../api/workflowHooks';
import { QuestionCard } from '../components/trace/sections';
import { ErrorBox, Loading } from '../components/ui';
import { fmtDate, fmtDateTime, fmtNum, humanize } from '../lib/format';
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

      <ApproveAndSign />
    </div>
  );
}

/**
 * Form 8879 / FTB 8879: the client approves the return and signs with a 5-digit PIN per signer.
 * The PINs go to the server once and are never shown again or kept here: the server stores a
 * salted hash tied to the return as approved, and the approval goes stale if the return changes.
 */
function ApproveAndSign() {
  const { actors, actor, nameOf } = useSession();
  const status = useFilingStatus();
  const invalidate = useInvalidateAll();
  const toast = useToast();
  const signers = actors.filter((a) => a.kind === 'client');
  const [pins, setPins] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [signing, setSigning] = useState(false);
  const st = status.data;
  const ap = st?.clientApproval;
  const valid = signers.length > 0 && signers.every((s) => /^\d{5}$/.test(pins[s.id] ?? '')) && consent;
  const accepted = st?.submissions.filter((s) => s.status === 'accepted') ?? [];
  // D-48: the client signs a reviewed return, so approval opens only after the partner's sign-off.
  const open = st?.approvalOpen?.open ?? false;

  const sign = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api<FilingResult>('/api/filing/client-approval', { method: 'POST', body: { pins, consent: true } });
      toast.push({ tone: 'ok', text: 'Thank you. Your approval and e-file signature are recorded.' });
      setSigning(false);
      invalidate();
    } catch (x) {
      setErr(x);
    } finally {
      // Never keep the PINs around, whatever happened.
      setPins({});
      setConsent(false);
      setBusy(false);
    }
  };

  return (
    <section className="rounded border border-rule bg-panel p-4">
      <h2 className="mb-1 text-sm font-semibold text-graphite">Approve and sign (Form 8879 and FTB 8879)</h2>
      {status.isLoading ? (
        <Loading />
      ) : (
        <>
          {st?.filed ? (
            <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ledger-ink">
              <CheckCircle2 size={16} /> Your return has been filed and accepted by the IRS and the Franchise Tax Board.
            </p>
          ) : accepted.length > 0 ? (
            <p className="mb-2 text-sm text-graphite">Accepted so far: {accepted.map((s) => humanize(s.jurisdiction)).join(', ')}.</p>
          ) : null}
          {ap ? (
            ap.current ? (
              <div className="mb-2 rounded border border-ledger/40 bg-ledger-soft px-3 py-2 text-sm text-ledger-ink">
                Approved and signed by {nameOf(ap.by)} on {fmtDateTime(ap.at)}. Signers: {Object.keys(ap.pins).map(nameOf).join(' and ')}.
                <span className="block text-xs">Your preparer may now file the return exactly as you approved it.</span>
              </div>
            ) : (
              <div className="mb-2 rounded border border-amber bg-amber-soft px-3 py-2 text-sm text-amber-ink">
                <span className="font-semibold">Your approval needs renewing.</span> You approved on {fmtDateTime(ap.at)}, but the return changed afterwards, so that approval no longer
                covers it. {open ? 'Please review the figures above and sign again.' : "We'll let you know when it's ready to sign again."}
              </div>
            )
          ) : open ? (
            <p className="mb-2 text-sm text-graphite">When you're happy with the figures above, approve the return and sign the e-file authorization with your PINs.</p>
          ) : (
            <p className="mb-2 text-sm text-graphite">{st?.approvalOpen?.reason ?? "Your return isn't ready for your approval yet."}</p>
          )}
          {!st?.filed && !signing && (
            <button
              className="btn-primary"
              onClick={() => (setErr(null), setSigning(true))}
              disabled={actor?.kind !== 'client' || !open}
              title={open ? undefined : st?.approvalOpen?.reason}
            >
              <PenLine size={14} /> {ap ? (ap.current ? 'Sign again' : 'Review and sign again') : 'Approve and sign'}
            </button>
          )}
          {signing && (
            <form
              className="mt-2 rounded border border-rule bg-paper p-3"
              autoComplete="off"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) sign();
              }}
            >
              <p className="mb-2 text-xs text-graphite">
                Each signer chooses a five-digit PIN. It is your electronic signature on Form 8879 and FTB 8879. We don't keep the PIN itself.
              </p>
              <div className="mb-2 grid gap-3 sm:grid-cols-2">
                {signers.map((s) => (
                  <label key={s.id} className="block">
                    <span className="mb-1 block text-xs font-semibold text-graphite">{s.name}'s PIN</span>
                    <input
                      className="input num tracking-[0.3em]"
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      maxLength={5}
                      value={pins[s.id] ?? ''}
                      onChange={(e) => setPins((p) => ({ ...p, [s.id]: e.target.value.replace(/\D/g, '').slice(0, 5) }))}
                      aria-label={`${s.name} e-file PIN`}
                    />
                  </label>
                ))}
              </div>
              <label className="mb-2 flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>
                  Under penalties of perjury, we declare that we have examined this return and to the best of our knowledge it is true, correct and complete. We authorize Miraflores
                  to file it electronically.
                </span>
              </label>
              <ErrorBox error={err} />
              <div className="mt-2 flex gap-2">
                <button className="btn-primary" disabled={!valid || busy}>
                  {busy ? 'Signing…' : 'Approve and sign'}
                </button>
                <button type="button" className="btn" onClick={() => (setSigning(false), setPins({}), setConsent(false))}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {err && !signing ? <ErrorBox error={err} /> : null}
        </>
      )}
    </section>
  );
}
