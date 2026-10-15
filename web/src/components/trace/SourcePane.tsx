// The right side of the trace drawer: the source page behind the selected leaf,
// with the exact field highlighted.
import { parsePageId } from '@easetax/shared';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDocument, useNode } from '../../api/hooks';
import { SourceRendition } from '../source/SourceRendition';
import { Loading } from '../ui';

/** Resolve any source-ish node id to { doc, page, ev }. ev:… needs its packet record. */
export function useSourceTarget(id: string | null) {
  const isEv = !!id?.startsWith('ev:');
  const ev = useNode(isEv ? id : null);
  if (!id) return null;
  if (isEv) {
    const raw = ev.data?.raw as { document_id?: string; page?: number } | undefined;
    if (!raw?.document_id) return ev.isLoading ? { loading: true as const } : null;
    return { doc: raw.document_id, page: raw.page ?? 1, ev: id.slice(3) };
  }
  const pg = parsePageId(id);
  if (pg) return { doc: pg.doc, page: pg.page, ev: null };
  if (id.startsWith('doc:')) return { doc: id.slice(4), page: 1, ev: null };
  return null;
}

export function SourcePane({ sourceId, onSelectEv }: { sourceId: string | null; onSelectEv: (evNodeId: string) => void }) {
  const target = useSourceTarget(sourceId);
  const docId = target && 'doc' in target ? target.doc : undefined;
  const doc = useDocument(docId);
  const [page, setPage] = useState(1);
  useEffect(() => {
    if (target && 'page' in target) setPage(target.page ?? 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, target && 'page' in target ? target.page : 0]);

  if (!sourceId || !target)
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-sm text-faint">
        <p>Select a source value in the tree to see it on its page.</p>
        <p className="mt-1 text-xs">Leaves marked with a page icon come from documents.</p>
      </div>
    );
  if ('loading' in target || doc.isLoading || !doc.data) return <Loading what="source page" />;
  const d = doc.data;
  const evId = 'ev' in target ? target.ev : null;
  return (
    <div>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{d.title}</div>
          <div className="text-xs text-graphite">
            {d.id} · {d.documentType} · received {d.receivedAt.slice(0, 10)}
            {d.markedCorrected && <span className="ml-1 font-semibold text-amber-ink">CORRECTED</span>}
          </div>
        </div>
        <Link to={`/documents/${d.id}?page=${page}${evId ? `&ev=${evId}` : ''}`} className="btn-ghost shrink-0 text-xs">
          Open document <ExternalLink size={12} />
        </Link>
      </div>
      {d.pageCount > 1 && (
        <div className="mb-2 flex items-center gap-2 text-xs text-graphite">
          <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
            <ChevronLeft size={14} />
          </button>
          Page {page} of {d.pageCount}
          <button className="btn-ghost" disabled={page >= d.pages.length} onClick={() => setPage(page + 1)} aria-label="Next page">
            <ChevronRight size={14} />
          </button>
        </div>
      )}
      <SourceRendition doc={d} page={page} highlight={evId} onSelect={(e) => onSelectEv(`ev:${e}`)} />
    </div>
  );
}
