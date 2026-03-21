import Search from '../components/SearchContainer';
import QuickLinks from '../components/QuickLinks';
import SidebarLayout from '../layouts/SidebarLayout';
import { memo, useEffect, useState } from 'react';

const Home = memo(() => {
  const [liveUsers, setLiveUsers] = useState(null);
  const [windowMs, setWindowMs] = useState(120000);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [showLiveDetails, setShowLiveDetails] = useState(false);

  useEffect(() => {
    let active = true;

    const loadLiveUsers = async () => {
      try {
        const response = await fetch('/api/live-users');
        if (!response.ok) return;
        const payload = await response.json().catch(() => ({}));
        if (!active) return;
        const nextCount = Number(payload?.count);
        if (Number.isFinite(nextCount)) setLiveUsers(nextCount);
        const nextWindowMs = Number(payload?.windowMs);
        if (Number.isFinite(nextWindowMs) && nextWindowMs > 0) setWindowMs(nextWindowMs);
        setLastUpdated(Date.now());
      } catch {
        // Ignore transient network issues.
      }
    };

    loadLiveUsers();
    const interval = setInterval(loadLiveUsers, 10000);

    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  return (
    <SidebarLayout>
      <div className="relative min-h-screen px-6 pb-20 flex flex-col items-center justify-center">
        <div className="absolute top-6 right-6 flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={() => setShowLiveDetails((prev) => !prev)}
            className="rounded-full border border-white/20 bg-black/35 px-4 py-2 text-xs font-medium backdrop-blur transition hover:border-white/35"
          >
            Live users: {liveUsers ?? '--'}
          </button>
          {showLiveDetails && (
            <div className="rounded-xl border border-white/20 bg-black/45 px-4 py-3 text-xs backdrop-blur">
              <p>Active window: {Math.max(1, Math.round(windowMs / 60000))} min</p>
              <p className="mt-1 opacity-80">
                Last updated: {lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : '--'}
              </p>
            </div>
          )}
        </div>
        <Search logo cls="w-full max-w-4xl mx-auto flex flex-col items-center" />
        <QuickLinks cls="w-full max-w-[40rem] mx-auto mt-8 flex flex-wrap justify-center gap-4" />
      </div>
    </SidebarLayout>
  );
});

Home.displayName = 'Home';
export default Home;
