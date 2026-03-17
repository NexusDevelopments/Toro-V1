import clsx from 'clsx';
import { useNavigate } from 'react-router-dom';
import { useOptions } from '/src/utils/optionsContext';
import { Plus, Bolt, Globe, Pencil, Trash2, CircleX } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import LinkDialog from './NewQuickLink';
import EditLinkDialog from './EditQuickLink';

const QuickLinks = ({ cls, nav = true, navigating }) => {
  const { options, updateOption } = useOptions();
  const navigate = useNavigate();
  const [fallback, setFallback] = useState({});
  const [menuOpen, setMenuOpen] = useState(null);
  const [dialog, setDialog] = useState({ add: false, edit: false, index: null });
  const [shiftHeld, setShiftHeld] = useState(false);
  const menuRef = useRef(null);

  const oldDefaultLinks = [
    { link: 'https://google.com', icon: 'https://google.com/favicon.ico', name: 'Google' },
    { link: 'https://cineby.gd', icon: '/assets/img/fyhn.ico', name: 'Movies' },
    { link: 'https://discord.com', icon: '/assets/img/dsci.ico', name: 'Discord' },
    { link: 'https://github.com', icon: '/assets/img/icogh.ico', name: 'GitHub' },
  ];

  const defaultLinks = [
    { link: 'https://www.youtube.com', icon: 'https://www.youtube.com/favicon.ico', name: 'YouTube' },
    { link: 'https://www.google.com', icon: 'https://www.google.com/favicon.ico', name: 'Google' },
    { link: 'https://github.com', icon: 'https://github.com/favicon.ico', name: 'GitHub' },
    { link: 'https://www.tiktok.com', icon: 'https://www.tiktok.com/favicon.ico', name: 'TikTok' },
    { link: 'https://www.instagram.com', icon: 'https://www.instagram.com/favicon.ico', name: 'Instagram' },
  ];

  const isOldDefaultSet = (links) => {
    if (!Array.isArray(links) || links.length !== oldDefaultLinks.length) return false;
    return links.every((link, idx) => {
      const old = oldDefaultLinks[idx];
      return String(link?.name || '') === old.name && String(link?.link || '') === old.link;
    });
  };

  const [quickLinks, setQuickLinks] = useState(() => {
    try {
      const storedLinks = JSON.parse(localStorage.getItem('options'))?.quickLinks;
      if (!Array.isArray(storedLinks) || storedLinks.length === 0) return defaultLinks;
      return isOldDefaultSet(storedLinks) ? defaultLinks : storedLinks;
    } catch {
      return defaultLinks;
    }
  });

  const go = (url) => {
    if (nav) {
      navigate("/search", {
        state: {
          url: url,
        }
      });
    } else {
      const processedUrl = navigating.process(url);
      if (processedUrl) {
        navigating.go(navigating.id, processedUrl);
      }
    }
  };

  useEffect(() => {
    const close = (e) => !menuRef.current?.contains(e.target) && setMenuOpen(null);
    const down = (e) => e.key === 'Shift' && setShiftHeld(true);
    const up = (e) => e.key === 'Shift' && setShiftHeld(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', down);
    document.addEventListener('keyup', up);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', down);
      document.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(() => updateOption({ quickLinks }), [quickLinks]);

  useEffect(() => {
    setFallback({});
  }, [quickLinks]);

  const linkItem = clsx(
    'flex flex-col items-center justify-center relative group w-[5.1rem] h-[6rem] rounded-2xl border cursor-pointer duration-200 ease-in-out',
    'bg-white/[0.06] border-white/20 backdrop-blur-xl shadow-[0_10px_28px_rgba(0,0,0,0.38),inset_0_1px_0_rgba(255,255,255,0.2)]',
    options.type === 'dark' ? 'border hover:border-[#ffffff1c]' : 'border-2 hover:border-[#4f4f4f1c]',
    'hover:scale-[1.03] hover:border-white/40'
  );
  const linkLogo = 'w-[2.7rem] h-[2.7rem] flex items-center justify-center rounded-full bg-white/15 border border-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]';

  return (
    <div className={clsx('flex flex-wrap justify-center gap-4', cls || 'w-full max-w-[40rem] mx-auto mt-[16rem]')}>
      {quickLinks.map((link, i) => (
        <div key={i} className={linkItem} onClick={() => go(link.link)}>
          <div
            ref={menuOpen === i ? menuRef : null}
            onClick={(e) => {
              e.stopPropagation();
              shiftHeld ? setQuickLinks(quickLinks.filter((_, j) => j !== i)) : setMenuOpen(menuOpen === i ? null : i);
            }}
            className={clsx(
              'absolute -top-2 -right-2 duration-200 ease',
              menuOpen === i ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            {shiftHeld ? <CircleX size="16" className="opacity-70 text-red-500" /> : <Bolt size="16" className="opacity-50" />}
            {menuOpen === i && (
              <div
                className="absolute top-5 right-0 rounded-md shadow-lg border border-white/10 py-1 w-[101px] z-50"
                style={{ backgroundColor: options.quickModalBgColor || '#252f3e' }}
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  onClick={() => setDialog({ add: false, edit: true, index: i }) || setMenuOpen(null)}
                  className="w-full px-3 py-1.5 text-[0.74rem] flex items-center gap-2 hover:bg-white/10 duration-150 text-left"
                >
                  <Pencil size="14" /> Edit
                </button>
                <button
                  onClick={() => setQuickLinks(quickLinks.filter((_, j) => j !== i)) || setMenuOpen(null)}
                  className="w-full px-3 py-1.5 text-[0.74rem] flex items-center gap-2 hover:bg-white/10 duration-150 text-left text-red-400"
                >
                  <Trash2 size="14" /> Remove
                </button>
              </div>
            )}
          </div>

          <div className={linkLogo}>
            {fallback[i] ? (
              <Globe className="w-7 h-7" />
            ) : (
              <img
                key={link.icon}
                src={link.icon}
                alt={link.name}
                className="w-7 h-7 object-contain"
                loading="lazy"
                onError={() => setFallback((p) => ({ ...p, [i]: true }))}
              />
            )}
          </div>
          <div className="mt-3 text-sm font-medium text-center w-full px-1 overflow-hidden whitespace-nowrap text-ellipsis">
            {link.name}
          </div>
        </div>
      ))}

      <div className={linkItem} onClick={() => setDialog({ add: true, edit: false, index: null })}>
        <div className={linkLogo}>
          <Plus className="w-7 h-7" />
        </div>
        <div className="mt-3 text-sm font-medium text-center">New</div>
      </div>

      <LinkDialog state={dialog.add} set={(v) => setDialog({ ...dialog, add: v })} update={(form) => setQuickLinks([...quickLinks, form])} />
      <EditLinkDialog
        state={dialog.edit}
        set={(v) => setDialog({ ...dialog, edit: v })}
        initialData={dialog.index != null ? quickLinks[dialog.index] : null}
        update={(form) => {
          const updated = [...quickLinks];
          updated[dialog.index] = form;
          setQuickLinks(updated);
        }}
      />
    </div>
  );
};

QuickLinks.displayName = 'QuickLinks';
export default QuickLinks;
