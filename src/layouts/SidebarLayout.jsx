import { NavLink } from 'react-router-dom';
import { House, Gamepad2, Settings, BellRing, MessageCircle, Link2 } from 'lucide-react';
import { useOptions } from '/src/utils/optionsContext';
import clsx from 'clsx';
import theme from '../styles/theming.module.css';

const sidebarItems = [
  { to: '/', label: 'Home', icon: House, exact: true },
  { to: '/docs', label: 'Games', icon: Gamepad2 },
  { to: '/more-links', label: 'More Links', icon: Link2 },
  { to: '/chat-rooms', label: 'Chat Rooms', icon: MessageCircle },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/updates', label: 'Updates', icon: BellRing },
];

const SidebarLayout = ({ children }) => {
  const { options } = useOptions();

  return (
    <div className="flex min-h-screen w-full">
      <aside
        className="w-[4.5rem] shrink-0 border-r border-white/10 px-2 py-4"
        style={{ backgroundColor: options.settingsContainerColor || '#21090b' }}
      >
        <div className="mb-6 flex justify-center">
          <img src="/icon.svg" alt="Toro" className="h-8 w-8 rounded-md" />
        </div>

        <nav className="flex flex-col items-center gap-2">
          {sidebarItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.exact}
                className={({ isActive }) =>
                  clsx(
                    'group relative flex h-11 w-11 items-center justify-center rounded-xl transition-all duration-200',
                    theme.glassIconButton,
                    isActive
                      ? 'scale-105 shadow-[0_0_16px_rgba(255,255,255,0.08)]'
                      : 'hover:scale-105',
                  )
                }
              >
                <Icon size={18} />
                <span className="pointer-events-none absolute left-14 z-30 scale-95 rounded-md border border-white/10 bg-black/80 px-2 py-1 text-xs opacity-0 transition-all duration-200 group-hover:scale-100 group-hover:opacity-100">
                  {item.label}
                </span>
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