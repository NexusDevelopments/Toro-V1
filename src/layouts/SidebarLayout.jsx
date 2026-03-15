import { NavLink } from 'react-router-dom';
import { House, Gamepad2, Settings, BellRing } from 'lucide-react';
import { useOptions } from '/src/utils/optionsContext';
import clsx from 'clsx';

const sidebarItems = [
  { to: '/', label: 'Home', icon: House, exact: true },
  { to: '/docs', label: 'Games', icon: Gamepad2 },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/updates', label: 'Updates', icon: BellRing },
];

const SidebarLayout = ({ children, title = 'Toro V1' }) => {
  const { options } = useOptions();

  return (
    <div className="flex min-h-screen w-full">
      <aside
        className="w-64 shrink-0 border-r border-white/10 px-4 py-6"
        style={{ backgroundColor: options.settingsContainerColor || '#21090b' }}
      >
        <div className="mb-8 px-2">
          <h1 className="text-xl font-semibold tracking-wide">{title}</h1>
          <p className="text-xs opacity-70 mt-1">Navigation</p>
        </div>

        <nav className="flex flex-col gap-2">
          {sidebarItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.exact}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors',
                    isActive ? 'bg-white/15' : 'hover:bg-white/8',
                  )
                }
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </aside>

      <main className="min-h-screen min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
};

export default SidebarLayout;