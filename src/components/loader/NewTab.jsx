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
      <aside className="w-56 shrink-0 rounded-2xl border border-white/10 bg-black/30 p-3">
        <div className="px-2 pt-1 pb-3 text-sm opacity-75">Toro V1</div>
        <div className="flex flex-col gap-1.5">
          {links.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                onClick={item.action}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm hover:bg-white/10 transition-colors"
              >
                <Icon size={16} />
                {item.label}
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
