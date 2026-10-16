// "Every area considered" (completeness proof): mark a review area considered, with an
// optional note. Who/when come from the event log; AreaDto only says considered or not.
import type { AreaDto, CommandResult } from '@easetax/shared';
import { ListChecks } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client';
import { fmtDateTime } from '../../lib/format';
import { useSession } from '../../state/session';
import { useCommand } from '../actions';
import { ErrorBox, Field, Modal, Tick } from '../ui';

export function AreaConsidered({ area }: { area: AreaDto }) {
  // Who/when/note come with the area now (AreaDto.consideredBy/At/Note).
  const mark = area.consideredBy ? { by: area.consideredBy, at: area.consideredAt!, note: area.consideredNote } : undefined;
  const { can, nameOf } = useSession();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
      {area.considered ? (
        <span className="inline-flex flex-wrap items-center gap-1.5 text-ledger-ink">
          <Tick size={13} title="Area considered" />
          <span className="font-semibold">Area considered</span>
          {mark && (
            <span className="text-graphite">
              by {nameOf(mark.by)}, {fmtDateTime(mark.at)}
              {mark.note && <span className="italic">: “{mark.note}”</span>}
            </span>
          )}
        </span>
      ) : (
        <span className="text-graphite">Not yet marked considered.</span>
      )}
      {can('signoff') && (
        <button className={area.considered ? 'btn-ghost text-xs' : 'btn text-xs'} onClick={() => setOpen(true)}>
          <ListChecks size={13} /> {area.considered ? 'Mark again with a note' : 'Mark area considered'}
        </button>
      )}
      {open && <ConsideredDialog area={area} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ConsideredDialog({ area, onClose }: { area: AreaDto; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCommand();
  return (
    <Modal title="Mark area considered" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await run(() => api<CommandResult>(`/api/areas/${encodeURIComponent(area.id)}/considered`, { method: 'PUT', body: { note: note.trim() || undefined } }), {
              done: `${area.title} marked considered`,
            });
            onClose();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="mb-3 text-sm text-graphite">
          Records that <span className="font-semibold">{area.title}</span> was considered for this return. It appears in the completeness record with your name and the time.
        </p>
        <Field label="Note (optional)" hint="e.g. what you looked at, or why nothing applies.">
          <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorBox error={error} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={busy}>
            Mark considered
          </button>
        </div>
      </form>
    </Modal>
  );
}
