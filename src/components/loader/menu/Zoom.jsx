import clsx from 'clsx';
import { Plus, Minus } from 'lucide-react';
import { useCallback } from 'react';
import loaderStore from '/src/utils/hooks/loader/useLoaderStore';
import { useOptions } from '/src/utils/optionsContext';
import theme from '/src/styles/theming.module.css';

const Zoom = () => {
  const { tabs, zoomLevels, setZoom, resetZoom } = loaderStore();
  const activeFrameRef = loaderStore((state) => state.activeFrameRef);
  const { options } = useOptions();

  const actab = tabs.find((tab) => tab.active);
  const currentz = actab ? zoomLevels[actab.id] || 100 : 100;
  const isNewTab = actab?.url === 'tabs://new';
  const canZoom = actab && !isNewTab && activeFrameRef?.current;

  const zIn = useCallback(() => {
    canZoom && currentz < 200 && setZoom(actab.id, Math.min(currentz + 10, 200), activeFrameRef);
  }, [canZoom, actab, currentz, setZoom, activeFrameRef]);

  const zout = useCallback(() => {
    canZoom && currentz > 50 && setZoom(actab.id, Math.max(currentz - 10, 50), activeFrameRef);
  }, [canZoom, actab, currentz, setZoom, activeFrameRef]);

  const ressetLvl = useCallback(() => {
    canZoom && resetZoom(actab.id, activeFrameRef);
  }, [canZoom, actab, resetZoom, activeFrameRef]);

  return (
    <div className="w-full flex justify-between items-center px-3 py-2">
      <span className={clsx('text-[0.8rem]', !canZoom ? 'opacity-50' : undefined)}>Zoom</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={zout}
          disabled={!canZoom || currentz <= 50}
          className={clsx(
            'w-6 h-6 rounded flex items-center justify-center',
            theme.glassIconButton,
            !canZoom || currentz <= 50 ? 'opacity-50 cursor-not-allowed' : '',
          )}
        >
          <Minus size={14} />
        </button>
        <button
          type="button"
          onClick={ressetLvl}
          disabled={!canZoom}
          className={clsx(
            'text-[0.75rem] min-w-[3rem] text-center px-2 py-0.5 rounded',
            theme.glassButton,
            !canZoom ? 'opacity-50 cursor-not-allowed' : '',
          )}
        >
          {currentz}%
        </button>
        <button
          type="button"
          onClick={zIn}
          disabled={!canZoom || currentz >= 200}
          className={clsx(
            'w-6 h-6 rounded flex items-center justify-center',
            theme.glassIconButton,
            !canZoom || currentz >= 200 ? 'opacity-50 cursor-not-allowed' : '',
          )}
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
};

export default Zoom;
