// One generated record: header, exceptions first, then the record's own rendering.
import type { ViewDto } from '@easetax/shared';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useView, useViewList } from '../../api/recordsHooks';
import { Findings, Rest } from '../../components/records/kit';
import { recordFor } from '../../components/records/registry';
import { ErrorBox, Loading } from '../../components/ui';
import { useHotkeys } from '../../lib/hotkeys';
import { useDrawer } from '../../state/drawer';

export function RecordView() {
  const { viewId } = useParams();
  const view = useView(viewId);
  const list = useViewList();
  const navigate = useNavigate();
  const { nodeId } = useDrawer();
  const items = list.data ?? [];
  const i = items.findIndex((v) => v.id === viewId);
  const prev = i > 0 ? items[i - 1] : undefined;
  const next = i >= 0 && i < items.length - 1 ? items[i + 1] : undefined;
  useHotkeys({ '[': () => prev && navigate(`/records/${prev.id}`), ']': () => next && navigate(`/records/${next.id}`) }, !nodeId);
  const meta = recordFor(viewId ?? '');
  const Render = meta.render;
  const v = view.data;

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-5">
      <div className="mb-1 flex items-center gap-2">
        <Link to="/records" className="btn-ghost -ml-1.5 text-xs">
          <ArrowLeft size={12} /> Records
        </Link>
        <span className="flex-1" />
        <select className="input w-auto py-0.5 text-xs" value={viewId} onChange={(e) => navigate(`/records/${e.target.value}`)} aria-label="Go to record">
          {items.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </select>
        <button className="btn-ghost" disabled={!prev} onClick={() => prev && navigate(`/records/${prev.id}`)} title="Previous record ([)">
          <ChevronLeft size={14} />
        </button>
        <button className="btn-ghost" disabled={!next} onClick={() => next && navigate(`/records/${next.id}`)} title="Next record (])">
          <ChevronRight size={14} />
        </button>
      </div>
      <ErrorBox error={view.error} />
      {view.isLoading && <Loading what="record" />}
      {v && (
        <>
          <header className="mb-3">
            <h1 className="font-serif text-2xl font-semibold">{v.title}</h1>
            <p className="text-sm text-graphite">
              {meta.purpose || v.description}{' '}
              <span className="text-faint">
                · engine {v.version} with workpaper adjustments, as of event {v.seq}
              </span>
            </p>
          </header>
          <div className="space-y-4">
            <Findings findings={v.findings} />
            <Guard view={v} key={v.id}>
              <Render view={v} />
            </Guard>
          </div>
        </>
      )}
    </div>
  );
}

/** If a dedicated renderer meets a shape it does not expect, fall back to the generic tables. */
class Guard extends Component<{ view: ViewDto; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    console.error('Record renderer failed; showing generic tables', e);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="space-y-4">
        <div className="rounded border border-amber bg-amber-soft px-3 py-1.5 text-xs text-amber-ink">This record’s layout could not render this data; showing it as plain sections.</div>
        <Rest sections={this.props.view.sections} />
      </div>
    );
  }
}
