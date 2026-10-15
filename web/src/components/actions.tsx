// Work actions on a node: verify, adjust, note, ask, attach evidence. Each is one REST
// command; the server's policy text is shown verbatim when it refuses.
import type { CommandResult, NodeSummary } from '@easetax/shared';
import { useState } from 'react';
import { api, enc, upload } from '../api/client';
import { undoTargetsFor, useInvalidateAll, useSearch, useStandards } from '../api/hooks';
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

export function VerifyDialog({ nodeIds, onClose, label }: { nodeIds: string[]; onClose: () => void; label: string }) {
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
            run(() => api<CommandResult>('/api/verifications', { method: 'POST', body: { nodeIds, type: chosen, note: note || undefined } }), {
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
            run(() => api<CommandResult>('/api/adjustments', { method: 'POST', body: { nodeId: node.id, newValue: parsed, reason, authority: authority || undefined } }), {
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
