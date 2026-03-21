import { useMemo, useState, useCallback } from 'react';
import { useOptions } from '/src/utils/optionsContext';
import SidebarLayout from '../layouts/SidebarLayout';
import clsx from 'clsx';
import { themeConfig, meta, appsPerPageConfig } from '/src/utils/config';

const PERFORMANCE_PRESETS = {
  fast: {
    particleEffects: false,
    mouseHighlightTracking: false,
    animationsEnabled: false,
    glowEffects: false,
    backdropBlur: false,
    hoverTransforms: false,
  },
  normal: {
    particleEffects: true,
    mouseHighlightTracking: true,
    animationsEnabled: true,
    glowEffects: true,
    backdropBlur: true,
    hoverTransforms: true,
  },
  fancy: {
    particleEffects: true,
    mouseHighlightTracking: true,
    animationsEnabled: true,
    glowEffects: true,
    backdropBlur: true,
    hoverTransforms: true,
  },
};

const THEME_CHOICES = [
  { id: 'Toro Red', label: 'Midnight Amber', desc: 'Warm neon amber accents on deep black.' },
  { id: 'Stellar', label: 'Midnight Blueberry', desc: 'Cold blue highlights with night contrast.' },
  { id: 'Mocha', label: 'Midnight Grape', desc: 'Muted plum tones for softer night mode.' },
];

const SETTING_TABS = ['Appearance', 'Cloaking', 'Legal', 'Misc'];

const getThemeByOption = (option) => themeConfig.find((t) => t.option === option) || themeConfig[0];
const getLightTheme = () => themeConfig.find((t) => t.value?.type === 'light') || themeConfig[0];

const ToggleRow = ({ title, desc, enabled, onToggle }) => (
  <div className="flex items-center justify-between rounded-xl border border-red-500/20 bg-black/20 px-4 py-3">
    <div>
      <p className="text-sm font-semibold text-[#ff8d4d]">{title}</p>
      <p className="text-xs text-white/65">{desc}</p>
    </div>
    <button
      type="button"
      onClick={onToggle}
      className={clsx(
        'relative h-7 w-14 rounded-full border transition',
        enabled
          ? 'border-[#ff8d4d]/65 bg-[#4a1a0d]'
          : 'border-white/20 bg-black/35',
      )}
    >
      <span
        className={clsx(
          'absolute top-[3px] h-5 w-5 rounded-full bg-[#ff8d4d] transition-all',
          enabled ? 'left-[33px]' : 'left-[3px]',
        )}
      />
    </button>
  </div>
);

const Settings = () => {
  const { options, updateOption } = useOptions();
  const [activeTab, setActiveTab] = useState('Appearance');
  const [panicEnabled, setPanicEnabled] = useState(!!options.panicToggleEnabled);
  const [panicKey, setPanicKey] = useState(options.panic?.key || '');

  const selectedThemeOption = useMemo(() => {
    return options.preferredDarkTheme || themeConfig.find((t) => t.value?.themeName === options.themeName)?.option || 'Toro Red';
  }, [options.preferredDarkTheme, options.themeName]);

  const darkModeEnabled = options.darkMode ?? (options.type !== 'light');

  const performanceState = {
    preset: options.performancePreset || 'normal',
    particleEffects: options.particleEffects ?? true,
    mouseHighlightTracking: options.mouseHighlightTracking ?? true,
    animationsEnabled: options.animationsEnabled ?? true,
    glowEffects: options.glowEffects ?? true,
    backdropBlur: options.backdropBlur ?? true,
    hoverTransforms: options.hoverTransforms ?? true,
  };

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

  const applyDarkTheme = useCallback(
    (themeOption) => {
      const chosen = getThemeByOption(themeOption);
      updateOption({
        ...chosen.value,
        darkMode: true,
        preferredDarkTheme: chosen.option,
      }, true);
    },
    [updateOption],
  );

  const setDarkMode = useCallback(
    (enabled) => {
      if (enabled) {
        applyDarkTheme(selectedThemeOption);
        return;
      }

      const light = getLightTheme();
      updateOption({ ...light.value, darkMode: false }, true);
    },
    [applyDarkTheme, selectedThemeOption, updateOption],
  );

  const setPerformancePreset = useCallback(
    (preset) => {
      const values = PERFORMANCE_PRESETS[preset] || PERFORMANCE_PRESETS.normal;
      updateOption({ performancePreset: preset, ...values }, true);
    },
    [updateOption],
  );

  const setPerformanceFlag = useCallback(
    (key, value) => {
      updateOption({ [key]: value, performancePreset: 'custom' }, true);
    },
    [updateOption],
  );

  const setSearchEngine = useCallback(
    (engineType) => {
      if (engineType === 'google') {
        updateOption(
          {
            engineName: 'Google',
            engine: 'https://www.google.com/search?safe=off&q=',
            engineIcon:
              'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3c/Google_Favicon_2025.svg/120px-Google_Favicon_2025.svg.png',
          },
          true,
        );
        return;
      }

      updateOption(
        {
          engineName: 'DuckDuckGo',
          engine: 'https://duckduckgo.com/?q=',
          engineIcon: 'https://duckduckgo.com/favicon.ico',
        },
        true,
      );
    },
    [updateOption],
  );

  const selectedEngine = options.engineName === 'Google' ? 'google' : 'duckduckgo';
  const currentMeta = meta.find((c) => c.value?.tabName === options.tabName)?.option || 'Default';
  const currentAppsPerPage = options.itemsPerPage ?? 20;

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
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        <h1 className="text-4xl font-semibold text-[#ff5a0f]">Settings</h1>

        <div className="mt-4 flex w-full flex-wrap gap-2">
          {SETTING_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={clsx(
                'rounded-xl border px-4 py-2 text-sm font-semibold transition',
                activeTab === tab
                  ? 'border-[#ff8d4d]/70 bg-gradient-to-b from-[#ff7f2d]/30 to-[#301008] text-[#ffd7bf]'
                  : 'border-red-500/20 bg-black/25 text-white/70 hover:border-red-400/35',
              )}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="mt-5 rounded-2xl border border-red-500/20 bg-gradient-to-b from-[#1b0905]/90 to-[#0e0402]/90 p-5">
          {activeTab === 'Appearance' && (
            <div className="space-y-5">
              <div>
                <p className="text-lg font-semibold text-[#ff8d4d]">Theme</p>
                <p className="mt-1 text-xs text-white/65">Choose a visual theme for the interface.</p>
                <div className="mt-3 space-y-2">
                  {THEME_CHOICES.map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      onClick={() => applyDarkTheme(choice.id)}
                      className={clsx(
                        'w-full rounded-xl border px-3 py-2 text-left',
                        selectedThemeOption === choice.id && darkModeEnabled
                          ? 'border-[#ff7f2d]/65 bg-[#251008] text-[#ffd6bd]'
                          : 'border-red-500/20 bg-black/25 text-white/80 hover:border-red-300/40',
                      )}
                    >
                      <p className="text-sm font-semibold">{choice.label}</p>
                      <p className="text-xs text-white/60">{choice.desc}</p>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-lg font-semibold text-[#ff8d4d]">Dark/Light Mode</p>
                <p className="mt-1 text-xs text-white/65">Toggle the global color scheme between dark and light.</p>
                <div className="mt-3">
                  <ToggleRow
                    title={darkModeEnabled ? 'Dark Mode' : 'Light Mode'}
                    desc="When disabled, the interface uses a light color theme."
                    enabled={darkModeEnabled}
                    onToggle={() => setDarkMode(!darkModeEnabled)}
                  />
                </div>
              </div>

              <div>
                <p className="text-lg font-semibold text-[#ff8d4d]">Performance</p>
                <p className="mt-1 text-xs text-white/65">Choose a preset or tune each visual feature manually.</p>
                <div className="mt-3 grid gap-2 md:grid-cols-3">
                  {[
                    { id: 'fast', title: 'Fast', desc: 'Minimal visuals for max speed' },
                    { id: 'normal', title: 'Normal', desc: 'Balanced visuals and speed' },
                    { id: 'fancy', title: 'Fancy', desc: 'Full effects for premium look' },
                  ].map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => setPerformancePreset(preset.id)}
                      className={clsx(
                        'rounded-xl border p-3 text-left',
                        performanceState.preset === preset.id
                          ? 'border-[#ff7f2d]/65 bg-[#251008]'
                          : 'border-red-500/20 bg-black/25 hover:border-red-300/40',
                      )}
                    >
                      <p className="text-sm font-semibold text-[#ff9b66]">{preset.title}</p>
                      <p className="text-xs text-white/60">{preset.desc}</p>
                    </button>
                  ))}
                </div>

                <div className="mt-4 space-y-2">
                  <ToggleRow
                    title="Particle Effects"
                    desc="Animated particles in the background network."
                    enabled={performanceState.particleEffects}
                    onToggle={() => setPerformanceFlag('particleEffects', !performanceState.particleEffects)}
                  />
                  <ToggleRow
                    title="Mouse Highlight Tracking"
                    desc="Interactive glow and network reaction around your cursor."
                    enabled={performanceState.mouseHighlightTracking}
                    onToggle={() => setPerformanceFlag('mouseHighlightTracking', !performanceState.mouseHighlightTracking)}
                  />
                  <ToggleRow
                    title="Animations"
                    desc="Page transitions and animation effects."
                    enabled={performanceState.animationsEnabled}
                    onToggle={() => setPerformanceFlag('animationsEnabled', !performanceState.animationsEnabled)}
                  />
                  <ToggleRow
                    title="Glow Effects"
                    desc="Illuminated hover and accent glows across UI elements."
                    enabled={performanceState.glowEffects}
                    onToggle={() => setPerformanceFlag('glowEffects', !performanceState.glowEffects)}
                  />
                  <ToggleRow
                    title="Backdrop Blur"
                    desc="Frosted blur on glass-style surfaces."
                    enabled={performanceState.backdropBlur}
                    onToggle={() => setPerformanceFlag('backdropBlur', !performanceState.backdropBlur)}
                  />
                  <ToggleRow
                    title="Hover Transforms"
                    desc="Scale and lift effects on hover interactions."
                    enabled={performanceState.hoverTransforms}
                    onToggle={() => setPerformanceFlag('hoverTransforms', !performanceState.hoverTransforms)}
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'Cloaking' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-red-500/20 bg-black/20 p-4">
                <p className="text-sm font-semibold text-[#ff8d4d]">Site Cloak</p>
                <p className="mt-1 text-xs text-white/65">Choose the tab title/icon used for cloaking.</p>
                <select
                  value={currentMeta}
                  onChange={(e) => {
                    const next = meta.find((m) => m.option === e.target.value) || meta[0];
                    updateOption(next.value, true);
                    import('/src/utils/utils.js').then(({ ckOff }) => ckOff());
                  }}
                  className="mt-3 w-full rounded-lg border border-red-500/25 bg-black/35 px-3 py-2 text-sm outline-none"
                >
                  {meta.map((item) => (
                    <option key={item.option} value={item.option}>
                      {item.option}
                    </option>
                  ))}
                </select>
              </div>

              <ToggleRow
                title="Auto Cloak"
                desc="Apply selected cloak when tab is unfocused, restore on focus."
                enabled={!!options.clkOff}
                onToggle={() => {
                  updateOption({ clkOff: !options.clkOff }, true);
                  import('/src/utils/utils.js').then(({ ckOff }) => ckOff());
                }}
              />

              <ToggleRow
                title="Open about:blank on startup"
                desc="Open the current site in about:blank automatically."
                enabled={options.aboutBlankAutoOpen === true || (options.aboutBlank && options.aboutBlankAutoOpen !== false)}
                onToggle={() => {
                  const current = options.aboutBlankAutoOpen === true || (options.aboutBlank && options.aboutBlankAutoOpen !== false);
                  updateOption({ aboutBlankAutoOpen: !current }, true);
                }}
              />

              <ToggleRow
                title="Panic Redirect"
                desc="Emergency key combo that redirects to Clever instantly."
                enabled={panicEnabled}
                onToggle={() => {
                  const next = !panicEnabled;
                  setPanicEnabled(next);
                  savePanic(next, panicKey);
                }}
              />

              <div className="rounded-xl border border-red-500/20 bg-black/20 p-4">
                <p className="text-sm font-semibold text-[#ff8d4d]">Panic Shortcut</p>
                <p className="mt-1 text-xs text-white/65">Click below and press your desired key combo.</p>
                <input
                  className="mt-3 w-full rounded-lg border border-red-500/25 bg-black/35 px-3 py-2 text-sm outline-none"
                  value={panicKey}
                  onKeyDown={onCaptureKey}
                  onChange={() => {}}
                  placeholder="Ctrl+Shift+P"
                />
              </div>
            </div>
          )}

          {activeTab === 'Legal' && (
            <div className="space-y-3">
              <div className="rounded-xl border border-red-500/20 bg-black/20 p-4">
                <p className="text-sm font-semibold text-[#ff8d4d]">Terms</p>
                <p className="mt-1 text-xs text-white/65">Use responsibly. This project is provided as-is without warranties.</p>
              </div>
              <div className="rounded-xl border border-red-500/20 bg-black/20 p-4">
                <p className="text-sm font-semibold text-[#ff8d4d]">Privacy</p>
                <p className="mt-1 text-xs text-white/65">Most settings are stored locally in your browser. Avoid sharing sensitive data in chat.</p>
              </div>
              <div className="rounded-xl border border-red-500/20 bg-black/20 p-4">
                <p className="text-sm font-semibold text-[#ff8d4d]">Content</p>
                <p className="mt-1 text-xs text-white/65">You are responsible for how you use links, embedded services, and external content.</p>
              </div>
            </div>
          )}

          {activeTab === 'Misc' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-red-500/20 bg-black/20 p-4">
                <p className="text-sm font-semibold text-[#ff8d4d]">Search Engine</p>
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => setSearchEngine('duckduckgo')}
                    className={clsx(
                      'rounded-lg border px-3 py-1.5 text-sm',
                      selectedEngine === 'duckduckgo' ? 'border-[#ff8d4d]/60 bg-[#2a1009]' : 'border-red-500/20 bg-black/25',
                    )}
                  >
                    DuckDuckGo
                  </button>
                  <button
                    onClick={() => setSearchEngine('google')}
                    className={clsx(
                      'rounded-lg border px-3 py-1.5 text-sm',
                      selectedEngine === 'google' ? 'border-[#ff8d4d]/60 bg-[#2a1009]' : 'border-red-500/20 bg-black/25',
                    )}
                  >
                    Google
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-red-500/20 bg-black/20 p-4">
                <p className="text-sm font-semibold text-[#ff8d4d]">Apps Per Page</p>
                <select
                  value={String(currentAppsPerPage)}
                  onChange={(e) => {
                    const selected = appsPerPageConfig.find((c) => String(c.value.itemsPerPage) === e.target.value) || appsPerPageConfig[2];
                    updateOption(selected.value, true);
                  }}
                  className="mt-3 w-full rounded-lg border border-red-500/25 bg-black/35 px-3 py-2 text-sm outline-none"
                >
                  {appsPerPageConfig.map((item) => (
                    <option key={item.option} value={String(item.value.itemsPerPage)}>
                      {item.option}
                    </option>
                  ))}
                </select>
              </div>

              <div className="rounded-xl border border-red-500/20 bg-black/20 p-4">
                <p className="text-sm font-semibold text-[#ff8d4d]">Reset Instance</p>
                <p className="mt-1 text-xs text-white/65">Clear local data if you are troubleshooting a bad state.</p>
                <button
                  type="button"
                  className="mt-3 rounded-lg border border-red-300/35 bg-[#2b110a] px-3 py-1.5 text-sm text-[#ffb08a]"
                  onClick={() => import('/src/utils/utils.js').then(({ resetInstance }) => resetInstance())}
                >
                  Reset Data
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </SidebarLayout>
  );
};

export default Settings;
