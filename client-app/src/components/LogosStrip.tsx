import { Stethoscope, Scale, Home, Wrench, Smile, Building2, HeadphonesIcon, Truck } from 'lucide-react';

const logos = [
  { name: 'Lakewood Family Medicine', icon: Stethoscope },
  { name: 'Park & Associates Law', icon: Scale },
  { name: 'Pinnacle Realty Group', icon: Home },
  { name: 'Comfort First HVAC', icon: Wrench },
  { name: 'Bright Smile Dental', icon: Smile },
  { name: 'Parkview Properties', icon: Building2 },
  { name: 'Westside Support Co.', icon: HeadphonesIcon },
  { name: 'Apex Logistics', icon: Truck },
];

interface LogosStripProps {
  variant?: 'light' | 'dark';
  title?: string;
}

export default function LogosStrip({ variant = 'light', title = 'Trusted by businesses in your industry' }: LogosStripProps) {
  const isDark = variant === 'dark';
  return (
    <div className={isDark ? 'text-white' : 'text-text-primary'}>
      {title && (
        <p className={`text-center text-xs uppercase tracking-wider font-semibold mb-6 ${isDark ? 'text-white/40' : 'text-text-primary/40'}`}>
          {title}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-5">
        {logos.map((l) => (
          <div key={l.name} className={`flex items-center gap-2 ${isDark ? 'opacity-60' : 'opacity-50'} hover:opacity-100 transition-opacity`}>
            <l.icon className={`h-4 w-4 ${isDark ? 'text-white' : 'text-text-primary'}`} />
            <span className={`text-xs font-display font-semibold tracking-wide ${isDark ? 'text-white' : 'text-text-primary'}`}>{l.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
