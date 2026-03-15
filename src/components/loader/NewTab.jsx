import Search from '../SearchContainer';
import QuickLinks from '../QuickLinks';
import { useNavigate } from 'react-router-dom';
import { House, Gamepad2, Settings, BellRing } from 'lucide-react';

import { process } from '/src/utils/hooks/loader/utils';

const NewTab = ({ id, updateFn, options = {} }) => {
  const navigate = useNavigate();
  const navigating = {
    id: id,
    go: updateFn,
    process: (input) => process(input, false, options.prType || 'auto', options.engine || undefined),
  };

  const links = [
    { label: 'Home', icon: House, action: () => {} },
    { label: 'Games', icon: Gamepad2, action: () => navigate('/docs') },
    { label: 'Settings', icon: Settings, action: () => navigate('/settings') },
    { label: 'Updates', icon: BellRing, action: () => navigate('/updates') },
  ];

  return (
    <div className="h-[calc(100%-100px)] w-full flex p-6 gap-6">
      <aside className="w-[4.5rem] shrink-0 rounded-2xl border border-white/10 bg-black/30 p-2">
        <div className="flex justify-center pb-3 pt-1">
          <img src="/icon.svg" alt="Toro" className="h-8 w-8 rounded-md" />
        </div>
        <div className="flex flex-col items-center gap-2">
          {links.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                onClick={item.action}
                className="group relative flex h-11 w-11 items-center justify-center rounded-xl text-left text-sm hover:bg-white/10 hover:scale-105 transition-all duration-200"
              >
                <Icon size={16} />
                <span className="pointer-events-none absolute left-14 z-30 scale-95 rounded-md border border-white/10 bg-black/80 px-2 py-1 text-xs opacity-0 transition-all duration-200 group-hover:scale-100 group-hover:opacity-100">
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col items-center justify-center">
        <div className="w-full max-w-3xl">
          <Search nav={false} logo={false} cls="w-full relative z-10" navigating={navigating} />
          <QuickLinks cls="mt-8" nav={false} navigating={navigating} />
        </div>
      </div>
    </div>
  );
};

export default NewTab;
