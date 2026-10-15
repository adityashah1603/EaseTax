// Sign-offs for the whole return and for each area, with what still stands in the way.
import clsx from 'clsx';
import { Link } from 'react-router-dom';
import { useAreas, useSummary } from '../api/hooks';
import { SignoffPanel } from '../components/SignoffPanel';
import { Loading } from '../components/ui';

export function Signoffs() {
  const areas = useAreas();
  const summary = useSummary();
  const st = summary.data?.status;
  const blockers = st
    ? [
        { n: st.blockingNotes, text: 'blocking review note(s) open', to: '/' },
        { n: st.openIssues, text: 'open issue(s)', to: '/' },
        { n: st.pendingAdjustments, text: 'adjustment(s) waiting for a partner', to: '/' },
        { n: st.undispositionedDocs, text: 'document(s) with no disposition', to: '/documents' },
        { n: st.signoffs.filter((s) => s.status === 'reopened').length, text: 'sign-off(s) reopened by later changes', to: '/signoffs' },
      ]
    : [];
  return (
    <div className="mx-auto max-w-[1180px] px-6 py-5">
      <h1 className="mb-1 font-serif text-2xl font-semibold">Sign-offs</h1>
      <p className="mb-4 max-w-[70ch] text-sm text-graphite">
        A sign-off covers the values in its scope as they were when signed. If any of them changes later, the sign-off reopens on its own and shows the change. Reviewers and
        partners can't sign off on work they prepared; the server refuses and quotes the firm rule.
      </p>
      <div className="mb-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <h2 className="mb-2 text-sm font-semibold text-graphite">Whole return</h2>
          <SignoffPanel scope="return" />
        </div>
        <div>
          <h2 className="mb-2 text-sm font-semibold text-graphite">Standing in the way of filing</h2>
          {!st ? (
            <Loading />
          ) : (
            <ul className="rounded border border-rule bg-panel text-sm">
              {blockers.map((b) => (
                <li key={b.text} className="flex items-center gap-2 border-b border-ruleSoft px-3 py-1.5 last:border-0">
                  <span className={clsx('num w-8 text-right font-semibold', b.n ? 'text-pencil' : 'text-ledger')}>{b.n}</span>
                  <Link to={b.to} className="hover:underline">
                    {b.text}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <h2 className="mb-2 text-sm font-semibold text-graphite">By area</h2>
      {!areas.data ? (
        <Loading />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {areas.data.map((a) => (
            <div key={a.id}>
              <Link to={`/areas/${a.id}`} className="mb-1 block text-sm font-semibold hover:underline">
                {a.title}
              </Link>
              <SignoffPanel scope={`area:${a.id}`} compact />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
