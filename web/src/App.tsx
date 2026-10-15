import { useQuery } from '@tanstack/react-query';
import type { ReturnSummaryDto } from '@easetax/shared';
import { api } from './api/client';

// Placeholder shell; the real UI lands in milestone M2b.
export function App() {
  const { data } = useQuery({ queryKey: ['summary'], queryFn: () => api<ReturnSummaryDto>('/api/summary') });
  return (
    <main className="p-6 font-sans">
      <h1 className="text-xl font-semibold">EaseTax Workpaper</h1>
      {data && (
        <p className="text-sm text-gray-600">
          {data.name} · current {data.currentVersion} · {data.status.openIssues} open issues
        </p>
      )}
    </main>
  );
}
