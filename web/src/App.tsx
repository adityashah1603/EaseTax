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

export function App() {
  const { actorId, isClient, actor } = useSession();
  return (
    <StreamProvider actorId={actorId}>
      <Shell>
        {!actor ? null : isClient ? (
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
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        )}
      </Shell>
      {actor && !isClient && <TraceDrawer />}
    </StreamProvider>
  );
}
