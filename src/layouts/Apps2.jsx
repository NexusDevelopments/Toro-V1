import { useState, useMemo, useEffect, useCallback, memo, lazy, Suspense } from 'react';
import { Search, LayoutGrid, Play } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useOptions } from '/src/utils/optionsContext';
import styles from '../styles/apps.module.css';
import theme from '../styles/theming.module.css';
import clsx from 'clsx';

const Pagination = lazy(() => import('@mui/material/Pagination'));
const GAME_VISITS_STORAGE_KEY = 'gameVisitCounts';

const getGameVisitKey = (app) => {
  const firstUrl = Array.isArray(app?.url) ? app.url[0] : app?.url;
  return `${app?.appName || 'unknown'}::${firstUrl || 'unknown'}`;
};

const readGameVisitCounts = () => {
  if (typeof window === 'undefined') return {};

  try {
    const stored = window.localStorage.getItem(GAME_VISITS_STORAGE_KEY);
    const parsed = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const writeGameVisitCounts = (counts) => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(GAME_VISITS_STORAGE_KEY, JSON.stringify(counts));
  } catch {}
};

const AppCard = memo(({ app, visitCount, onClick, fallbackMap, onImgError, itemTheme, itemStyles }) => {
  const [loaded, setLoaded] = useState(false);
  
  return (
    <div
      key={app.appName}
      className={clsx(
        'flex-shrink-0',
        itemStyles.app,
        itemTheme.appItemColor,
        itemTheme[`theme-${itemTheme.current || 'default'}`],
        app.disabled ? 'disabled cursor-not-allowed' : 'cursor-pointer',
      )}
      onClick={!app.disabled ? () => onClick(app) : undefined}
    >
      <div className="w-20 h-20 rounded-[12px] mb-4 overflow-hidden relative">
        {!loaded && !fallbackMap[app.appName] && (
          <div className="absolute inset-0 bg-gray-700 animate-pulse" />
        )}
        {fallbackMap[app.appName] ? (
          <LayoutGrid className="w-full h-full" />
        ) : (
          <img
            src={app.icon}
            draggable="false"
            loading="lazy"
            className="w-full h-full object-cover"
            onLoad={() => setLoaded(true)}
            onError={() => onImgError(app.appName)}
          />
        )}
      </div>
      <p className="text-m font-semibold mb-3 flex-grow line-clamp-2">{app.appName.split('').join('\u200B')}</p>
      <p className="mb-3 text-xs opacity-70">{visitCount} {visitCount === 1 ? 'visit' : 'visits'}</p>
      <button className={clsx('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium mt-auto self-start', itemTheme.glassButton)}>
        <Play size={16} fill="currentColor" />
        Play
      </button>
    </div>
  );
});

const Games = memo(() => {
  const nav = useNavigate();
  const { options } = useOptions();

  const [data, setData] = useState({});
  useEffect(() => {
    let a = true;
    import('../data/apps.json').then((m) => a && setData(m.default?.games || {}));
    return () => {
      a = false;
    };
  }, []);

  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [fallback, setFallback] = useState({});
  const [dlCount, setDlCount] = useState(0);
  const [filter, setFilter] = useState('all');
  const [dlGames, setDlGames] = useState([]);
  const [visitCounts, setVisitCounts] = useState(() => readGameVisitCounts());

  useEffect(() => {
    const syncVisitCounts = () => setVisitCounts(readGameVisitCounts());

    window.addEventListener('storage', syncVisitCounts);
    return () => window.removeEventListener('storage', syncVisitCounts);
  }, []);

  useEffect(() => {
    import('../utils/localGmLoader').then(async (m) => {
      const loader = new m.default();
      await loader.cleanupOld();
      const gms = await loader.getAllGms();
      setDlCount(gms.length);
      setDlGames(gms);
    }).catch(() => {});
  }, []);

  const perPage = options.itemsPerPage || 20;

  const all = useMemo(() => {
    const games = [];
    Object.values(data).forEach((cats) => {
      games.push(...cats);
    });
    return games;
  }, [data]);

  const filtered = useMemo(() => {
    let toFilter = all;

    if (filter === 'downloaded') {
      const dlNames = new Set(dlGames.map(g => g.name));
      toFilter = all.filter(game => {
        const firstUrl = Array.isArray(game.url) ? game.url[0] : game.url;
        const gmName = firstUrl?.split('/').pop()?.replace('.zip', '');
        return gmName && dlNames.has(gmName);
      });
    }

    if (filter === 'most-played') {
      toFilter = all.filter((game) => (visitCounts[getGameVisitKey(game)] || 0) > 0);
      toFilter = [...toFilter].sort(
        (a, b) => (visitCounts[getGameVisitKey(b)] || 0) - (visitCounts[getGameVisitKey(a)] || 0),
      );
    }

    if (q) {
      const fq = q.toLowerCase().trim().replace(/\s/g, '');
      toFilter = toFilter.filter((game) => {
        const gameName = game.appName.toLowerCase().replace(/\s/g, '');
        return gameName.includes(fq);
      });
    }
    
    const total = Math.ceil(toFilter.length / perPage);
    const paged = toFilter.slice((page - 1) * perPage, page * perPage);
    return { filteredGames: toFilter, paged, totalPages: total };
  }, [all, filter, dlGames, q, page, perPage, visitCounts]);

  useEffect(() => {
    if (page > filtered.totalPages && filtered.totalPages > 0) setPage(1);
  }, [page, filtered.totalPages]);

  const navApp = useCallback(
    (app) => {
      if (!app) return;
      const appKey = getGameVisitKey(app);

      setVisitCounts((prev) => {
        const next = {
          ...prev,
          [appKey]: (prev[appKey] || 0) + 1,
        };

        writeGameVisitCounts(next);
        return next;
      });

      nav('/docs/r/', { state: { app } });
    },
    [nav],
  );

  const handleSearch = useCallback((e) => {
    setQ(e.target.value);
    setPage(1);
  }, []);

  const handleImgError = useCallback(
    (name) => setFallback((prev) => ({ ...prev, [name]: true })),
    [],
  );

  const searchCls = useMemo(
    () => clsx(theme.appsSearchColor, theme[`theme-${options.theme || 'default'}`]),
    [options.theme],
  );

  const placeholder = useMemo(() => `Search ${all.length} games`, [all.length]);

  return (
    <div className={`${styles.appContainer} w-full mx-auto`}>
      <div className="w-full px-4 min-h-[22vh] flex flex-col items-center justify-center gap-3">
        <div
          className={clsx(
            'relative flex items-center gap-3 px-5 w-[min(92vw,700px)] h-14',
            searchCls,
          )}
        >
          <Search className="w-4 h-4 shrink-0" />
          <input
            type="text"
            placeholder={placeholder}
            value={q}
            onChange={handleSearch}
            className="flex-1 bg-transparent outline-none text-sm"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setFilter('all');
              setPage(1);
            }}
            className={clsx(
              'text-xs whitespace-nowrap px-3 py-1.5 rounded-full',
              theme.glassButton,
              theme.glassPill,
              filter === 'all' ? 'border-white/40 bg-white/12' : 'opacity-90',
            )}
          >
            All Games ({all.length})
          </button>
          <button
            onClick={() => {
              setFilter('downloaded');
              setPage(1);
            }}
            className={clsx(
              'text-xs whitespace-nowrap px-3 py-1.5 rounded-full',
              theme.glassButton,
              theme.glassPill,
              filter === 'downloaded' ? 'border-white/40 bg-white/12' : 'opacity-90',
            )}
          >
            Downloaded ({dlCount})
          </button>
          <button
            onClick={() => {
              setFilter('most-played');
              setPage(1);
            }}
            className={clsx(
              'text-xs whitespace-nowrap px-3 py-1.5 rounded-full',
              theme.glassButton,
              theme.glassPill,
              filter === 'most-played' ? 'border-white/40 bg-white/12' : 'opacity-90',
            )}
          >
            Most Played
          </button>
        </div>
      </div>

      {filter === 'downloaded' && (
        <div className="text-center text-xs opacity-60 pb-2">
          Local games not played for 3+ days are automatically removed
        </div>
      )}
      {filter === 'most-played' && (
        <div className="text-center text-xs opacity-60 pb-2">
          Games sorted by your most visited
        </div>
      )}

      <div className="flex flex-wrap justify-center pb-2">
        {filtered.paged.map((game) => (
          <AppCard
            key={game.appName}
            app={game}
            visitCount={visitCounts[getGameVisitKey(game)] || 0}
            onClick={navApp}
            fallbackMap={fallback}
            onImgError={handleImgError}
            itemTheme={{ ...theme, current: options.theme || 'default' }}
            itemStyles={styles}
          />
        ))}
      </div>

      {filtered.filteredGames.length > perPage && (
        <div className="flex flex-col items-center pb-7">
          <Suspense>
            <Pagination
              count={filtered.totalPages}
              page={page}
              onChange={(_, v) => setPage(v)}
              shape="rounded"
              variant="outlined"
              sx={{
                '& .MuiPaginationItem-root': {
                  color: options.paginationTextColor || '#9baec8',
                  borderColor: options.paginationBorderColor || '#ffffff1c',
                  backgroundColor: options.paginationBgColor || '#141d2b',
                  fontFamily: 'SFProText',
                },
                '& .Mui-selected': {
                  backgroundColor: `${options.paginationSelectedColor || '#75b3e8'} !important`,
                  color: '#fff !important',
                },
              }}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
});

Games.displayName = 'Games';

const GamesLayout = () => {
  const { options } = useOptions();
  const scrollCls = clsx(
    'scrollbar scrollbar-thin scrollbar-track-transparent',
    !options?.type || options.type === 'dark'
      ? 'scrollbar-thumb-gray-600'
      : 'scrollbar-thumb-gray-500',
  );

  return (
    <div className={clsx('min-h-screen overflow-y-auto', scrollCls)}>
      <Games />
    </div>
  );
};

export default GamesLayout;
