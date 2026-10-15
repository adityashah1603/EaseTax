// Work actions on a node: verify, adjust, note, ask, attach evidence. Each is one REST
// command; the server's policy text is shown verbatim when it refuses.
import type { CommandResult, NodeSummary } from '@easetax/shared';
import { useState } from 'react';
import { api, enc, upload } from '../api/client';
import { undoTargetsFor, useInvalidateAll, useIssues, useQuestions, useSearch, useStandards } from '../api/hooks';
import { humanize, fmtValue } from '../lib/format';
import { takePrefill } from '../state/drawer';
import { useSession } from '../state/session';
import { useToast } from '../state/toast';
import { ErrorBox, Field, Modal } from './ui';

/** Run a command, refresh, and offer Undo for the events it wrote (its batchId, else its event ids). */
export function useCommand() {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const { can } = useSession();
  return async function run(fn: () => Promise<CommandResult>, opts: { done: string; undoable?: boolean }) {
    const res = await fn();
    invalidate();
    let undo: (() => Promise<unknown>) | undefined;
    const targets = undoTargetsFor(res);
    if (opts.undoable !== false && can('undo') && targets.length)
      undo = async () => {
        for (const target of targets) await api('/api/undo', { method: 'POST', body: target });
        invalidate();
      };
    toast.push({ tone: 'ok', text: opts.done, undo });
    return res;
  };
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const go = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, go };
}

export function VerifyDialog({ nodeIds, onClose, label, revisions }: { nodeIds: string[]; onClose: () => void; label: string; revisions?: Record<string, number | undefined> }) {
  const [openedRevs] = useState(revisions);
  const standards = useStandards();
  const types = standards.data?.verification_types ?? [];
  const [type, setType] = useState('');
  const [note, setNote] = useState('');
  const run = useCommand();
  const s = useSubmit();
  const chosen = type || types[0] || '';
  return (
    <Modal title={nodeIds.length > 1 ? `Verify ${nodeIds.length} items` : 'Verify'} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await s.go(() =>
            run(() => api<CommandResult>('/api/verifications', { method: 'POST', body: { nodeIds, type: chosen, note: note || undefined, expected: openedRevs } }), {
              done: nodeIds.length > 1 ? `Verified ${nodeIds.length} items as ${humanize(chosen).toLowerCase()}` : `Verified ${label}`,
            }),
          );
          if (ok) onClose();
        }}
      >
        <p className="mb-3 text-sm text-graphite">{label}</p>
        <Field label="How you verified it" hint="Types come from the firm's standards.">
          <div className="grid gap-1">
            {types.map((t, i) => (
              <label key={t} className="flex items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-ruleSoft">
                <input type="radio" name="vtype" checked={chosen === t} onChange={() => setType(t)} autoFocus={i === 0} />
                {humanize(t)}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Note (optional)">
          <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Agreed to W-2 box 1 on D09" />
        </Field>
        <ErrorBox error={s.error} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={s.busy || !chosen}>
            Verify
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AdjustDialog({ node, onClose }: { node: NodeSummary; onClose: () => void }) {
  // D-57: the revision you were looking at when you opened this. Live updates refresh `node`,
  // but a write must be judged against what you saw, so keep the opening value.
  const [openedRev] = useState(node.revision);
  const [pre] = useState(() => takePrefill());
  const current = node.effectiveValue ?? node.value;
  const [value, setValue] = useState(pre?.value ?? (current === undefined ? '' : String(current)));
  const [reason, setReason] = useState(pre?.reason ?? '');
  const [authority, setAuthority] = useState('');
  const run = useCommand();
  const s = useSubmit();
  const parsed = parseInput(value, current);
  return (
    <Modal title="Adjust" onClose={onClose} width={500}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await s.go(() =>
            run(() => api<CommandResult>('/api/adjustments', { method: 'POST', body: { nodeId: node.id, newValue: parsed, reason, authority: authority || undefined, revision: openedRev } }), {
              done: `Adjustment recorded on ${node.sublabel ?? node.label}. The engine value is kept as the original.`,
            }),
          );
          if (ok) onClose();
        }}
      >
        <div className="mb-3 rounded border border-rule bg-paper px-3 py-2 text-sm">
          <div className="text-graphite">{node.label}</div>
          <div className="num mt-0.5">
            Engine value <span className="font-semibold">{fmtValue(node.value)}</span>
            {node.adjusted && (
              <>
                {' '}
                · in force now <span className="font-semibold text-blue-ink">{fmtValue(node.effectiveValue)}</span>
              </>
            )}
          </div>
        </div>
        <Field label="New value">
          <input className="input num" value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" />
        </Field>
        <Field label="Why" hint="Required. Shown to the reviewer and partner, and kept in the history.">
          <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Field label="Authority (optional)" hint="Code section, regulation, or firm policy relied on.">
          <input className="input" value={authority} onChange={(e) => setAuthority(e.target.value)} placeholder="e.g. Treas. Reg. §1.263(a)-3" />
        </Field>
        <p className="mb-3 text-xs text-graphite">
          The server estimates the tax effect (≈) from the current version's rates. Over 1,000 federal or state, the adjustment waits for a partner before it takes effect.
        </p>
        <ErrorBox error={s.error} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={s.busy || !reason.trim()}>
            Record adjustment
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Correct the read (D-38): record what the page actually prints for one extracted value.
 * The pipeline's read is kept as the original; the corrected value is what the return rests on.
 */
export function CorrectReadDialog({ node, onClose }: { node: NodeSummary; onClose: () => void }) {
  // D-57: the revision you were looking at when you opened this. Live updates refresh `node`,
  // but a write must be judged against what you saw, so keep the opening value.
  const [openedRev] = useState(node.revision);
  const [pre] = useState(() => takePrefill());
  const [value, setValue] = useState(pre?.value ?? '');
  const [reason, setReason] = useState(pre?.reason ?? '');
  const run = useCommand();
  const s = useSubmit();
  return (
    <Modal title="Correct the read" onClose={onClose} width={500}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await s.go(() =>
            run(() => api<CommandResult>('/api/reads/corrections', { method: 'POST', body: { evId: node.id, value, reason, revision: openedRev } }), {
              done: `Read corrected on ${node.sublabel ?? node.label}. The pipeline's read is kept as the original.`,
            }),
          );
          if (ok) onClose();
        }}
      >
        <div className="mb-3 rounded border border-rule bg-paper px-3 py-2 text-sm">
          <div className="text-graphite">{node.label}</div>
          <div className="text-xs text-faint">{node.sublabel}</div>
          <div className="num mt-0.5">
            Pipeline read <span className="font-semibold">{fmtValue(node.value)}</span>
            {typeof node.confidence === 'number' && <span className="text-faint"> · confidence {Math.round(node.confidence * 100)}%</span>}
            {node.adjusted && (
              <>
                {' '}
                · corrected now to <span className="font-semibold text-blue-ink">{fmtValue(node.effectiveValue)}</span>
              </>
            )}
          </div>
        </div>
        <Field label="What the page prints" hint="Type it as printed. Amounts as numbers, dates as YYYY-MM-DD, EINs as NN-NNNNNNN.">
          <input className="input num" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </Field>
        <Field label="Why" hint="Required. Kept in the history with your name.">
          <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. D62 page 1 prints 74-3829156; the read swapped two digits" />
        </Field>
        <p className="mb-3 text-xs text-graphite">
          Every line that uses this value shows the corrected one, and the read check compares it with the page again. Sign-offs over those lines reopen. Correcting a
          read doesn't recompute amounts: if a corrected number changes a total, adjust that line too.
        </p>
        <ErrorBox error={s.error} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={s.busy || !value.trim() || !reason.trim()}>
            Record correction
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Correct client-entered household data (D-47). The household record is the client's, so the
 * correction must cite the client's own confirmation: an answered question about this person,
 * or a message from the client. The original entry is kept.
 */
export function CorrectRecordDialog({ node, onClose, onAsk }: { node: NodeSummary; onClose: () => void; onAsk: () => void }) {
  // D-57: the revision you were looking at when you opened this. Live updates refresh `node`,
  // but a write must be judged against what you saw, so keep the opening value.
  const [openedRev] = useState(node.revision);
  const personId = node.id.slice('household:'.length);
  const questions = useQuestions();
  const issues = useIssues();
  const [field, setField] = useState<'ssn' | 'name' | 'dob'>('ssn');
  const [value, setValue] = useState('');
  const [evidenceId, setEvidenceId] = useState('');
  const [reason, setReason] = useState('');
  const run = useCommand();
  const s = useSubmit();
  // Confirmations the server will accept: answered questions to the client about this person,
  // and client messages that our identity check already linked to this person.
  const answered = (questions.data ?? []).filter((q) => q.to === 'client' && q.thread.length > 1 && q.nodeIds.includes(node.id));
  const messages = [...new Set((issues.data ?? []).filter((i) => i.nodeIds.includes(node.id)).flatMap((i) => i.nodeIds.filter((n) => n.startsWith('msg:'))))];
  const options = [
    ...answered.map((q) => ({ id: `question:${q.id}`, text: `Answer: "${q.thread[q.thread.length - 1]!.text}"` })),
    ...messages.map((m) => ({ id: m, text: `Client message ${m.slice(4)}` })),
  ];
  const chosen = evidenceId || options[0]?.id || '';
  return (
    <Modal title="Correct the household record" onClose={onClose} width={520}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await s.go(() =>
            run(() => api<CommandResult>('/api/household/corrections', { method: 'POST', body: { personId, field, value, evidenceId: chosen, reason, revision: openedRev } }), {
              done: `${node.label}: record corrected. The client's original entry is kept.`,
            }),
          );
          if (ok) onClose();
        }}
      >
        <p className="mb-3 text-sm text-graphite">
          {node.label}'s details come from the client's organizer. Correct them only with the client's confirmation; the original entry is kept with your reason.
        </p>
        <Field label="Field">
          <select className="input" value={field} onChange={(e) => setField(e.target.value as 'ssn' | 'name' | 'dob')}>
            <option value="ssn">SSN</option>
            <option value="name">Name</option>
            <option value="dob">Date of birth</option>
          </select>
        </Field>
        <Field label="Correct value" hint={field === 'ssn' ? 'As on the Social Security card: NNN-NN-NNNN. Needs sensitive-data clearance; shown masked afterwards.' : field === 'dob' ? 'YYYY-MM-DD' : undefined}>
          <input className="input num" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" autoFocus />
        </Field>
        <Field label="Client's confirmation" hint="Required by the server: an answered question to the client about this person, or the client's own message.">
          {options.length ? (
            <select className="input" value={chosen} onChange={(e) => setEvidenceId(e.target.value)}>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.text}
                </option>
              ))}
            </select>
          ) : (
            <div className="rounded border border-amber bg-amber-soft px-2 py-1.5 text-xs text-amber-ink">
              No confirmation from the client yet.{' '}
              <button type="button" className="font-semibold underline underline-offset-2" onClick={onAsk}>
                Ask the client
              </button>{' '}
              first; their answer becomes the evidence.
            </div>
          )}
        </Field>
        <Field label="Why" hint="Required. Kept in the history with your name.">
          <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Client confirmed; agrees with the SS card (D71) and the 2024 return" />
        </Field>
        <ErrorBox error={s.error} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={s.busy || !value.trim() || !reason.trim() || !chosen}>
            Record correction
          </button>
        </div>
      </form>
    </Modal>
  );
}

function parseInput(raw: string, like: unknown): unknown {
  if (typeof like === 'number' || /^[\s(−-]*[\d,.]+\)?\s*$/.test(raw)) {
    const neg = /^\s*[(−-]/.test(raw);
    const n = Number(raw.replace(/[^\d.]/g, ''));
    if (!Number.isNaN(n) && raw.trim() !== '') return neg ? -n : n;
  }
  if (typeof like === 'boolean') return /^(y|yes|true|1)$/i.test(raw.trim());
  return raw;
}

export function NoteDialog({ nodeIds, onClose, label }: { nodeIds: string[]; onClose: () => void; label: string }) {
  const { actor } = useSession();
  const [text, setText] = useState('');
  const [blocking, setBlocking] = useState(actor?.role === 'reviewer' || actor?.role === 'partner');
  const run = useCommand();
  const s = useSubmit();
  return (
    <Modal title="Add review note" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await s.go(() =>
            run(() => api<CommandResult>('/api/notes', { method: 'POST', body: { nodeIds, text, blocking } }), { done: blocking ? 'Blocking note added. Filing stays blocked until it is cleared.' : 'Note added' }),
          );
          if (ok) onClose();
        }}
      >
        <p className="mb-3 text-sm text-graphite">{label}</p>
        <Field label="Note">
          <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <label className="mb-3 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={blocking} onChange={(e) => setBlocking(e.target.checked)} className="mt-0.5" />
          <span>
            <span className="font-semibold">Blocking</span>
            <span className="block text-xs text-graphite">Open blocking notes prevent filing. Only you or a partner can clear it.</span>
          </span>
        </label>
        <ErrorBox error={s.error} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={s.busy || !text.trim()}>
            Add note
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function AskDialog({ nodeIds, onClose, label }: { nodeIds: string[]; onClose: () => void; label: string }) {
  const { actors, actorId } = useSession();
  const [to, setTo] = useState('client');
  const [text, setText] = useState('');
  const run = useCommand();
  const s = useSubmit();
  const staff = actors.filter((a) => a.kind === 'staff' && a.id !== actorId);
  return (
    <Modal title="Ask a question" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await s.go(() =>
            run(() => api<CommandResult>('/api/questions', { method: 'POST', body: { to, nodeIds, text } }), { done: to === 'client' ? 'Question sent to the client portal' : 'Question sent' }),
          );
          if (ok) onClose();
        }}
      >
        <p className="mb-3 text-sm text-graphite">{label}</p>
        <Field label="Ask" hint="The answer is kept on this item as evidence.">
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="client">The client (Ngozi and Erik)</option>
            {staff.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.role.replace('_', ' ')})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Question">
          <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
        <ErrorBox error={s.error} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={s.busy || !text.trim()}>
            Send question
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function EvidenceDialog({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const [mode, setMode] = useState<'link' | 'note' | 'file'>('link');
  const [q, setQ] = useState('');
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const search = useSearch(q);
  const run = useCommand();
  const s = useSubmit();

  const link = (evidenceId: string) =>
    run(() => api<CommandResult>(`/api/nodes/${enc(nodeId)}/evidence`, { method: 'POST', body: { evidenceId, note: note || undefined } }), { done: 'Evidence linked' });

  return (
    <Modal title="Link evidence" onClose={onClose} width={520}>
      <div className="mb-3 flex gap-1 text-sm" role="tablist">
        {(['link', 'note', 'file'] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={mode === m ? 'btn border-ink' : 'btn-ghost'} onClick={() => setMode(m)}>
            {m === 'link' ? 'Existing item' : m === 'note' ? 'Written note' : 'Upload file'}
          </button>
        ))}
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const ok = await s.go(async () => {
            if (mode === 'link') return link(target.trim());
            let attId: string | undefined;
            if (mode === 'note') {
              const r = await api<CommandResult<{ id: string }>>('/api/attachments', { method: 'POST', body: { kind: 'note', name: name || 'Note', text } });
              attId = r.data?.id;
            } else if (file) {
              const r = await upload<CommandResult<{ id: string }>>('/api/attachments', file);
              attId = r.data?.id;
            }
            if (!attId) throw new Error('The attachment was not stored');
            return link(attId);
          });
          if (ok) onClose();
        }}
      >
        {mode === 'link' && (
          <>
            <Field label="Find a line or document" hint="Or type any node id: qa:qa-25, msg:msg-07, call:call-01, py:/…, doc:D11#page1">
              <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" />
            </Field>
            {search.data && search.data.length > 0 && (
              <ul className="mb-3 max-h-40 overflow-auto rounded border border-rule">
                {search.data.map((r) => (
                  <li key={r.id}>
                    <button type="button" className="w-full px-2 py-1 text-left text-sm hover:bg-ruleSoft" onClick={() => setTarget(r.id)}>
                      <span className="text-graphite">{r.sublabel}</span> {r.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Field label="Evidence id">
              <input className="input" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="qa:qa-25" />
            </Field>
          </>
        )}
        {mode === 'note' && (
          <>
            <Field label="Title">
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Call with Erik re: phone use" />
            </Field>
            <Field label="Text">
              <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          </>
        )}
        {mode === 'file' && (
          <Field label="File" hint="Stored with a SHA-256 hash.">
            <input type="file" className="input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        )}
        <Field label="Why it supports this (optional)">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorBox error={s.error} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={s.busy || (mode === 'link' ? !target.trim() : mode === 'note' ? !text.trim() : !file)}>
            Link evidence
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function ReasonDialog({
  title,
  label,
  confirm,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  label: string;
  confirm: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<unknown>;
  children?: React.ReactNode;
}) {
  const [reason, setReason] = useState('');
  const s = useSubmit();
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (await s.go(() => onSubmit(reason))) onClose();
        }}
      >
        {children}
        <Field label={label}>
          <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <ErrorBox error={s.error} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={s.busy || !reason.trim()}>
            {confirm}
          </button>
        </div>
      </form>
    </Modal>
  );
}
