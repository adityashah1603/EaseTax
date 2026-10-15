// Source documents behind one interface (design §7.8, D-14). The viewer only knows
// { document, page, anchor }; the renderer is chosen by dto.rendition.kind, so a PDF or
// image renderer can replace the simulated one without touching tracing.
import type { DocumentDetailDto, PageAnchor } from '@easetax/shared';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import { humanize } from '../../lib/format';

export interface SourceRenditionProps {
  doc: DocumentDetailDto;
  page: number;
  /** Extracted value id (without the ev: prefix) to highlight. */
  highlight?: string | null;
  onSelect?: (evId: string) => void;
}

type Renderer = (p: SourceRenditionProps) => ReactElement;

const RENDERERS: Record<DocumentDetailDto['rendition']['kind'], Renderer> = {
  simulated: SimulatedPage,
  pdf: UnsupportedRendition,
  image: UnsupportedRendition,
};

export function SourceRendition(props: SourceRenditionProps) {
  const R = RENDERERS[props.doc.rendition.kind] ?? UnsupportedRendition;
  return <R {...props} />;
}

function UnsupportedRendition({ doc }: SourceRenditionProps) {
  return (
    <div className="rounded border border-dashed border-rule p-6 text-sm text-graphite">
      This document is a {doc.rendition.kind}. Its renderer is not installed yet; anchors use the same page-fraction contract.
    </div>
  );
}

// ---------------------------------------------------------------- simulated

interface Segment {
  text: string;
  evId?: string;
}

/** Where each field's text-as-read appears in the printed text (null when it doesn't). */
export function matchAnchors(text: string, anchors: PageAnchor[]): { segments: Segment[]; found: Set<string> } {
  const taken: { start: number; end: number; evId: string }[] = [];
  const found = new Set<string>();
  for (const a of anchors) {
    const needle = (a.textAsRead ?? '').trim();
    if (!needle) continue;
    let from = 0;
    while (from <= text.length) {
      const i = text.indexOf(needle, from);
      if (i < 0) break;
      const end = i + needle.length;
      const clash = taken.some((t) => i < t.end && end > t.start);
      // Don't match inside a longer number (e.g. "0.00" within "10.00").
      const before = text[i - 1];
      const after = text[end];
      const glued = (before && /[\d.,]/.test(before) && /^\d/.test(needle)) || (after && /\d/.test(after) && /\d$/.test(needle));
      if (!clash && !glued) {
        taken.push({ start: i, end, evId: a.evId });
        found.add(a.evId);
        break;
      }
      from = i + 1;
    }
  }
  taken.sort((x, y) => x.start - y.start);
  const segments: Segment[] = [];
  let pos = 0;
  for (const t of taken) {
    if (t.start > pos) segments.push({ text: text.slice(pos, t.start) });
    segments.push({ text: text.slice(t.start, t.end), evId: t.evId });
    pos = t.end;
  }
  if (pos < text.length) segments.push({ text: text.slice(pos) });
  return { segments, found };
}

/** Lay the printed sentence out like form rows: one clause per line. */
export function formRows(text: string) {
  return text.replace(/;\s+/g, ';\n').replace(/\.\s+(?=[A-Z(])/g, '.\n');
}

function SimulatedPage({ doc, page, highlight, onSelect }: SourceRenditionProps) {
  const p = doc.pages.find((x) => x.page === page) ?? doc.pages[0];
  const text = useMemo(() => formRows(p?.printedContent ?? ''), [p]);
  const { segments, found } = useMemo(() => matchAnchors(text, p?.anchors ?? []), [text, p]);
  const sel = p?.anchors.find((a) => a.evId === highlight);
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    (textRef.current ?? boxRef.current)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [highlight, page]);

  if (!p) return <div className="text-sm text-faint">This page has no printed content in the packet.</div>;
  const [first, ...rest] = doc.title.split(' - ');

  return (
    <div>
      <div
        className="relative mx-auto w-full overflow-hidden rounded-sm border border-rule bg-[#FFFEFB] shadow-[0_1px_0_#dce1db,0_8px_24px_-12px_rgba(26,36,32,0.25)]"
        style={{ aspectRatio: '8.5 / 11' }}
        aria-label={`${doc.id} page ${p.page}, simulated from printed content`}
      >
        {/* header band, like the top of a paper form */}
        <div className="absolute inset-x-[6%] top-[3%] flex items-end justify-between border-b-2 border-ink pb-1 font-serif">
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold leading-tight">{first}</div>
            {rest.length > 0 && <div className="truncate text-[11px] leading-tight text-graphite">{rest.join(' - ')}</div>}
          </div>
          <div className="shrink-0 pl-2 text-right text-[10px] leading-tight text-graphite">
            <div>{doc.documentType}</div>
            <div>
              Page {p.page} of {doc.pageCount}
            </div>
          </div>
        </div>
        {/* printed content: the ground truth */}
        <div className="absolute inset-x-[6%] bottom-[6%] top-[11%] overflow-auto whitespace-pre-wrap font-serif text-[11.5px] leading-[1.55] text-ink">
          {segments.map((s, i) =>
            s.evId ? (
              <span
                key={i}
                ref={s.evId === highlight ? textRef : undefined}
                onClick={() => onSelect?.(s.evId!)}
                className={clsx(
                  'cursor-pointer rounded-[2px] px-[1px]',
                  s.evId === highlight ? 'bg-blue text-white' : 'bg-ledger-soft/70 hover:bg-blue-soft',
                )}
                title="Extracted field: click to select"
              >
                {s.text}
              </span>
            ) : (
              <span key={i}>{s.text}</span>
            ),
          )}
        </div>
        {/* the pipeline's anchor box for the selected field (page fractions, top-left origin) */}
        {sel && (
          <div
            ref={boxRef}
            className="pointer-events-none absolute rounded-[2px] border-2 border-blue bg-blue/10"
            style={{
              left: `${sel.anchor.x0 * 100}%`,
              top: `${sel.anchor.y0 * 100}%`,
              width: `${(sel.anchor.x1 - sel.anchor.x0) * 100}%`,
              height: `${(sel.anchor.y1 - sel.anchor.y0) * 100}%`,
            }}
          >
            <span className="absolute -top-[18px] left-0 whitespace-nowrap rounded-sm bg-blue px-1 text-[10px] font-semibold text-white">
              {sel.label}
            </span>
          </div>
        )}
        <div className="absolute inset-x-[6%] bottom-[2%] flex justify-between text-[9px] text-faint">
          <span>{doc.fileName}</span>
          <span>Simulated from printed content · boxes from pipeline anchors</span>
        </div>
      </div>
      {sel && <ReadCheck anchor={sel} foundInText={found.has(sel.evId)} />}
    </div>
  );
}

/** The selected field: what the pipeline read vs what is printed. */
function ReadCheck({ anchor, foundInText }: { anchor: PageAnchor; foundInText: boolean }) {
  const low = anchor.confidence < 0.8;
  return (
    <div className={clsx('mt-2 rounded border px-2.5 py-1.5 text-xs', foundInText && !low ? 'border-rule bg-panel' : 'border-amber bg-amber-soft text-amber-ink')}>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-semibold">{anchor.label}</span>
        <span>
          read as <span className="num font-semibold">{anchor.textAsRead}</span>
        </span>
        <span className={clsx(low && 'font-semibold')}>confidence {Math.round(anchor.confidence * 100)}%</span>
        <span className="text-faint">{humanize(anchor.field)}</span>
      </div>
      {!foundInText && (
        <div className="mt-1 font-semibold">
          “{anchor.textAsRead}” does not appear in the printed text of this page. Compare the read value with the page before relying on it.
        </div>
      )}
    </div>
  );
}
