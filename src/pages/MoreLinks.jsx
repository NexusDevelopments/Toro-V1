import { useEffect, useMemo, useState } from 'react';
import SidebarLayout from '../layouts/SidebarLayout';

const seedLinks = [
  'https://educationhub-2.b-cdn.net',
  'https://educationcentral-2.b-cdn.net',
  'https://educationatlas-2.b-cdn.net',
  'https://educationworks-2.b-cdn.net',
  'https://educationstudio-2.b-cdn.net',
];

const normalizePreviewUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.includes('.')) return `https://${raw}`;
  return `https://${raw}.workers.dev`;
};

const MoreLinks = () => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  const links = useMemo(() => seedLinks, []);

  const refreshStatuses = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/more-links/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || 'Status check failed');
      setItems(Array.isArray(payload.results) ? payload.results : []);
    } catch {
      setItems(
        links.map((link) => ({
          input: link,
          label: link,
          url: normalizePreviewUrl(link),
          online: false,
          status: null,
          error: 'Failed to check',
        }))
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshStatuses();
  }, []);

  useEffect(() => {
    const prevBgImage = document.body.style.backgroundImage;
    const prevBgSize = document.body.style.backgroundSize;

    // Keep the animated network layer, but remove page dot/gradient backgrounds here.
    document.body.style.backgroundImage = 'none';
    document.body.style.backgroundSize = 'auto';

    return () => {
      document.body.style.backgroundImage = prevBgImage;
      document.body.style.backgroundSize = prevBgSize;
    };
  }, []);

  return (
    <SidebarLayout>
      <div className="mx-auto w-full max-w-5xl px-8 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-3xl font-semibold">More links for Toro V2</h2>
            <p className="mt-2 text-sm opacity-75">Live status for your custom links.</p>
          </div>
          <button
            onClick={refreshStatuses}
            disabled={loading}
            className="rounded-full border border-white/20 bg-white/5 px-4 py-2 text-sm hover:border-white/35 disabled:opacity-60"
          >
            {loading ? 'Checking...' : 'Refresh Status'}
          </button>
        </div>

        <div className="mx-auto mt-6 w-full max-w-3xl space-y-3">
          {items.map((item) => (
            <div key={item.input} className="rounded-xl border border-white/10 bg-black/20 px-4 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-base font-semibold">{item.input}</div>
                  <a
                    href={item.url || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 block text-sm text-red-200/80 hover:text-red-100"
                  >
                    {item.url || 'Invalid URL'}
                  </a>
                </div>
                <div
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${
                    item.online
                      ? 'border-emerald-400/35 bg-emerald-400/10 text-emerald-300'
                      : 'border-rose-400/35 bg-rose-400/10 text-rose-300'
                  }`}
                >
                  {item.online ? 'Online' : 'Offline'}
                </div>
              </div>
              <div className="mt-2 text-xs opacity-70">
                {item.status ? `HTTP ${item.status}` : item.error || 'No response'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </SidebarLayout>
  );
};

export default MoreLinks;
