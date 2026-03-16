import { Calendar, Check, Clock } from 'lucide-react';

interface CalendarToolVisualProps {
  visible: boolean;
}

const MOCK_SLOTS = [
  { time: '9:00 AM', available: true },
  { time: '10:00 AM', available: false },
  { time: '11:00 AM', available: true },
  { time: '1:00 PM', available: true },
  { time: '2:00 PM', available: false },
  { time: '3:00 PM', available: true },
  { time: '4:00 PM', available: true },
];

const BOOKED_SLOT = '11:00 AM';

function getDayLabels() {
  const today = new Date();
  const labels: { day: string; date: number; isToday: boolean }[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    labels.push({
      day: d.toLocaleDateString('en-US', { weekday: 'short' }),
      date: d.getDate(),
      isToday: i === 0,
    });
  }
  return labels;
}

export default function CalendarToolVisual({ visible }: CalendarToolVisualProps) {
  if (!visible) return null;

  const days = getDayLabels();

  return (
    <div className="bg-white rounded-2xl border border-teal/20 p-6 animate-[fadeSlideIn_0.4s_ease-out]">
      <div className="flex items-center gap-2 mb-4">
        <div className="w-8 h-8 rounded-lg bg-teal/10 flex items-center justify-center">
          <Calendar className="h-4 w-4 text-teal" />
        </div>
        <h3 className="font-display font-semibold text-harbor">Scheduling</h3>
        <span className="ml-auto text-xs text-calm-green font-body flex items-center gap-1">
          <Check className="h-3 w-3" />
          Appointment booked
        </span>
      </div>

      <div className="flex gap-2 mb-4 overflow-x-auto">
        {days.map((d) => (
          <button
            key={d.date}
            className={`flex flex-col items-center px-3 py-2 rounded-lg text-xs font-body transition-colors shrink-0 ${
              d.isToday
                ? 'bg-teal text-white'
                : 'bg-mist text-slate-ink/60 hover:bg-teal/10'
            }`}
          >
            <span className="font-medium">{d.day}</span>
            <span className="text-base font-semibold mt-0.5">{d.date}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {MOCK_SLOTS.map((slot) => {
          const isBooked = slot.time === BOOKED_SLOT;
          return (
            <div
              key={slot.time}
              className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-body transition-all ${
                isBooked
                  ? 'bg-teal text-white ring-2 ring-teal/30'
                  : slot.available
                  ? 'bg-calm-green/10 text-calm-green border border-calm-green/20'
                  : 'bg-soft-steel/20 text-slate-ink/30 line-through'
              }`}
            >
              <Clock className="h-3 w-3" />
              <span>{slot.time}</span>
              {isBooked && <Check className="h-3 w-3" />}
            </div>
          );
        })}
      </div>

      <div className="mt-3 px-3 py-2 bg-teal/5 rounded-lg border border-teal/10">
        <p className="text-xs text-teal font-body">
          Confirmed: Today at {BOOKED_SLOT}
        </p>
      </div>
    </div>
  );
}
