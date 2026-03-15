import Routing from './Routing';
import ReactGA from 'react-ga4';
import lazyLoad from './lazyWrapper';
import NotFound from './pages/NotFound';
import { useEffect, useMemo, memo } from 'react';
import { useLocation } from 'react-router-dom';
import { OptionsProvider, useOptions } from './utils/optionsContext';
import { initPreload } from './utils/preload';
import { designConfig as bgDesign } from './utils/config';
import useReg from './utils/hooks/loader/useReg';
import './index.css';
import 'nprogress/nprogress.css';

const importHome = () => import('./pages/Home');
const importApps = () => import('./pages/Apps');
const importGms = () => import('./pages/Apps2');
const importSettings = () => import('./pages/Settings');
const importUpdates = () => import('./pages/Updates');
const importSearchPage = () => import('./pages/SearchPage');

const Home = lazyLoad(importHome);
const Apps = lazyLoad(importApps);
const Apps2 = lazyLoad(importGms);
const Settings = lazyLoad(importSettings);
const Updates = lazyLoad(importUpdates);
const SearchPage = lazyLoad(importSearchPage);
const Player = lazyLoad(() => import('./pages/Player'));

initPreload('/materials', importApps);
initPreload('/docs', importGms);
initPreload('/settings', importSettings);
initPreload('/updates', importUpdates);
initPreload('/search', importSearchPage);
initPreload('/', importHome);

function useTracking() {
  const location = useLocation();

  useEffect(() => {
    ReactGA.send({ hitType: 'pageview', page: location.pathname });
  }, [location]);
}

const ThemedApp = memo(() => {
  const { options } = useOptions();
  useReg();
  useTracking();

  const pages = useMemo(
    () => [
      { path: '/', element: <Home /> },
      { path: '/materials', element: <Apps /> },
      { path: '/docs', element: <Apps2 /> },
      { path: '/docs/r', element: <Player /> },
      { path: '/search', element: <SearchPage />},
      { path: '/settings', element: <Settings /> },
      { path: '/updates', element: <Updates /> },
      { path: '/portal/k12/*', element: <NotFound /> },
      { path: '/ham/*', element: <NotFound /> },
      { path: '*', element: <NotFound /> },
    ],
    [],
  );

  const backgroundStyle = useMemo(() => {
    const bgDesignConfig =
      options.bgDesign === 'None'
        ? 'none'
        : (
            bgDesign.find((d) => d.value.bgDesign === options.bgDesign) || bgDesign[0]
          ).value.getCSS?.(options.bgDesignColor || '102, 105, 109') || 'none';
    const lineColor = options.bgDesignColor || '95, 15, 24';

    return `
      body {
        color: ${options.siteTextColor || '#a0b0c8'};
        background-image: ${bgDesignConfig};
        background-color: ${options.bgColor || '#111827'};
        position: relative;
        overflow-x: hidden;
      }

      body::before,
      body::after {
        content: '';
        position: fixed;
        inset: 0;
        pointer-events: none;
        z-index: 0;
      }

      body::before {
        background:
          repeating-linear-gradient(
            115deg,
            rgba(${lineColor}, 0.18) 0px,
            rgba(${lineColor}, 0.18) 1px,
            transparent 1px,
            transparent 22px
          ),
          radial-gradient(circle at 20% 20%, rgba(${lineColor}, 0.16), transparent 40%),
          radial-gradient(circle at 85% 80%, rgba(${lineColor}, 0.11), transparent 42%);
        background-size: 320px 320px, 100% 100%, 100% 100%;
        animation: bgLinesShift 26s linear infinite;
        opacity: 0.85;
      }

      body::after {
        background:
          repeating-linear-gradient(
            -30deg,
            rgba(255, 255, 255, 0.05) 0px,
            rgba(255, 255, 255, 0.05) 1px,
            transparent 1px,
            transparent 34px
          );
        background-size: 420px 420px;
        animation: bgLinesDrift 38s linear infinite reverse;
        opacity: 0.5;
      }

      #root {
        position: relative;
        z-index: 1;
      }

      @keyframes bgLinesShift {
        0% {
          background-position: 0 0, 0 0, 0 0;
        }
        100% {
          background-position: 460px -360px, 0 0, 0 0;
        }
      }

      @keyframes bgLinesDrift {
        0% {
          background-position: 0 0;
        }
        100% {
          background-position: -520px 480px;
        }
      }
    `;
  }, [options.siteTextColor, options.bgDesign, options.bgDesignColor, options.bgColor]);

  return (
    <>
      <Routing pages={pages} />
      <style>{backgroundStyle}</style>
    </>
  );
});

ThemedApp.displayName = 'ThemedApp';

const App = () => (
  <OptionsProvider>
    <ThemedApp />
  </OptionsProvider>
);

export default App;
