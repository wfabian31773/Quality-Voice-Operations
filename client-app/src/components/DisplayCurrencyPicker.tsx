import { ChevronDown, Globe } from 'lucide-react';
import { DISPLAY_CURRENCIES, useDisplayCurrency } from '../lib/displayCurrency';

export interface DisplayCurrencyPickerProps {
  className?: string;
  testId?: string;
  ariaLabel?: string;
}

export default function DisplayCurrencyPicker({
  className,
  testId = 'display-currency-picker',
  ariaLabel = 'Display currency',
}: DisplayCurrencyPickerProps) {
  const [code, setCode] = useDisplayCurrency();

  return (
    <label
      className={`inline-flex items-center gap-2 text-xs font-body text-text-primary/70 ${className ?? ''}`}
    >
      <Globe className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{ariaLabel}</span>
      <span className="relative inline-flex items-center">
        <select
          data-testid={testId}
          aria-label={ariaLabel}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="appearance-none bg-surface border border-border-strong/40 rounded-md pl-2.5 pr-7 py-1.5 text-xs font-display font-semibold text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40 cursor-pointer hover:border-primary/40 transition-colors"
        >
          {DISPLAY_CURRENCIES.map((c) => (
            <option key={c.code} value={c.code}>
              {c.code} — {c.name}
            </option>
          ))}
        </select>
        <ChevronDown
          className="absolute right-1.5 h-3 w-3 text-text-primary/50 pointer-events-none"
          aria-hidden="true"
        />
      </span>
    </label>
  );
}
