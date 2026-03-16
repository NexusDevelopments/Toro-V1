import SidebarLayout from '../layouts/SidebarLayout';
import { useEffect, useState } from 'react';

const Updates = () => {
  const [items, setItems] = useState([
    {
      id: 'fallback-1',
      text: 'DuckDuckGo is now the default search engine, and Settings now lets you switch between DuckDuckGo and Google.',
    },
  ]);

  useEffect(() => {
    let active = true;
    fetch('/api/updates')
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => {
        if (!active || !Array.isArray(data) || data.length === 0) return;
        setItems(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  return (
    <SidebarLayout>
      <div className="max-w-3xl px-8 py-10">
        <h2 className="text-3xl font-semibold">Updates</h2>
        <p className="mt-3 text-sm opacity-75">Latest changes you requested:</p>
        <div className="mt-6 space-y-3">
          {items.map((item) => (
            <div
              key={item.id || item.text}
              className="rounded-xl border border-white/10 bg-black/20 px-4 py-4 text-sm"
            >
              {item.text}
            </div>
          ))}
        </div>
      </div>
    </SidebarLayout>
  );
};

export default Updates;