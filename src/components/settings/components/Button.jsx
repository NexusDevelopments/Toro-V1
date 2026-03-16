import clsx from 'clsx';
import theme from '/src/styles/theming.module.css';

const Button = ({ value, action, disabled = false, maxW = 40 }) => {
  return (
    <button
      onClick={action}
      className={clsx(
        'rounded-xl border text-[0.9rem] font-medium cursor-pointer',
        'flex items-center justify-center h-10 px-4 transition-opacity duration-150',
        'active:opacity-90',
        theme.glassButton,
        disabled ? 'opacity-60' : undefined,
      )}
      style={{
        maxWidth: `${maxW}rem`,
      }}
    >
      {value}
    </button>
  );
};

export default Button;
