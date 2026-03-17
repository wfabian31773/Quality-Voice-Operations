import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Calendar, Plus, X, ChevronLeft, ChevronRight, Clock, User, CheckCircle2 } from 'lucide-react';

interface Booking {
  id: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  agent_name: string | null;
  notes: string;
  created_at: string;
}

type ViewMode = 'week' | 'month';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  confirmed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  cancelled: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  completed: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  no_show: 'bg-gray-100 text-gray-800 dark:bg-gray-700/30 dark:text-gray-300',
};

function getWeekDays(date: Date): Date[] {
  const start = new Date(date);
  start.setDate(start.getDate() - start.getDay());
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function getMonthDays(date: Date): Date[] {
  const year = date.getFullYear();
  const month = date.getMonth();
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const days: Date[] = [];
  for (let i = -startOffset; i < 42 - startOffset; i++) {
    const d = new Date(year, month, i + 1);
    days.push(d);
  }
  return days;
}

export default function Scheduling() {
  const { user } = useAuth();
  const isReadOnly = !['tenant_owner', 'operations_manager'].includes(user?.role ?? '');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [view, setView] = useState<ViewMode>('week');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [showForm, setShowForm] = useState(false);
  const [editingBooking, setEditingBooking] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    title: '', description: '', start_time: '', end_time: '',
    status: 'confirmed', contact_name: '', contact_phone: '', contact_email: '', notes: '',
  });

  const fetchBookings = useCallback(async () => {
    try {
      const days = view === 'week' ? getWeekDays(currentDate) : getMonthDays(currentDate);
      const start = days[0].toISOString();
      const end = days[days.length - 1].toISOString();
      const data = await api.get<{ bookings: Booking[] }>(`/scheduling/bookings?start=${start}&end=${end}`);
      setBookings(data.bookings);
    } catch {
      setError('Failed to load bookings');
    } finally {
      setLoading(false);
    }
  }, [currentDate, view]);

  useEffect(() => { fetchBookings(); }, [fetchBookings]);

  const navigate = (direction: number) => {
    const d = new Date(currentDate);
    if (view === 'week') d.setDate(d.getDate() + direction * 7);
    else d.setMonth(d.getMonth() + direction);
    setCurrentDate(d);
  };

  const openForm = (booking?: Booking) => {
    if (booking) {
      setEditingBooking(booking);
      setFormData({
        title: booking.title,
        description: booking.description,
        start_time: booking.start_time.slice(0, 16),
        end_time: booking.end_time.slice(0, 16),
        status: booking.status,
        contact_name: booking.contact_name,
        contact_phone: booking.contact_phone,
        contact_email: booking.contact_email,
        notes: booking.notes,
      });
    } else {
      setEditingBooking(null);
      setFormData({
        title: '', description: '', start_time: '', end_time: '',
        status: 'confirmed', contact_name: '', contact_phone: '', contact_email: '', notes: '',
      });
    }
    setShowForm(true);
  };

  const saveBooking = async () => {
    if (!formData.title || !formData.start_time || !formData.end_time) return;
    try {
      if (editingBooking) {
        await api.put(`/scheduling/bookings/${editingBooking.id}`, formData);
      } else {
        await api.post('/scheduling/bookings', formData);
      }
      setShowForm(false);
      fetchBookings();
    } catch {
      setError('Failed to save booking');
    }
  };

  const updateStatus = async (id: string, status: string) => {
    try {
      await api.put(`/scheduling/bookings/${id}`, { status });
      fetchBookings();
    } catch {
      setError('Failed to update booking status');
    }
  };

  const days = view === 'week' ? getWeekDays(currentDate) : getMonthDays(currentDate);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date().toDateString();

  const getBookingsForDay = (date: Date) =>
    bookings.filter(b => new Date(b.start_time).toDateString() === date.toDateString());

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Calendar className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-heading">Scheduling</h1>
            <p className="text-sm text-muted mt-0.5">Manage bookings and appointments</p>
          </div>
        </div>
        {!isReadOnly && (
          <button onClick={() => openForm()} className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors flex items-center gap-2">
            <Plus className="h-4 w-4" /> New Booking
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg hover:bg-surface-secondary"><ChevronLeft className="h-4 w-4" /></button>
            <h2 className="text-sm font-semibold text-heading min-w-[160px] text-center">
              {currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </h2>
            <button onClick={() => navigate(1)} className="p-1.5 rounded-lg hover:bg-surface-secondary"><ChevronRight className="h-4 w-4" /></button>
          </div>
          <div className="flex gap-1 bg-surface-secondary rounded-lg p-1">
            <button onClick={() => setView('week')} className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${view === 'week' ? 'bg-primary text-white' : 'text-muted hover:text-heading'}`}>Week</button>
            <button onClick={() => setView('month')} className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${view === 'month' ? 'bg-primary text-white' : 'text-muted hover:text-heading'}`}>Month</button>
          </div>
        </div>

        <div className="grid grid-cols-7">
          {dayNames.map(d => (
            <div key={d} className="px-2 py-2 text-center text-xs font-medium text-muted border-b border-border">{d}</div>
          ))}
          {days.map((day, i) => {
            const dayBookings = getBookingsForDay(day);
            const isToday = day.toDateString() === today;
            const isCurrentMonth = day.getMonth() === currentDate.getMonth();
            return (
              <div key={i} className={`min-h-[100px] border-b border-r border-border p-1.5 ${!isCurrentMonth && view === 'month' ? 'opacity-40' : ''}`}>
                <div className={`text-xs font-medium mb-1 ${isToday ? 'text-primary font-bold' : 'text-muted'}`}>
                  {day.getDate()}
                </div>
                <div className="space-y-0.5">
                  {dayBookings.slice(0, 3).map(b => (
                    <button
                      key={b.id}
                      onClick={() => !isReadOnly && openForm(b)}
                      className={`w-full text-left text-[10px] px-1.5 py-0.5 rounded truncate ${STATUS_COLORS[b.status] || 'bg-gray-100 text-gray-800'}`}
                    >
                      {new Date(b.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} {b.title}
                    </button>
                  ))}
                  {dayBookings.length > 3 && (
                    <div className="text-[10px] text-muted px-1.5">+{dayBookings.length - 3} more</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-4">
        <h3 className="font-semibold text-heading text-sm mb-3">Upcoming Bookings</h3>
        <div className="space-y-2">
          {bookings.filter(b => b.status !== 'cancelled').length === 0 ? (
            <p className="text-sm text-muted py-4 text-center">No bookings in this period</p>
          ) : (
            bookings.filter(b => b.status !== 'cancelled').map(b => (
              <div key={b.id} className="flex items-center justify-between p-3 rounded-lg bg-surface-secondary">
                <div className="flex items-center gap-3">
                  <Clock className="h-4 w-4 text-muted shrink-0" />
                  <div>
                    <div className="text-sm font-medium text-heading">{b.title}</div>
                    <div className="text-xs text-muted">
                      {new Date(b.start_time).toLocaleString()} &middot; {b.contact_name || 'No contact'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_COLORS[b.status]}`}>
                    {b.status}
                  </span>
                  {!isReadOnly && b.status === 'pending' && (
                    <button onClick={() => updateStatus(b.id, 'confirmed')} className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-900/30 text-green-600">
                      <CheckCircle2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-surface border border-border rounded-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="font-semibold text-heading">{editingBooking ? 'Edit Booking' : 'New Booking'}</h3>
              <button onClick={() => setShowForm(false)} className="text-muted hover:text-heading"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Title *</label>
                <input type="text" value={formData.title} onChange={e => setFormData(p => ({ ...p, title: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Start Time *</label>
                  <input type="datetime-local" value={formData.start_time} onChange={e => setFormData(p => ({ ...p, start_time: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">End Time *</label>
                  <input type="datetime-local" value={formData.end_time} onChange={e => setFormData(p => ({ ...p, end_time: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Status</label>
                <select value={formData.status} onChange={e => setFormData(p => ({ ...p, status: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                  <option value="pending">Pending</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="cancelled">Cancelled</option>
                  <option value="completed">Completed</option>
                  <option value="no_show">No Show</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Contact Name</label>
                  <input type="text" value={formData.contact_name} onChange={e => setFormData(p => ({ ...p, contact_name: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Contact Phone</label>
                  <input type="text" value={formData.contact_phone} onChange={e => setFormData(p => ({ ...p, contact_phone: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Contact Email</label>
                <input type="text" value={formData.contact_email} onChange={e => setFormData(p => ({ ...p, contact_email: e.target.value }))} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Notes</label>
                <textarea value={formData.notes} onChange={e => setFormData(p => ({ ...p, notes: e.target.value }))} rows={3} className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-border">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-muted hover:text-heading bg-surface-secondary">Cancel</button>
              <button onClick={saveBooking} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
