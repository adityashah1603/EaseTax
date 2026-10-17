import { Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { TraceDrawer } from './components/trace/TraceDrawer';
import { AreaLines } from './pages/AreaLines';
import { ClientPortal } from './pages/ClientPortal';
import { DocumentDetail } from './pages/DocumentDetail';
import { Documents } from './pages/Documents';
import { Queue } from './pages/Queue';
import { ReturnMap } from './pages/ReturnMap';
import { Signoffs } from './pages/Signoffs';
import { useSession } from './state/session';
import { StreamProvider } from './state/stream';
import { viewRoutes } from './routes/views';
import { workflowRoutes } from './routes/workflow';

export function App() {
  const { actorId, isClient, actor, notStarted } = useSession();
  return (
    <StreamProvider actorId={actorId}>
      <Shell>
        {!actor ? null : notStarted ? (
          <div className="mx-auto mt-16 max-w-md rounded border border-rule bg-panel p-6 text-sm">
            <p className="font-semibold">
              {actor.name} starts on {actor.activeFrom}.
            </p>
            <p className="mt-1 text-graphite">Until then the workpaper is closed to them. Switch to someone else with the role switcher above.</p>
          </div>
        ) : isClient ? (
          <Routes>
            <Route path="*" element={<ClientPortal />} />
          </Routes>
        ) : (
          <Routes>
            <Route path="/" element={<Queue />} />
            <Route path="/map" element={<ReturnMap />} />
            <Route path="/areas/:areaId" element={<AreaLines />} />
            <Route path="/documents" element={<Documents />} />
            <Route path="/documents/:docId" element={<DocumentDetail />} />
            <Route path="/signoffs" element={<Signoffs />} />
            {[...viewRoutes, ...workflowRoutes].map((r) => (
              <Route key={r.path} path={r.path} element={r.element} />
            ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </Shell>
      {actor && !isClient && !notStarted && <TraceDrawer />}
    </StreamProvider>
  );
}
