import type { DispositionStatus, DocumentDto } from '@easetax/shared';
import { useState } from 'react';
import { api } from '../api/client';
import { useCommand } from './actions';
import { ErrorBox, Field, Modal } from './ui';

export const DISPOSITION_LABEL: Record<DispositionStatus, string> = {
  used: 'Used',
  duplicate: 'Duplicate',
  superseded: 'Superseded',
  not_relevant: 'Not relevant',
  out_of_year: 'Out of year',
  pending: 'Pending',
  outside_scope: 'Outside scope',
};

export function DispositionDialog({ doc, onClose }: { doc: DocumentDto; onClose: () => void }) {
  const [status, setStatus] = useState<DispositionStatus>(doc.disposition?.status ?? (doc.linesFed ? 'used' : 'not_relevant'));
  const [note, setNote] = useState(doc.disposition && !doc.disposition.derived ? doc.disposition.note ?? '' : '');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = useCommand();
  return (
    <Modal title={`Disposition of ${doc.id}`} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await run(() => api(`/api/documents/${doc.id}/disposition`, { method: 'PUT', body: { status, note: note || undefined } }), {
              done: `${doc.id} marked ${DISPOSITION_LABEL[status].toLowerCase()}`,
            });
            onClose();
          } catch (x) {
            setError(x);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="mb-3 text-sm text-graphite">
          {doc.title}. Feeds {doc.linesFed} line(s) in the current version.
        </p>
        <Field label="Disposition">
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as DispositionStatus)}>
            {(Object.keys(DISPOSITION_LABEL) as DispositionStatus[]).map((s) => (
              <option key={s} value={s}>
                {DISPOSITION_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reason" hint={status === 'used' ? 'Optional when used.' : 'Required: say why this document does not feed the return.'}>
          <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Second image of D09; counted once" />
        </Field>
        <ErrorBox error={error} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={busy || (status !== 'used' && !note.trim())}>
            Save disposition
          </button>
        </div>
      </form>
    </Modal>
  );
}
