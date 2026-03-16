import Tabs from '/src/components/loader/Tabs';
import Omnibox from '/src/components/loader/Omnibox';
import Viewer from '/src/components/loader/Viewer';
import Menu from '/src/components/loader/Menu';
import loaderStore from '/src/utils/hooks/loader/useLoaderStore';
import { process } from '/src/utils/hooks/loader/utils';
import { useOptions } from '../utils/optionsContext';
import { useEffect } from 'react';

export default function Loader({ config = {} }) {
  const { url, ui = true, zoom, alerts = false } = config;
  const { options } = useOptions();
  const updateUrl = loaderStore((state) => state.updateUrl);
  const barStyle = {
    backgroundColor: options.barColor || '#09121e',
  };

  useEffect(() => {
    // Reset loader store first so URL updates target the fresh default tab.
    loaderStore.getState().clearStore({ showTb: options.showTb ?? true });
  }, []);

  useEffect(() => {
    if (!url) return;

    const processedUrl = process(url, false, options.prType || 'auto', options.engine || null);
    if (!processedUrl) return;

    const firstTab = loaderStore.getState().tabs?.[0];
    if (!firstTab || firstTab.url === processedUrl) return;

    updateUrl(firstTab.id, processedUrl);
  }, [url, updateUrl, options.prType, options.engine]);

  return (
    <div className="flex flex-col w-full h-screen">
      {ui && (
        <>
          <div 
            className="flex flex-col w-full" 
            style={barStyle}
            onClick={() => loaderStore.getState().showMenu && loaderStore.getState().toggleMenu()}
          >
            <Tabs />
            <Omnibox />
          </div>
          <Menu />
        </>
      )}
      <div 
        className="flex-1 w-full"
        onClick={() => loaderStore.getState().showMenu && loaderStore.getState().toggleMenu()}
      >
        <Viewer conf={{ zoom: zoom, alerts: alerts }} />
      </div>
    </div>
  );
}
