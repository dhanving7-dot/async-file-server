import { type ComponentType, useCallback, useEffect, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { Background, NAV, OfflineBanner, PageTransition, type PageId, Sidebar, Toaster, Topbar } from './components/layout';
import { WorkloadModal } from './components/live';
import { connectBridge } from './lib/store';
import Overview from './pages/Overview';
import Workers from './pages/Workers';
import Queue from './pages/Queue';
import Completions from './pages/Completions';
import Files from './pages/Files';
import Analytics from './pages/Analytics';
import Logs from './pages/Logs';

const PAGES: Record<PageId, ComponentType> = {
  overview: Overview,
  workers: Workers,
  queue: Queue,
  completions: Completions,
  files: Files,
  analytics: Analytics,
  logs: Logs,
};

function pageFromHash(): PageId {
  const id = location.hash.replace(/^#\/?/, '') as PageId;
  return NAV.some((n) => n.id === id) ? id : 'overview';
}

export default function App() {
  const [page, setPage] = useState<PageId>(pageFromHash);
  const [workloadOpen, setWorkloadOpen] = useState(false);

  useEffect(() => {
    connectBridge();
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((id: PageId) => {
    location.hash = `/${id}`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const Page = PAGES[page];

  return (
    <div className="flex min-h-screen">
      <Background />
      <Sidebar page={page} onNavigate={navigate} />
      <div className="flex min-w-0 flex-1 flex-col overflow-x-clip">
        <Topbar page={page} onNavigate={navigate} onWorkload={() => setWorkloadOpen(true)} />
        <OfflineBanner />
        <main className="mx-auto w-full max-w-[1480px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <AnimatePresence mode="wait">
            <PageTransition id={page}>
              <Page />
            </PageTransition>
          </AnimatePresence>
        </main>
      </div>
      <WorkloadModal open={workloadOpen} onClose={() => setWorkloadOpen(false)} />
      <Toaster />
    </div>
  );
}
