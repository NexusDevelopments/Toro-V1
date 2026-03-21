import Routing from './Routing';
import ReactGA from 'react-ga4';
import lazyLoad from './lazyWrapper';
import NotFound from './pages/NotFound';
import { useEffect, useMemo, memo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { OptionsProvider, useOptions } from './utils/optionsContext';
import { initPreload } from './utils/preload';
import useReg from './utils/hooks/loader/useReg';
import InteractiveNetworkBg from './components/InteractiveNetworkBg';
import './index.css';
import 'nprogress/nprogress.css';

const importHome = () => import('./pages/Home');
const importApps = () => import('./pages/Apps');
const importGms = () => import('./pages/Apps2');
const importSettings = () => import('./pages/Settings');
const importUpdates = () => import('./pages/Updates');
const importMoreLinks = () => import('./pages/MoreLinks');
const importSearchPage = () => import('./pages/SearchPage');
const importChatRooms = () => import('./pages/ChatRooms');

const Home = lazyLoad(importHome);
const Apps = lazyLoad(importApps);
const Apps2 = lazyLoad(importGms);
const Settings = lazyLoad(importSettings);
const Updates = lazyLoad(importUpdates);
const MoreLinks = lazyLoad(importMoreLinks);
const SearchPage = lazyLoad(importSearchPage);
const ChatRooms = lazyLoad(importChatRooms);
const Player = lazyLoad(() => import('./pages/Player'));
const BOOT_STEPS = ['Authenticating...', 'Loading Files...', 'Welcome to Toro V2..'];

initPreload('/materials', importApps);
initPreload('/docs', importGms);
initPreload('/settings', importSettings);
initPreload('/updates', importUpdates);
initPreload('/more-links', importMoreLinks);
initPreload('/search', importSearchPage);
initPreload('/chat-rooms', importChatRooms);
initPreload('/', importHome);

function useTracking() {
  const location = useLocation();

  useEffect(() => {
    ReactGA.send({ hitType: 'pageview', page: location.pathname });
  }, [location]);
}

const ThemedApp = memo(() => {
  const { options } = useOptions();
  const [splashVisible, setSplashVisible] = useState(true);
  const [splashClosing, setSplashClosing] = useState(false);
  const [step, setStep] = useState(0);

  useReg();
  useTracking();

  useEffect(() => {
    const t1 = setTimeout(() => setStep(1), 700);
    const t2 = setTimeout(() => setStep(2), 1550);
    const t3 = setTimeout(() => setSplashClosing(true), 2450);
    const t4 = setTimeout(() => setSplashVisible(false), 3000);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, []);

  const pages = useMemo(
    () => [
      { path: '/', element: <Home /> },
      { path: '/materials', element: <Apps /> },
      { path: '/docs', element: <Apps2 /> },
      { path: '/docs/r', element: <Player /> },
      { path: '/search', element: <SearchPage />},
      { path: '/chat-rooms', element: <ChatRooms /> },
      { path: '/more-links', element: <MoreLinks /> },
      { path: '/settings', element: <Settings /> },
      { path: '/updates', element: <Updates /> },
      { path: '/portal/k12/*', element: <NotFound /> },
      { path: '/ham/*', element: <NotFound /> },
      { path: '*', element: <NotFound /> },
    ],
    [],
  );

  const backgroundStyle = useMemo(() => {
    return `
      body {
        color: ${options.siteTextColor || '#a0b0c8'};
        background-image: none;
        background-color: ${options.bgColor || '#090304'};
        position: relative;
        overflow-x: hidden;
      }

      #root {
        position: relative;
        z-index: 1;
      }
    `;
  }, [options.siteTextColor, options.bgColor]);

  return (
    <>
      {splashVisible && (
        <div className={`toro-splash ${splashClosing ? 'is-closing' : ''}`}>
          <div className="toro-splash-card">
            <img src="/icon.svg" alt="Toro" className="toro-splash-logo" />
            <p className="toro-splash-step">{BOOT_STEPS[step]}</p>
            <div className="toro-splash-progress">
              <span className={`toro-splash-progress-bar step-${step + 1}`} />
            </div>
          </div>
        </div>
      )}
      <InteractiveNetworkBg />
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
