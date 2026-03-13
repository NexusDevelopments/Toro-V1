import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { themeConfig, meta } from '/src/utils/config';

const OptionsContext = createContext();

const DEFAULT_OPTIONS = {
  ...themeConfig[0].value,
  ...meta[0].value,
};

const getStoredOptions = () => {
  try {
    const stored = JSON.parse(localStorage.getItem('options') || '{}');
    const merged = { ...DEFAULT_OPTIONS, ...stored };
    if (!stored.themeName || stored.themeName === 'defaultTheme') {
      return { ...merged, ...themeConfig[0].value };
    }
    return merged;
  } catch {
    return DEFAULT_OPTIONS;
  }
};

export const OptionsProvider = ({ children }) => {
  const [options, setOptions] = useState(getStoredOptions);

  useEffect(() => {
    try {
      localStorage.setItem('options', JSON.stringify(options));
    } catch {}
  }, [options]);

  const updateOption = useCallback((obj, immediate = true) => {
    if (!obj || typeof obj !== 'object') return;

    const current = getStoredOptions();
    const updated = { ...current, ...obj };

    try {
      localStorage.setItem('options', JSON.stringify(updated));
    } catch {}

    if (immediate) {
      setOptions((prev) => ({ ...prev, ...obj }));
    }
  }, []);

  const contextValue = useMemo(() => ({ options, updateOption }), [options, updateOption]);

  return <OptionsContext.Provider value={contextValue}>{children}</OptionsContext.Provider>;
};

export const useOptions = () => {
  const context = useContext(OptionsContext);
  if (!context) {
    throw new Error('useOptions must be used within an OptionsProvider');
  }
  return context;
};
