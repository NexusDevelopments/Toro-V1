import { useState, useCallback } from 'react';
import { useOptions } from '/src/utils/optionsContext';
import SidebarLayout from '../layouts/SidebarLayout';

const Settings = () => {
  const { options, updateOption } = useOptions();
  const [panicEnabled, setPanicEnabled] = useState(!!options.panicToggleEnabled);
  const [panicKey, setPanicKey] = useState(options.panic?.key || '');

  const savePanic = useCallback(
    (enabled = panicEnabled, key = panicKey) => {
      updateOption(
        {
          panicToggleEnabled: enabled,
          panic: {
            key,
            url: 'https://www.clever.com',
          },
        },
        true,
      );
      import('/src/utils/utils.js').then(({ panic }) => panic());
    },
    [panicEnabled, panicKey, updateOption],
  );

  const onCaptureKey = useCallback(
    (e) => {
      e.preventDefault();
      const combo = [];
      if (e.ctrlKey) combo.push('Ctrl');
      if (e.altKey) combo.push('Alt');
      if (e.shiftKey) combo.push('Shift');
      if (e.metaKey) combo.push('Meta');
      const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) combo.push(key);
      const finalKey = combo.join('+');
      if (!finalKey) return;
      setPanicKey(finalKey);
      savePanic(panicEnabled, finalKey);
    },
    [panicEnabled, savePanic],
  );

  return (
    <SidebarLayout>
      <div className="mx-auto mt-10 w-full max-w-2xl px-6">
        <h2 className="text-2xl font-semibold">Panic Button</h2>
        <p className="mt-2 text-sm opacity-75">
          Configure a key combo to instantly redirect to Clever.
        </p>

        <div className="mt-6 rounded-2xl border border-white/10 bg-black/25 p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable Panic Redirect</p>
              <p className="text-xs opacity-70">Redirect target: https://www.clever.com</p>
            </div>
            <button
              onClick={() => {
                const next = !panicEnabled;
                setPanicEnabled(next);
                savePanic(next, panicKey);
              }}
              className="rounded-lg border border-white/20 px-3 py-1.5 text-sm hover:bg-white/10 transition-colors"
            >
              {panicEnabled ? 'On' : 'Off'}
            </button>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-white/10 bg-black/25 p-5">
          <p className="text-sm font-medium">Panic Key Combo</p>
          <p className="mt-1 text-xs opacity-70">Click below, then press your key combination.</p>

          <input
            className="mt-3 w-full rounded-lg border border-white/20 bg-black/30 px-3 py-2 text-sm outline-none"
            value={panicKey}
            onKeyDown={onCaptureKey}
            onChange={() => {}}
            placeholder="Press a key combo (e.g. Ctrl+Shift+P)"
          />
        </div>
      </div>
    </SidebarLayout>
  );
};

export default Settings;
