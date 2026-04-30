import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Calendar, Plus, X, ChevronLeft, ChevronRight, Clock, CheckCircle2,
  AlertCircle, Search, BarChart3, Users, MapPin, Settings,
  XCircle, UserCheck, PhoneOff, RotateCcw, Edit2, Trash2,
  Building, Layers, ClipboardList, Activity
} from 'lucide-react';
import { EmptyState, PageSkeleton, SkeletonRows } from '../components/state';
import { PageHeader } from '../components/ui';
import Modal from '../components/Modal';

interface Booking {
  id: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  status: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  agent_name: string | null;
  provider_id: string | null;
  provider_name: string | null;
  appointment_type_id: string | null;
  appointment_type_name: string | null;
  appointment_type_color: string | null;
  resource_id: string | null;
  resource_name: string | null;
  recurring_series_id: string | null;
  cancellation_reason: string;
  checked_in_at: string | null;
  completed_at: string | null;
  intake_data: Record<string, unknown>;
  timezone: string;
  location: string;
  booking_source: string;
  notes: string;
  created_at: string;
}

interface Provider {
  id: string;
  name: string;
  specialty: string;
  email: string;
  phone: string;
  location: string;
  is_active: boolean;
}

interface AppointmentType {
  id: string;
  name: string;
  description: string;
  duration_minutes: number;
  buffer_minutes: number;
  capacity: number;
  color: string;
  required_resources: string[];
  intake_fields: Array<{ label: string; type: string; required?: boolean }>;
  is_active: boolean;
  allow_self_scheduling: boolean;
}

interface Resource {
  id: string;
  name: string;
  type: string;
  location: string;
  capacity: number;
  is_active: boolean;
}

interface WaitlistEntry {
  id: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  appointment_type_name: string | null;
  provider_name: string | null;
  status: string;
  notes: string;
  created_at: string;
}

interface ReportData {
  summary: {
    total_bookings: number;
    completed: number;
    cancelled: number;
    no_shows: number;
    confirmed: number;
    pending: number;
    checked_in: number;
    no_show_rate: number | null;
    cancellation_rate: number | null;
    fill_rate: number | null;
    avg_hours_to_appointment: number | null;
  };
  by_provider: Array<{ provider_name: string; total: number; completed: number; no_shows: number; cancelled: number; total_hours: number }>;
  by_type: Array<{ type_name: string; color: string; total: number; completed: number; cancelled: number }>;
  cancellation_reasons: Array<{ cancellation_reason: string; count: number }>;
  daily_trend: Array<{ date: string; total: number; completed: number; cancelled: number; no_shows: number }>;
  by_source: Array<{ booking_source: string; count: number }>;
}

interface UtilizationData {
  provider_utilization: Array<{ id: string; name: string; total_bookings: number; booked_hours: number; completed: number; no_shows: number }>;
  resource_utilization: Array<{ id: string; name: string; type: string; total_bookings: number; booked_hours: number }>;
}

type ViewMode = 'day' | 'week' | 'month' | 'agenda' | 'resource';
type TabMode = 'calendar' | 'providers' | 'types' | 'resources' | 'waitlist' | 'reminders' | 'reports' | 'utilization' | 'rules' | 'settings';

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  confirmed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  cancelled: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  completed: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  no_show: 'bg-surface-hover text-text-primary',
  checked_in: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  rescheduled: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending', confirmed: 'Confirmed', cancelled: 'Cancelled',
  completed: 'Completed', no_show: 'No Show', checked_in: 'Checked In', rescheduled: 'Rescheduled',
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
    days.push(new Date(year, month, i + 1));
  }
  return days;
}

function getDayHours(): number[] {
  return Array.from({ length: 14 }, (_, i) => i + 7);
}

function formatTime(dateStr: string) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function Scheduling() {
  const { t: tenantT } = useTranslation('tenant');
  const { user } = useAuth();
  const isReadOnly = !['tenant_owner', 'operations_manager'].includes(user?.role ?? '');

  const [activeTab, setActiveTab] = useState<TabMode>('calendar');
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [appointmentTypes, setAppointmentTypes] = useState<AppointmentType[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [waitlist, setWaitlist] = useState<WaitlistEntry[]>([]);
  const [reportData, setReportData] = useState<ReportData | null>(null);
  const [utilizationData, setUtilizationData] = useState<UtilizationData | null>(null);
  const [view, setView] = useState<ViewMode>('week');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [showForm, setShowForm] = useState(false);
  const [editingBooking, setEditingBooking] = useState<Booking | null>(null);
  const [showDetailModal, setShowDetailModal] = useState<Booking | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterProvider, setFilterProvider] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const [formData, setFormData] = useState({
    title: '', description: '', start_time: '', end_time: '',
    status: 'confirmed', contact_name: '', contact_phone: '', contact_email: '',
    notes: '', provider_id: '', appointment_type_id: '', resource_id: '',
    location: '', timezone: 'America/New_York', booking_source: 'manual',
  });

  const [showProviderForm, setShowProviderForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [providerFormData, setProviderFormData] = useState({ name: '', specialty: '', email: '', phone: '', location: '' });

  const [showTypeForm, setShowTypeForm] = useState(false);
  const [editingType, setEditingType] = useState<AppointmentType | null>(null);
  const [typeFormData, setTypeFormData] = useState({
    name: '', description: '', duration_minutes: 30, buffer_minutes: 0,
    capacity: 1, color: '#3b82f6', allow_self_scheduling: false,
  });

  const [showResourceForm, setShowResourceForm] = useState(false);
  const [editingResource, setEditingResource] = useState<Resource | null>(null);
  const [resourceFormData, setResourceFormData] = useState({ name: '', type: 'room', location: '', capacity: 1 });

  const [showWaitlistForm, setShowWaitlistForm] = useState(false);
  const [waitlistFormData, setWaitlistFormData] = useState({
    contact_name: '', contact_phone: '', contact_email: '',
    appointment_type_id: '', provider_id: '', notes: '',
  });

  const getDateRange = useCallback(() => {
    if (view === 'day') {
      const start = new Date(currentDate);
      start.setHours(0, 0, 0, 0);
      const end = new Date(currentDate);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }
    if (view === 'week' || view === 'resource') {
      const days = getWeekDays(currentDate);
      return { start: days[0], end: days[6] };
    }
    const days = getMonthDays(currentDate);
    return { start: days[0], end: days[days.length - 1] };
  }, [currentDate, view]);

  const fetchBookings = useCallback(async () => {
    try {
      const { start, end } = getDateRange();
      let url = `/scheduling/bookings?start=${start.toISOString()}&end=${end.toISOString()}`;
      if (filterProvider) url += `&provider_id=${filterProvider}`;
      if (filterType) url += `&appointment_type_id=${filterType}`;
      if (filterStatus) url += `&status=${filterStatus}`;
      if (searchQuery) url += `&search=${encodeURIComponent(searchQuery)}`;
      const data = await api.get<{ bookings: Booking[] }>(url);
      setBookings(data.bookings);
    } catch {
      setError('Failed to load bookings');
    } finally {
      setLoading(false);
    }
  }, [getDateRange, filterProvider, filterType, filterStatus, searchQuery]);

  const fetchProviders = useCallback(async () => {
    try {
      const data = await api.get<{ providers: Provider[] }>('/scheduling/providers');
      setProviders(data.providers);
    } catch { /* ignore */ }
  }, []);

  const fetchAppointmentTypes = useCallback(async () => {
    try {
      const data = await api.get<{ appointment_types: AppointmentType[] }>('/scheduling/appointment-types');
      setAppointmentTypes(data.appointment_types);
    } catch { /* ignore */ }
  }, []);

  const fetchResources = useCallback(async () => {
    try {
      const data = await api.get<{ resources: Resource[] }>('/scheduling/resources');
      setResources(data.resources);
    } catch { /* ignore */ }
  }, []);

  const fetchWaitlist = useCallback(async () => {
    try {
      const data = await api.get<{ waitlist: WaitlistEntry[] }>('/scheduling/waitlist');
      setWaitlist(data.waitlist);
    } catch { /* ignore */ }
  }, []);

  const fetchReports = useCallback(async () => {
    try {
      const { start, end } = getDateRange();
      const data = await api.get<ReportData>(`/scheduling/reports?start=${start.toISOString()}&end=${end.toISOString()}`);
      setReportData(data);
    } catch { /* ignore */ }
  }, [getDateRange]);

  const fetchUtilization = useCallback(async () => {
    try {
      const { start, end } = getDateRange();
      const data = await api.get<UtilizationData>(`/scheduling/utilization?start=${start.toISOString()}&end=${end.toISOString()}`);
      setUtilizationData(data);
    } catch { /* ignore */ }
  }, [getDateRange]);

  useEffect(() => {
    fetchBookings();
    fetchProviders();
    fetchAppointmentTypes();
    fetchResources();
  }, [fetchBookings, fetchProviders, fetchAppointmentTypes, fetchResources]);

  useEffect(() => {
    if (activeTab === 'waitlist') fetchWaitlist();
    if (activeTab === 'reports') fetchReports();
    if (activeTab === 'utilization') fetchUtilization();
  }, [activeTab, fetchWaitlist, fetchReports, fetchUtilization]);

  const navigate = (direction: number) => {
    const d = new Date(currentDate);
    if (view === 'day') d.setDate(d.getDate() + direction);
    else if (view === 'week' || view === 'resource') d.setDate(d.getDate() + direction * 7);
    else d.setMonth(d.getMonth() + direction);
    setCurrentDate(d);
  };

  const goToToday = () => setCurrentDate(new Date());

  const openBookingForm = (booking?: Booking) => {
    if (booking) {
      setEditingBooking(booking);
      setFormData({
        title: booking.title, description: booking.description,
        start_time: booking.start_time.slice(0, 16), end_time: booking.end_time.slice(0, 16),
        status: booking.status, contact_name: booking.contact_name,
        contact_phone: booking.contact_phone, contact_email: booking.contact_email,
        notes: booking.notes, provider_id: booking.provider_id || '',
        appointment_type_id: booking.appointment_type_id || '',
        resource_id: booking.resource_id || '',
        location: booking.location || '', timezone: booking.timezone || 'America/New_York',
        booking_source: booking.booking_source || 'manual',
      });
    } else {
      setEditingBooking(null);
      setFormData({
        title: '', description: '', start_time: '', end_time: '',
        status: 'confirmed', contact_name: '', contact_phone: '', contact_email: '',
        notes: '', provider_id: '', appointment_type_id: '', resource_id: '',
        location: '', timezone: 'America/New_York', booking_source: 'manual',
      });
    }
    setShowForm(true);
  };

  const saveBooking = async () => {
    if (!formData.title || !formData.start_time || !formData.end_time) return;
    try {
      const payload = {
        ...formData,
        provider_id: formData.provider_id || null,
        appointment_type_id: formData.appointment_type_id || null,
        resource_id: formData.resource_id || null,
      };
      if (editingBooking) {
        await api.put(`/scheduling/bookings/${editingBooking.id}`, payload);
      } else {
        await api.post('/scheduling/bookings', payload);
      }
      setShowForm(false);
      fetchBookings();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save booking';
      setError(msg);
    }
  };

  const transitionBooking = async (id: string, action: string, extra: Record<string, unknown> = {}) => {
    try {
      await api.post(`/scheduling/bookings/${id}/transition`, { action, ...extra });
      fetchBookings();
      setShowDetailModal(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `Failed to ${action} booking`;
      setError(msg);
    }
  };

  const deleteBooking = async (id: string) => {
    try {
      await api.delete(`/scheduling/bookings/${id}`);
      fetchBookings();
      setShowDetailModal(null);
    } catch {
      setError('Failed to delete booking');
    }
  };

  const today = new Date().toDateString();
  const getBookingsForDay = (date: Date) =>
    bookings.filter(b => new Date(b.start_time).toDateString() === date.toDateString());

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const tabs: Array<{ id: TabMode; label: string; icon: React.ReactNode }> = [
    { id: 'calendar', label: 'Calendar', icon: <Calendar className="h-4 w-4" /> },
    { id: 'providers', label: 'Providers', icon: <Users className="h-4 w-4" /> },
    { id: 'types', label: 'Appt Types', icon: <Layers className="h-4 w-4" /> },
    { id: 'resources', label: 'Resources', icon: <Building className="h-4 w-4" /> },
    { id: 'waitlist', label: 'Waitlist', icon: <ClipboardList className="h-4 w-4" /> },
    { id: 'reports', label: 'Reports', icon: <BarChart3 className="h-4 w-4" /> },
    { id: 'utilization', label: 'Utilization', icon: <Activity className="h-4 w-4" /> },
    { id: 'rules', label: 'Rules', icon: <Settings className="h-4 w-4" /> },
  ];

  const activeProviders = useMemo(() => providers.filter(p => p.is_active), [providers]);

  if (loading && activeTab === 'calendar') {
    return <PageSkeleton />;
  }

  const saveProvider = async () => {
    if (!providerFormData.name) return;
    try {
      if (editingProvider) {
        await api.put(`/scheduling/providers/${editingProvider.id}`, providerFormData);
      } else {
        await api.post('/scheduling/providers', providerFormData);
      }
      setShowProviderForm(false);
      fetchProviders();
    } catch { setError('Failed to save provider'); }
  };

  const deleteProvider = async (id: string) => {
    try {
      await api.delete(`/scheduling/providers/${id}`);
      fetchProviders();
    } catch { setError('Failed to delete provider'); }
  };

  const saveType = async () => {
    if (!typeFormData.name) return;
    try {
      if (editingType) {
        await api.put(`/scheduling/appointment-types/${editingType.id}`, typeFormData);
      } else {
        await api.post('/scheduling/appointment-types', typeFormData);
      }
      setShowTypeForm(false);
      fetchAppointmentTypes();
    } catch { setError('Failed to save appointment type'); }
  };

  const deleteType = async (id: string) => {
    try {
      await api.delete(`/scheduling/appointment-types/${id}`);
      fetchAppointmentTypes();
    } catch { setError('Failed to delete appointment type'); }
  };

  const saveResource = async () => {
    if (!resourceFormData.name) return;
    try {
      if (editingResource) {
        await api.put(`/scheduling/resources/${editingResource.id}`, resourceFormData);
      } else {
        await api.post('/scheduling/resources', resourceFormData);
      }
      setShowResourceForm(false);
      fetchResources();
    } catch { setError('Failed to save resource'); }
  };

  const deleteResource = async (id: string) => {
    try {
      await api.delete(`/scheduling/resources/${id}`);
      fetchResources();
    } catch { setError('Failed to delete resource'); }
  };

  const addToWaitlist = async () => {
    if (!waitlistFormData.contact_name) return;
    try {
      await api.post('/scheduling/waitlist', {
        ...waitlistFormData,
        appointment_type_id: waitlistFormData.appointment_type_id || null,
        provider_id: waitlistFormData.provider_id || null,
      });
      setShowWaitlistForm(false);
      fetchWaitlist();
    } catch { setError('Failed to add to waitlist'); }
  };

  const removeFromWaitlist = async (id: string) => {
    try { await api.delete(`/scheduling/waitlist/${id}`); fetchWaitlist(); }
    catch { setError('Failed to remove from waitlist'); }
  };

  const renderCalendarView = () => {
    if (view === 'day') return renderDayView();
    if (view === 'week') return renderWeekView();
    if (view === 'month') return renderMonthView();
    if (view === 'agenda') return renderAgendaView();
    if (view === 'resource') return renderResourceView();
    return null;
  };

  const renderDayView = () => {
    const hours = getDayHours();
    const dayBookings = getBookingsForDay(currentDate);
    return (
      <div className="overflow-auto max-h-[600px]">
        {hours.map(hour => {
          const hourBookings = dayBookings.filter(b => new Date(b.start_time).getHours() === hour);
          return (
            <div key={hour} className="flex border-b border-border min-h-[60px]">
              <div className="w-16 shrink-0 text-xs text-muted p-2 text-right">
                {hour > 12 ? `${hour - 12} PM` : hour === 12 ? '12 PM' : `${hour} AM`}
              </div>
              <div className="flex-1 p-1 space-y-1">
                {hourBookings.map(b => (
                  <button key={b.id} onClick={() => setShowDetailModal(b)}
                    className="w-full text-left text-xs px-2 py-1 rounded truncate"
                    style={{ backgroundColor: (b.appointment_type_color || '#3b82f6') + '20', borderLeft: `3px solid ${b.appointment_type_color || '#3b82f6'}` }}>
                    <span className="font-medium">{formatTime(b.start_time)}</span> {b.title}
                    {b.provider_name && <span className="text-muted ml-1">- {b.provider_name}</span>}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderWeekView = () => {
    const days = getWeekDays(currentDate);
    return (
      <div className="grid grid-cols-7">
        {dayNames.map(d => (
          <div key={d} className="px-2 py-2 text-center text-xs font-medium text-muted border-b border-border">{d}</div>
        ))}
        {days.map((day, i) => {
          const dayBookings = getBookingsForDay(day);
          const isToday = day.toDateString() === today;
          return (
            <div key={i} className="min-h-[120px] border-b border-r border-border p-1.5">
              <div className={`text-xs font-medium mb-1 ${isToday ? 'text-primary font-bold' : 'text-muted'}`}>
                {day.getDate()}
              </div>
              <div className="space-y-0.5">
                {dayBookings.slice(0, 4).map(b => (
                  <button key={b.id} onClick={() => setShowDetailModal(b)}
                    className="w-full text-left text-[10px] px-1.5 py-0.5 rounded truncate"
                    style={{ backgroundColor: (b.appointment_type_color || '#3b82f6') + '15', color: b.appointment_type_color || '#3b82f6' }}>
                    {formatTime(b.start_time)} {b.title}
                  </button>
                ))}
                {dayBookings.length > 4 && (
                  <div className="text-[10px] text-muted px-1.5">+{dayBookings.length - 4} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderMonthView = () => {
    const days = getMonthDays(currentDate);
    return (
      <div className="grid grid-cols-7">
        {dayNames.map(d => (
          <div key={d} className="px-2 py-2 text-center text-xs font-medium text-muted border-b border-border">{d}</div>
        ))}
        {days.map((day, i) => {
          const dayBookings = getBookingsForDay(day);
          const isToday = day.toDateString() === today;
          const isCurrentMonth = day.getMonth() === currentDate.getMonth();
          return (
            <div key={i} className={`min-h-[80px] border-b border-r border-border p-1 ${!isCurrentMonth ? 'opacity-40' : ''}`}>
              <div className={`text-xs font-medium mb-0.5 ${isToday ? 'text-primary font-bold' : 'text-muted'}`}>
                {day.getDate()}
              </div>
              <div className="space-y-0.5">
                {dayBookings.slice(0, 3).map(b => (
                  <button key={b.id} onClick={() => setShowDetailModal(b)}
                    className={`w-full text-left text-[10px] px-1 py-0.5 rounded truncate ${STATUS_COLORS[b.status] || 'bg-surface-hover text-text-primary'}`}>
                    {formatTime(b.start_time)} {b.title}
                  </button>
                ))}
                {dayBookings.length > 3 && (
                  <div className="text-[10px] text-muted px-1">+{dayBookings.length - 3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderAgendaView = () => {
    const sorted = [...bookings].sort((a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime());
    const grouped: Record<string, Booking[]> = {};
    sorted.forEach(b => {
      const key = new Date(b.start_time).toDateString();
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(b);
    });

    return (
      <div className="space-y-4 p-4 max-h-[600px] overflow-auto">
        {Object.keys(grouped).length === 0 && (
          <EmptyState
            icon={Calendar}
            title="No appointments in this period"
            description="Try selecting a different date range or create a new appointment."
            variant="compact"
          />
        )}
        {Object.entries(grouped).map(([dateStr, dayBookings]) => (
          <div key={dateStr}>
            <h4 className="text-xs font-semibold text-muted uppercase mb-2">
              {new Date(dateStr).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}
            </h4>
            <div className="space-y-1">
              {dayBookings.map(b => (
                <button key={b.id} onClick={() => setShowDetailModal(b)}
                  className="w-full text-left flex items-center gap-3 p-3 rounded-lg bg-surface-secondary hover:bg-surface-secondary/80 transition-colors">
                  <div className="w-1 h-10 rounded-full" style={{ backgroundColor: b.appointment_type_color || '#3b82f6' }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-heading truncate">{b.title}</div>
                    <div className="text-xs text-muted">
                      {formatTime(b.start_time)} - {formatTime(b.end_time)}
                      {b.provider_name && ` | ${b.provider_name}`}
                      {b.contact_name && ` | ${b.contact_name}`}
                    </div>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_COLORS[b.status]}`}>
                    {STATUS_LABELS[b.status] || b.status}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  };

  const renderResourceView = () => {
    const days = getWeekDays(currentDate);
    const viewProviders = activeProviders.length > 0 ? activeProviders : [{ id: '', name: 'Unassigned', specialty: '', email: '', phone: '', location: '', is_active: true }];

    return (
      <div className="overflow-x-auto">
        <div className="min-w-[800px]">
          <div className="grid" style={{ gridTemplateColumns: `150px repeat(${days.length}, 1fr)` }}>
            <div className="border-b border-r border-border p-2 text-xs font-medium text-muted">Provider</div>
            {days.map((day, i) => (
              <div key={i} className="border-b border-r border-border p-2 text-center text-xs font-medium text-muted">
                {dayNames[day.getDay()]} {day.getDate()}
              </div>
            ))}
            {viewProviders.map(provider => (
              <React.Fragment key={`row-${provider.id}`}>
                <div className="border-b border-r border-border p-2">
                  <div className="text-xs font-medium text-heading truncate">{provider.name}</div>
                  {provider.specialty && <div className="text-[10px] text-muted">{provider.specialty}</div>}
                </div>
                {days.map((day, di) => {
                  const dayBookings = bookings.filter(b =>
                    new Date(b.start_time).toDateString() === day.toDateString() &&
                    (provider.id ? b.provider_id === provider.id : !b.provider_id)
                  );
                  return (
                    <div key={`${provider.id}-${di}`} className="border-b border-r border-border p-1 min-h-[60px]">
                      {dayBookings.slice(0, 3).map(b => (
                        <button key={b.id} onClick={() => setShowDetailModal(b)}
                          className="w-full text-left text-[9px] px-1 py-0.5 rounded mb-0.5 truncate"
                          style={{ backgroundColor: (b.appointment_type_color || '#3b82f6') + '20', color: b.appointment_type_color || '#3b82f6' }}>
                          {formatTime(b.start_time)} {b.title}
                        </button>
                      ))}
                      {dayBookings.length > 3 && <div className="text-[9px] text-muted">+{dayBookings.length - 3}</div>}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderProvidersTab = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-heading">Providers</h3>
        {!isReadOnly && (
          <button onClick={() => { setEditingProvider(null); setProviderFormData({ name: '', specialty: '', email: '', phone: '', location: '' }); setShowProviderForm(true); }}
            className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add Provider
          </button>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {providers.map(p => (
          <div key={p.id} className="bg-surface border border-border rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div>
                <h4 className="font-medium text-heading text-sm">{p.name}</h4>
                {p.specialty && <p className="text-xs text-muted mt-0.5">{p.specialty}</p>}
                {p.location && <p className="text-xs text-muted flex items-center gap-1 mt-1"><MapPin className="h-3 w-3" />{p.location}</p>}
                {p.email && <p className="text-xs text-muted mt-0.5">{p.email}</p>}
              </div>
              {!isReadOnly && (
                <div className="flex gap-1">
                  <button onClick={() => { setEditingProvider(p); setProviderFormData({ name: p.name, specialty: p.specialty, email: p.email, phone: p.phone, location: p.location }); setShowProviderForm(true); }}
                    className="p-1 rounded hover:bg-surface-secondary text-muted"><Edit2 className="h-3.5 w-3.5" /></button>
                  <button onClick={() => deleteProvider(p.id)}
                    className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              )}
            </div>
            <div className="mt-2">
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${p.is_active ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' : 'bg-surface-hover text-text-secondary'}`}>
                {p.is_active ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>
        ))}
        {providers.length === 0 && (
          <div className="col-span-full">
            <EmptyState
              icon={Users}
              title="No providers yet"
              description="Add the people who deliver appointments so you can assign bookings to them."
              primaryAction={!isReadOnly ? {
                label: 'Add Provider',
                icon: Plus,
                onClick: () => { setEditingProvider(null); setProviderFormData({ name: '', specialty: '', email: '', phone: '', location: '' }); setShowProviderForm(true); },
              } : undefined}
              variant="compact"
            />
          </div>
        )}
      </div>
    </div>
  );

  const renderTypesTab = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-heading">Appointment Types</h3>
        {!isReadOnly && (
          <button onClick={() => { setEditingType(null); setTypeFormData({ name: '', description: '', duration_minutes: 30, buffer_minutes: 0, capacity: 1, color: '#3b82f6', allow_self_scheduling: false }); setShowTypeForm(true); }}
            className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add Type
          </button>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {appointmentTypes.map(t => (
          <div key={t.id} className="bg-surface border border-border rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.color }} />
                <h4 className="font-medium text-heading text-sm">{t.name}</h4>
              </div>
              {!isReadOnly && (
                <div className="flex gap-1">
                  <button onClick={() => { setEditingType(t); setTypeFormData({ name: t.name, description: t.description, duration_minutes: t.duration_minutes, buffer_minutes: t.buffer_minutes, capacity: t.capacity, color: t.color, allow_self_scheduling: t.allow_self_scheduling }); setShowTypeForm(true); }}
                    className="p-1 rounded hover:bg-surface-secondary text-muted"><Edit2 className="h-3.5 w-3.5" /></button>
                  <button onClick={() => deleteType(t.id)}
                    className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              )}
            </div>
            {t.description && <p className="text-xs text-muted mt-1">{t.description}</p>}
            <div className="flex gap-2 mt-2 text-[10px] text-muted">
              <span className="flex items-center gap-0.5"><Clock className="h-3 w-3" />{t.duration_minutes}min</span>
              {t.buffer_minutes > 0 && <span>+{t.buffer_minutes}min buffer</span>}
              <span>Cap: {t.capacity}</span>
              {t.allow_self_scheduling && <span className="text-green-600">Self-schedule</span>}
            </div>
          </div>
        ))}
        {appointmentTypes.length === 0 && (
          <div className="col-span-full">
            <EmptyState
              icon={Layers}
              title="No appointment types yet"
              description="Define the kinds of appointments you offer with their duration, capacity, and color."
              primaryAction={!isReadOnly ? {
                label: 'Add Type',
                icon: Plus,
                onClick: () => { setEditingType(null); setTypeFormData({ name: '', description: '', duration_minutes: 30, buffer_minutes: 0, capacity: 1, color: '#3b82f6', allow_self_scheduling: false }); setShowTypeForm(true); },
              } : undefined}
              variant="compact"
            />
          </div>
        )}
      </div>
    </div>
  );

  const renderResourcesTab = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-heading">Resources</h3>
        {!isReadOnly && (
          <button onClick={() => { setEditingResource(null); setResourceFormData({ name: '', type: 'room', location: '', capacity: 1 }); setShowResourceForm(true); }}
            className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add Resource
          </button>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {resources.map(r => (
          <div key={r.id} className="bg-surface border border-border rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div>
                <h4 className="font-medium text-heading text-sm">{r.name}</h4>
                <p className="text-xs text-muted mt-0.5 capitalize">{r.type}{r.location ? ` - ${r.location}` : ''}</p>
              </div>
              {!isReadOnly && (
                <div className="flex gap-1">
                  <button onClick={() => { setEditingResource(r); setResourceFormData({ name: r.name, type: r.type, location: r.location, capacity: r.capacity }); setShowResourceForm(true); }}
                    className="p-1 rounded hover:bg-surface-secondary text-muted"><Edit2 className="h-3.5 w-3.5" /></button>
                  <button onClick={() => deleteResource(r.id)}
                    className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-2 text-[10px] text-muted">
              <span>Capacity: {r.capacity}</span>
              <span className={r.is_active ? 'text-green-600' : 'text-text-secondary'}>{r.is_active ? 'Active' : 'Inactive'}</span>
            </div>
          </div>
        ))}
        {resources.length === 0 && (
          <div className="col-span-full">
            <EmptyState
              icon={Building}
              title="No resources yet"
              description="Add rooms, equipment, or other shared resources that appointments need to book."
              primaryAction={!isReadOnly ? {
                label: 'Add Resource',
                icon: Plus,
                onClick: () => { setEditingResource(null); setResourceFormData({ name: '', type: 'room', location: '', capacity: 1 }); setShowResourceForm(true); },
              } : undefined}
              variant="compact"
            />
          </div>
        )}
      </div>
    </div>
  );

  const renderWaitlistTab = () => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-heading">Waitlist</h3>
        {!isReadOnly && (
          <button onClick={() => { setWaitlistFormData({ contact_name: '', contact_phone: '', contact_email: '', appointment_type_id: '', provider_id: '', notes: '' }); setShowWaitlistForm(true); }}
            className="px-3 py-1.5 bg-primary text-white rounded-lg text-xs font-medium hover:bg-primary/90 flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add to Waitlist
          </button>
        )}
      </div>
      <div className="space-y-2">
        {waitlist.map(w => (
          <div key={w.id} className="flex items-center justify-between p-3 rounded-lg bg-surface border border-border">
            <div>
              <div className="text-sm font-medium text-heading">{w.contact_name}</div>
              <div className="text-xs text-muted">
                {w.contact_phone || w.contact_email || ''}
                {w.appointment_type_name && ` | ${w.appointment_type_name}`}
                {w.provider_name && ` | ${w.provider_name}`}
              </div>
              {w.notes && <div className="text-xs text-muted mt-0.5">{w.notes}</div>}
            </div>
            <div className="flex items-center gap-2">
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_COLORS[w.status] || 'bg-surface-hover text-text-primary'}`}>
                {w.status}
              </span>
              {!isReadOnly && (
                <button onClick={() => removeFromWaitlist(w.id)} className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-red-500">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        ))}
        {waitlist.length === 0 && (
          <EmptyState
            icon={ClipboardList}
            title="No one on the waitlist"
            description="Capture customers who couldn't get a slot. They'll appear here for follow-up."
            primaryAction={!isReadOnly ? {
              label: 'Add to Waitlist',
              icon: Plus,
              onClick: () => { setWaitlistFormData({ contact_name: '', contact_phone: '', contact_email: '', appointment_type_id: '', provider_id: '', notes: '' }); setShowWaitlistForm(true); },
            } : undefined}
            variant="compact"
          />
        )}
      </div>
    </div>
  );

  const renderReportsTab = () => {
    if (!reportData) return <SkeletonRows count={4} rowClassName="h-14" />;

    const s = reportData.summary;
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          {[
            { label: 'Total', value: s.total_bookings, color: 'text-heading' },
            { label: 'Completed', value: s.completed, color: 'text-blue-600' },
            { label: 'Confirmed', value: s.confirmed, color: 'text-green-600' },
            { label: 'Pending', value: s.pending, color: 'text-yellow-600' },
            { label: 'Cancelled', value: s.cancelled, color: 'text-red-600' },
            { label: 'No Shows', value: s.no_shows, color: 'text-text-secondary' },
            { label: 'Checked In', value: s.checked_in, color: 'text-purple-600' },
          ].map(stat => (
            <div key={stat.label} className="bg-surface border border-border rounded-xl p-3 text-center">
              <div className={`text-xl font-bold ${stat.color}`}>{stat.value}</div>
              <div className="text-[10px] text-muted mt-0.5">{stat.label}</div>
            </div>
          ))}
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          <div className="bg-surface border border-border rounded-xl p-4">
            <h4 className="text-sm font-semibold text-heading mb-2">Key Rates</h4>
            <div className="space-y-2">
              <div className="flex justify-between text-sm"><span className="text-muted">Fill Rate</span><span className="font-medium text-heading">{s.fill_rate ?? 0}%</span></div>
              <div className="flex justify-between text-sm"><span className="text-muted">No-Show Rate</span><span className="font-medium text-heading">{s.no_show_rate ?? 0}%</span></div>
              <div className="flex justify-between text-sm"><span className="text-muted">Cancellation Rate</span><span className="font-medium text-heading">{s.cancellation_rate ?? 0}%</span></div>
              <div className="flex justify-between text-sm"><span className="text-muted">Avg Hours to Appt</span><span className="font-medium text-heading">{s.avg_hours_to_appointment ?? 0}h</span></div>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-xl p-4">
            <h4 className="text-sm font-semibold text-heading mb-2">By Provider</h4>
            <div className="space-y-1.5 max-h-40 overflow-auto">
              {reportData.by_provider.map((p, i) => (
                <div key={i} className="flex justify-between text-xs">
                  <span className="text-muted truncate">{p.provider_name || 'Unassigned'}</span>
                  <span className="font-medium text-heading">{p.total} ({p.completed} done)</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-surface border border-border rounded-xl p-4">
            <h4 className="text-sm font-semibold text-heading mb-2">By Type</h4>
            <div className="space-y-1.5 max-h-40 overflow-auto">
              {reportData.by_type.map((t, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full" style={{ backgroundColor: t.color || '#3b82f6' }} />
                    <span className="text-muted truncate">{t.type_name || 'Untyped'}</span>
                  </span>
                  <span className="font-medium text-heading">{t.total}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {reportData.cancellation_reasons.length > 0 && (
          <div className="bg-surface border border-border rounded-xl p-4">
            <h4 className="text-sm font-semibold text-heading mb-2">Cancellation Reasons</h4>
            <div className="space-y-1.5">
              {reportData.cancellation_reasons.map((r, i) => (
                <div key={i} className="flex justify-between text-xs">
                  <span className="text-muted">{r.cancellation_reason}</span>
                  <span className="font-medium text-heading">{r.count}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {reportData.by_source.length > 0 && (
          <div className="bg-surface border border-border rounded-xl p-4">
            <h4 className="text-sm font-semibold text-heading mb-2">By Booking Source</h4>
            <div className="flex flex-wrap gap-3">
              {reportData.by_source.map((s, i) => (
                <div key={i} className="bg-surface-secondary rounded-lg px-3 py-2 text-center">
                  <div className="text-sm font-bold text-heading">{s.count}</div>
                  <div className="text-[10px] text-muted capitalize">{s.booking_source || 'unknown'}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderUtilizationTab = () => {
    if (!utilizationData) return <SkeletonRows count={4} rowClassName="h-14" />;

    return (
      <div className="space-y-6">
        <div className="bg-surface border border-border rounded-xl p-4">
          <h4 className="text-sm font-semibold text-heading mb-3">Provider Utilization</h4>
          <div className="space-y-3">
            {utilizationData.provider_utilization.map(p => {
              const maxHours = 40;
              const pct = Math.min((p.booked_hours || 0) / maxHours * 100, 100);
              return (
                <div key={p.id}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-medium text-heading">{p.name}</span>
                    <span className="text-muted">{p.booked_hours || 0}h | {p.total_bookings} appts | {p.completed} done | {p.no_shows} no-show</span>
                  </div>
                  <div className="h-2 bg-surface-secondary rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: pct > 80 ? '#ef4444' : pct > 50 ? '#f59e0b' : '#22c55e' }} />
                  </div>
                </div>
              );
            })}
            {utilizationData.provider_utilization.length === 0 && <p className="text-sm text-muted text-center py-4">No provider data</p>}
          </div>
        </div>

        <div className="bg-surface border border-border rounded-xl p-4">
          <h4 className="text-sm font-semibold text-heading mb-3">Resource Utilization</h4>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
            {utilizationData.resource_utilization.map(r => (
              <div key={r.id} className="bg-surface-secondary rounded-lg p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm font-medium text-heading">{r.name}</div>
                    <div className="text-[10px] text-muted capitalize">{r.type}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold text-heading">{r.booked_hours || 0}h</div>
                    <div className="text-[10px] text-muted">{r.total_bookings} bookings</div>
                  </div>
                </div>
              </div>
            ))}
            {utilizationData.resource_utilization.length === 0 && <p className="text-sm text-muted col-span-full text-center py-4">No resource data</p>}
          </div>
        </div>
      </div>
    );
  };

  const renderRulesTab = () => (
    <div className="space-y-6">
      <div className="bg-surface border border-border rounded-xl p-4">
        <h4 className="text-sm font-semibold text-heading mb-3">Booking Rules</h4>
        <p className="text-xs text-muted mb-4">Configure rules that govern how bookings are created. Rules can be set globally or per appointment type.</p>
        <BookingRulesManager tenantId={user?.tenantId || ''} appointmentTypes={appointmentTypes} isReadOnly={isReadOnly} />
      </div>

      <div className="bg-surface border border-border rounded-xl p-4">
        <h4 className="text-sm font-semibold text-heading mb-3">Reminder Configuration</h4>
        <ReminderConfigManager tenantId={user?.tenantId || ''} appointmentTypes={appointmentTypes} isReadOnly={isReadOnly} />
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <PageHeader
        icon={<Calendar className="h-5 w-5" />}
        title="Scheduling"
        description="Enterprise appointment management"
        actions={!isReadOnly && activeTab === 'calendar' ? (
          <button onClick={() => openBookingForm()} className="inline-flex items-center gap-2 px-3 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover transition-colors">
            <Plus className="h-4 w-4" /> New Booking
          </button>
        ) : undefined}
      />

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300 flex items-center justify-between">
          <span className="flex items-center gap-2"><AlertCircle className="h-4 w-4" />{error}</span>
          <button onClick={() => setError(null)} className="ml-2 underline text-xs">Dismiss</button>
        </div>
      )}

      <div className="flex gap-1 overflow-x-auto pb-1">
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              activeTab === tab.id ? 'bg-primary text-white' : 'bg-surface-secondary text-muted hover:text-heading'
            }`}>
            {tab.icon}{tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'calendar' && (
        <>
          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <div className="flex items-center justify-between p-3 border-b border-border flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <button onClick={() => navigate(-1)} className="p-1.5 rounded-lg hover:bg-surface-secondary"><ChevronLeft className="h-4 w-4" /></button>
                <h2 className="text-sm font-semibold text-heading min-w-[160px] text-center">
                  {view === 'day'
                    ? currentDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
                    : currentDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                </h2>
                <button onClick={() => navigate(1)} className="p-1.5 rounded-lg hover:bg-surface-secondary"><ChevronRight className="h-4 w-4" /></button>
                <button onClick={goToToday} className="px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded-md">Today</button>
              </div>

              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
                  <input type="text" placeholder="Search..." aria-label="Search scheduling" value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="pl-7 pr-3 py-1.5 text-xs rounded-lg border border-border bg-surface text-heading w-36 focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>

                <select value={filterProvider} onChange={e => setFilterProvider(e.target.value)}
                  className="px-2 py-1.5 text-xs rounded-lg border border-border bg-surface text-heading">
                  <option value="">All Providers</option>
                  {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>

                <select value={filterType} onChange={e => setFilterType(e.target.value)}
                  className="px-2 py-1.5 text-xs rounded-lg border border-border bg-surface text-heading">
                  <option value="">All Types</option>
                  {appointmentTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>

                <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                  className="px-2 py-1.5 text-xs rounded-lg border border-border bg-surface text-heading">
                  <option value="">All Statuses</option>
                  {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>

                <div className="flex gap-0.5 bg-surface-secondary rounded-lg p-0.5">
                  {(['day', 'week', 'month', 'agenda', 'resource'] as ViewMode[]).map(v => (
                    <button key={v} onClick={() => setView(v)}
                      className={`px-2.5 py-1 rounded-md text-[10px] font-medium transition-colors capitalize ${view === v ? 'bg-primary text-white' : 'text-muted hover:text-heading'}`}>
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {renderCalendarView()}
          </div>

          <div className="bg-surface border border-border rounded-xl p-4">
            <h3 className="font-semibold text-heading text-sm mb-3">Upcoming Appointments</h3>
            <div className="space-y-2">
              {bookings.filter(b => !['cancelled', 'rescheduled'].includes(b.status)).length === 0 ? (
                <EmptyState
                  icon={CheckCircle2}
                  title="No active bookings"
                  description="Active appointments for the selected period will appear here."
                  variant="compact"
                />
              ) : (
                bookings.filter(b => !['cancelled', 'rescheduled'].includes(b.status)).slice(0, 10).map(b => (
                  <div key={b.id} className="flex items-center justify-between p-3 rounded-lg bg-surface-secondary">
                    <button onClick={() => setShowDetailModal(b)} className="flex items-center gap-3 text-left flex-1 min-w-0">
                      <div className="w-1 h-8 rounded-full shrink-0" style={{ backgroundColor: b.appointment_type_color || '#3b82f6' }} />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-heading truncate">{b.title}</div>
                        <div className="text-xs text-muted truncate">
                          {formatDate(b.start_time)} {formatTime(b.start_time)} - {formatTime(b.end_time)}
                          {b.provider_name && ` | ${b.provider_name}`}
                          {b.contact_name && ` | ${b.contact_name}`}
                        </div>
                      </div>
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_COLORS[b.status]}`}>
                        {STATUS_LABELS[b.status] || b.status}
                      </span>
                      {!isReadOnly && b.status === 'pending' && (
                        <button onClick={() => transitionBooking(b.id, 'confirm')} className="p-1 rounded hover:bg-green-100 dark:hover:bg-green-900/30 text-green-600" title="Confirm">
                          <CheckCircle2 className="h-4 w-4" />
                        </button>
                      )}
                      {!isReadOnly && b.status === 'confirmed' && (
                        <button onClick={() => transitionBooking(b.id, 'check_in')} className="p-1 rounded hover:bg-purple-100 dark:hover:bg-purple-900/30 text-purple-600" title="Check In">
                          <UserCheck className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}

      {activeTab === 'providers' && <div className="bg-surface border border-border rounded-xl p-4">{renderProvidersTab()}</div>}
      {activeTab === 'types' && <div className="bg-surface border border-border rounded-xl p-4">{renderTypesTab()}</div>}
      {activeTab === 'resources' && <div className="bg-surface border border-border rounded-xl p-4">{renderResourcesTab()}</div>}
      {activeTab === 'waitlist' && <div className="bg-surface border border-border rounded-xl p-4">{renderWaitlistTab()}</div>}
      {activeTab === 'reports' && <div className="bg-surface border border-border rounded-xl p-4">{renderReportsTab()}</div>}
      {activeTab === 'utilization' && <div className="bg-surface border border-border rounded-xl p-4">{renderUtilizationTab()}</div>}
      {activeTab === 'rules' && renderRulesTab()}

      {/* Booking Form Modal */}
      {showForm && (
        <Modal open onClose={() => setShowForm(false)} ariaLabel={editingBooking ? 'Edit Booking' : 'New Booking'} panelClassName="bg-surface border border-border rounded-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="font-semibold text-heading">{editingBooking ? 'Edit Booking' : 'New Booking'}</h3>
              <button onClick={() => setShowForm(false)} className="text-muted hover:text-heading"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Title *</label>
                <input type="text" value={formData.title} onChange={e => setFormData(p => ({ ...p, title: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Start Time *</label>
                  <input type="datetime-local" value={formData.start_time} onChange={e => setFormData(p => ({ ...p, start_time: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">End Time *</label>
                  <input type="datetime-local" value={formData.end_time} onChange={e => setFormData(p => ({ ...p, end_time: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Provider</label>
                  <select value={formData.provider_id} onChange={e => setFormData(p => ({ ...p, provider_id: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    <option value="">None</option>
                    {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Appointment Type</label>
                  <select value={formData.appointment_type_id} onChange={e => {
                    const typeId = e.target.value;
                    setFormData(p => ({ ...p, appointment_type_id: typeId }));
                    if (typeId && formData.start_time) {
                      const t = appointmentTypes.find(at => at.id === typeId);
                      if (t) {
                        const start = new Date(formData.start_time);
                        const end = new Date(start.getTime() + t.duration_minutes * 60000);
                        setFormData(p => ({ ...p, end_time: end.toISOString().slice(0, 16), appointment_type_id: typeId }));
                      }
                    }
                  }}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    <option value="">None</option>
                    {appointmentTypes.map(t => <option key={t.id} value={t.id}>{t.name} ({t.duration_minutes}min)</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Resource</label>
                  <select value={formData.resource_id} onChange={e => setFormData(p => ({ ...p, resource_id: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    <option value="">None</option>
                    {resources.map(r => <option key={r.id} value={r.id}>{r.name} ({r.type})</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Status</label>
                  <select value={formData.status} onChange={e => setFormData(p => ({ ...p, status: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                    {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Contact Name</label>
                  <input type="text" value={formData.contact_name} onChange={e => setFormData(p => ({ ...p, contact_name: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">Contact Phone</label>
                  <input type="text" value={formData.contact_phone} onChange={e => setFormData(p => ({ ...p, contact_phone: e.target.value }))}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Contact Email</label>
                <input type="text" value={formData.contact_email} onChange={e => setFormData(p => ({ ...p, contact_email: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Location</label>
                <input type="text" value={formData.location} onChange={e => setFormData(p => ({ ...p, location: e.target.value }))}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted mb-1">Notes</label>
                <textarea value={formData.notes} onChange={e => setFormData(p => ({ ...p, notes: e.target.value }))} rows={2}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
              </div>
            </div>
            <div className="flex justify-end gap-2 p-4 border-t border-border">
              <button onClick={() => setShowForm(false)} className="px-4 py-2 rounded-lg text-sm font-medium text-muted hover:text-heading bg-surface-secondary">Cancel</button>
              <button onClick={saveBooking} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90">Save</button>
            </div>
        </Modal>
      )}

      {/* Booking Detail Modal */}
      {showDetailModal && (
        <Modal open onClose={() => setShowDetailModal(null)} ariaLabel="Appointment Details" panelClassName="bg-surface border border-border rounded-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-4 border-b border-border">
              <h3 className="font-semibold text-heading">Appointment Details</h3>
              <button onClick={() => setShowDetailModal(null)} className="text-muted hover:text-heading"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="text-lg font-semibold text-heading">{showDetailModal.title}</h4>
                  <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium mt-1 ${STATUS_COLORS[showDetailModal.status]}`}>
                    {STATUS_LABELS[showDetailModal.status] || showDetailModal.status}
                  </span>
                </div>
                {showDetailModal.appointment_type_color && (
                  <div className="w-4 h-4 rounded-full" style={{ backgroundColor: showDetailModal.appointment_type_color }} />
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-muted">Date:</span> <span className="text-heading font-medium">{formatDate(showDetailModal.start_time)}</span></div>
                <div><span className="text-muted">Time:</span> <span className="text-heading font-medium">{formatTime(showDetailModal.start_time)} - {formatTime(showDetailModal.end_time)}</span></div>
                {showDetailModal.provider_name && <div><span className="text-muted">Provider:</span> <span className="text-heading font-medium">{showDetailModal.provider_name}</span></div>}
                {showDetailModal.appointment_type_name && <div><span className="text-muted">Type:</span> <span className="text-heading font-medium">{showDetailModal.appointment_type_name}</span></div>}
                {showDetailModal.resource_name && <div><span className="text-muted">Resource:</span> <span className="text-heading font-medium">{showDetailModal.resource_name}</span></div>}
                {showDetailModal.location && <div><span className="text-muted">Location:</span> <span className="text-heading font-medium">{showDetailModal.location}</span></div>}
                {showDetailModal.contact_name && <div><span className="text-muted">Contact:</span> <span className="text-heading font-medium">{showDetailModal.contact_name}</span></div>}
                {showDetailModal.contact_phone && <div><span className="text-muted">Phone:</span> <span className="text-heading font-medium">{showDetailModal.contact_phone}</span></div>}
                {showDetailModal.contact_email && <div><span className="text-muted">Email:</span> <span className="text-heading font-medium">{showDetailModal.contact_email}</span></div>}
                <div><span className="text-muted">Source:</span> <span className="text-heading font-medium capitalize">{showDetailModal.booking_source}</span></div>
              </div>

              {showDetailModal.description && (
                <div><span className="text-xs text-muted">Description:</span><p className="text-sm text-heading mt-0.5">{showDetailModal.description}</p></div>
              )}
              {showDetailModal.notes && (
                <div><span className="text-xs text-muted">Notes:</span><p className="text-sm text-heading mt-0.5">{showDetailModal.notes}</p></div>
              )}
              {showDetailModal.cancellation_reason && (
                <div><span className="text-xs text-red-600">Cancellation Reason:</span><p className="text-sm text-heading mt-0.5">{showDetailModal.cancellation_reason}</p></div>
              )}

              {!isReadOnly && (
                <div className="flex flex-wrap gap-2 pt-2 border-t border-border">
                  {showDetailModal.status === 'pending' && (
                    <button onClick={() => transitionBooking(showDetailModal.id, 'confirm')} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-300">
                      <CheckCircle2 className="h-3 w-3" /> Confirm
                    </button>
                  )}
                  {showDetailModal.status === 'confirmed' && (
                    <button onClick={() => transitionBooking(showDetailModal.id, 'check_in')} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-purple-100 text-purple-800 hover:bg-purple-200 dark:bg-purple-900/30 dark:text-purple-300">
                      <UserCheck className="h-3 w-3" /> Check In
                    </button>
                  )}
                  {['checked_in', 'confirmed'].includes(showDetailModal.status) && (
                    <button onClick={() => transitionBooking(showDetailModal.id, 'complete')} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-100 text-blue-800 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-300">
                      <CheckCircle2 className="h-3 w-3" /> Complete
                    </button>
                  )}
                  {['confirmed', 'checked_in'].includes(showDetailModal.status) && (
                    <button onClick={() => {
                      const reason = prompt('No-show reason (optional):');
                      transitionBooking(showDetailModal.id, 'no_show', { cancellation_reason: reason || '' });
                    }} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-hover text-text-primary hover:bg-surface-hover">
                      <PhoneOff className="h-3 w-3" /> No Show
                    </button>
                  )}
                  {['pending', 'confirmed', 'checked_in'].includes(showDetailModal.status) && (
                    <button onClick={() => {
                      const reason = prompt('Cancellation reason:');
                      if (reason !== null) transitionBooking(showDetailModal.id, 'cancel', { cancellation_reason: reason });
                    }} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-300">
                      <XCircle className="h-3 w-3" /> Cancel
                    </button>
                  )}
                  {['cancelled', 'no_show', 'completed'].includes(showDetailModal.status) && (
                    <button onClick={() => transitionBooking(showDetailModal.id, 'reopen')} className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-orange-100 text-orange-800 hover:bg-orange-200 dark:bg-orange-900/30 dark:text-orange-300">
                      <RotateCcw className="h-3 w-3" /> Reopen
                    </button>
                  )}
                  <button onClick={() => { setShowDetailModal(null); openBookingForm(showDetailModal); }}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-surface-secondary text-heading hover:bg-surface-secondary/80">
                    <Edit2 className="h-3 w-3" /> Edit
                  </button>
                  <button onClick={() => { if (confirm(tenantT('common.confirms.delete_booking'))) deleteBooking(showDetailModal.id); }}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400">
                    <Trash2 className="h-3 w-3" /> Delete
                  </button>
                </div>
              )}
            </div>
        </Modal>
      )}

      {/* Provider Form Modal */}
      {showProviderForm && (
        <FormModal title={editingProvider ? 'Edit Provider' : 'New Provider'} onClose={() => setShowProviderForm(false)} onSave={saveProvider}>
          <FormField label="Name *" value={providerFormData.name} onChange={v => setProviderFormData(p => ({ ...p, name: v }))} />
          <FormField label="Specialty" value={providerFormData.specialty} onChange={v => setProviderFormData(p => ({ ...p, specialty: v }))} />
          <FormField label="Email" value={providerFormData.email} onChange={v => setProviderFormData(p => ({ ...p, email: v }))} />
          <FormField label="Phone" value={providerFormData.phone} onChange={v => setProviderFormData(p => ({ ...p, phone: v }))} />
          <FormField label="Location" value={providerFormData.location} onChange={v => setProviderFormData(p => ({ ...p, location: v }))} />
        </FormModal>
      )}

      {/* Appointment Type Form Modal */}
      {showTypeForm && (
        <FormModal title={editingType ? 'Edit Appointment Type' : 'New Appointment Type'} onClose={() => setShowTypeForm(false)} onSave={saveType}>
          <FormField label="Name *" value={typeFormData.name} onChange={v => setTypeFormData(p => ({ ...p, name: v }))} />
          <FormField label="Description" value={typeFormData.description} onChange={v => setTypeFormData(p => ({ ...p, description: v }))} />
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Duration (min)</label>
              <input type="number" value={typeFormData.duration_minutes} onChange={e => setTypeFormData(p => ({ ...p, duration_minutes: parseInt(e.target.value) || 30 }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Buffer (min)</label>
              <input type="number" value={typeFormData.buffer_minutes} onChange={e => setTypeFormData(p => ({ ...p, buffer_minutes: parseInt(e.target.value) || 0 }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Capacity</label>
              <input type="number" value={typeFormData.capacity} onChange={e => setTypeFormData(p => ({ ...p, capacity: parseInt(e.target.value) || 1 }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Color</label>
              <input type="color" value={typeFormData.color} onChange={e => setTypeFormData(p => ({ ...p, color: e.target.value }))}
                className="w-full h-9 rounded-lg border border-border bg-surface cursor-pointer" />
            </div>
            <div className="flex items-center gap-2 pt-5">
              <input type="checkbox" checked={typeFormData.allow_self_scheduling} onChange={e => setTypeFormData(p => ({ ...p, allow_self_scheduling: e.target.checked }))}
                className="rounded border-border" />
              <label className="text-xs text-muted">Allow Self-Scheduling</label>
            </div>
          </div>
        </FormModal>
      )}

      {/* Resource Form Modal */}
      {showResourceForm && (
        <FormModal title={editingResource ? 'Edit Resource' : 'New Resource'} onClose={() => setShowResourceForm(false)} onSave={saveResource}>
          <FormField label="Name *" value={resourceFormData.name} onChange={v => setResourceFormData(p => ({ ...p, name: v }))} />
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Type</label>
            <select value={resourceFormData.type} onChange={e => setResourceFormData(p => ({ ...p, type: e.target.value }))}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
              <option value="room">Room</option>
              <option value="equipment">Equipment</option>
              <option value="other">Other</option>
            </select>
          </div>
          <FormField label="Location" value={resourceFormData.location} onChange={v => setResourceFormData(p => ({ ...p, location: v }))} />
          <div>
            <label className="block text-xs font-medium text-muted mb-1">Capacity</label>
            <input type="number" value={resourceFormData.capacity} onChange={e => setResourceFormData(p => ({ ...p, capacity: parseInt(e.target.value) || 1 }))}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
          </div>
        </FormModal>
      )}

      {/* Waitlist Form Modal */}
      {showWaitlistForm && (
        <FormModal title="Add to Waitlist" onClose={() => setShowWaitlistForm(false)} onSave={addToWaitlist}>
          <FormField label="Contact Name *" value={waitlistFormData.contact_name} onChange={v => setWaitlistFormData(p => ({ ...p, contact_name: v }))} />
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Phone" value={waitlistFormData.contact_phone} onChange={v => setWaitlistFormData(p => ({ ...p, contact_phone: v }))} />
            <FormField label="Email" value={waitlistFormData.contact_email} onChange={v => setWaitlistFormData(p => ({ ...p, contact_email: v }))} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Appointment Type</label>
              <select value={waitlistFormData.appointment_type_id} onChange={e => setWaitlistFormData(p => ({ ...p, appointment_type_id: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                <option value="">Any</option>
                {appointmentTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted mb-1">Provider</label>
              <select value={waitlistFormData.provider_id} onChange={e => setWaitlistFormData(p => ({ ...p, provider_id: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30">
                <option value="">Any</option>
                {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          </div>
          <FormField label="Notes" value={waitlistFormData.notes} onChange={v => setWaitlistFormData(p => ({ ...p, notes: v }))} />
        </FormModal>
      )}
    </div>
  );
}

function FormModal({ title, onClose, onSave, children }: { title: string; onClose: () => void; onSave: () => void; children: React.ReactNode }) {
  return (
    <Modal open onClose={onClose} ariaLabel={title} panelClassName="bg-surface border border-border rounded-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h3 className="font-semibold text-heading">{title}</h3>
          <button onClick={onClose} className="text-muted hover:text-heading"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-4 space-y-3">{children}</div>
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm font-medium text-muted hover:text-heading bg-surface-secondary">Cancel</button>
          <button onClick={onSave} className="px-4 py-2 rounded-lg text-sm font-medium bg-primary text-white hover:bg-primary/90">Save</button>
        </div>
    </Modal>
  );
}

function FormField({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted mb-1">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-heading text-sm focus:outline-none focus:ring-2 focus:ring-primary/30" />
    </div>
  );
}

function BookingRulesManager({ tenantId, appointmentTypes, isReadOnly }: { tenantId: string; appointmentTypes: AppointmentType[]; isReadOnly: boolean }) {
  const [rules, setRules] = useState<Array<{
    id: string; appointment_type_id: string | null; appointment_type_name: string | null;
    min_lead_time_hours: number; max_lead_time_days: number; allow_same_day: boolean;
    allow_double_book: boolean; max_daily_bookings: number | null; max_per_slot: number; cancellation_window_hours: number;
  }>>([]);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    appointment_type_id: '', min_lead_time_hours: 0, max_lead_time_days: 90,
    allow_same_day: true, allow_double_book: false, max_per_slot: 1, cancellation_window_hours: 24,
  });

  useEffect(() => {
    api.get<{ rules: typeof rules }>('/scheduling/rules').then(d => setRules(d.rules)).catch(() => {});
  }, []);

  const save = async () => {
    try {
      await api.post('/scheduling/rules', {
        ...formData,
        appointment_type_id: formData.appointment_type_id || null,
      });
      setShowForm(false);
      const d = await api.get<{ rules: typeof rules }>('/scheduling/rules');
      setRules(d.rules);
    } catch { /* ignore */ }
  };

  return (
    <div className="space-y-3">
      {rules.map(r => (
        <div key={r.id} className="bg-surface-secondary rounded-lg p-3 text-xs space-y-1">
          <div className="font-medium text-heading">{r.appointment_type_name || 'Global (default)'}</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-muted">
            <span>Lead: {r.min_lead_time_hours}h</span>
            <span>Max: {r.max_lead_time_days}d</span>
            <span>Same-day: {r.allow_same_day ? 'Yes' : 'No'}</span>
            <span>Double-book: {r.allow_double_book ? 'Yes' : 'No'}</span>
            <span>Per slot: {r.max_per_slot}</span>
            <span>Cancel window: {r.cancellation_window_hours}h</span>
          </div>
        </div>
      ))}
      {rules.length === 0 && (
        <EmptyState
          icon={Settings}
          title="No rules configured"
          description="By default there are no booking restrictions. Add a rule to control lead times, double-booking, or per-slot capacity."
          primaryAction={!isReadOnly ? { label: 'Add Rule', icon: Plus, onClick: () => setShowForm(true) } : undefined}
          variant="compact"
        />
      )}
      {!isReadOnly && !showForm && (
        <button onClick={() => setShowForm(true)} className="text-xs text-primary hover:underline flex items-center gap-1">
          <Plus className="h-3 w-3" /> Add Rule
        </button>
      )}
      {showForm && (
        <div className="bg-surface-secondary rounded-lg p-3 space-y-2">
          <div>
            <label className="block text-[10px] font-medium text-muted mb-0.5">Appointment Type (blank = global)</label>
            <select value={formData.appointment_type_id} onChange={e => setFormData(p => ({ ...p, appointment_type_id: e.target.value }))}
              className="w-full px-2 py-1 text-xs rounded border border-border bg-surface text-heading">
              <option value="">Global</option>
              {appointmentTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-medium text-muted mb-0.5">Min Lead Time (hours)</label>
              <input type="number" value={formData.min_lead_time_hours} onChange={e => setFormData(p => ({ ...p, min_lead_time_hours: parseInt(e.target.value) || 0 }))}
                className="w-full px-2 py-1 text-xs rounded border border-border bg-surface text-heading" />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted mb-0.5">Max Lead Time (days)</label>
              <input type="number" value={formData.max_lead_time_days} onChange={e => setFormData(p => ({ ...p, max_lead_time_days: parseInt(e.target.value) || 90 }))}
                className="w-full px-2 py-1 text-xs rounded border border-border bg-surface text-heading" />
            </div>
          </div>
          <div className="flex gap-4 text-xs">
            <label className="flex items-center gap-1"><input type="checkbox" checked={formData.allow_same_day} onChange={e => setFormData(p => ({ ...p, allow_same_day: e.target.checked }))} className="rounded border-border" /> Same-day</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={formData.allow_double_book} onChange={e => setFormData(p => ({ ...p, allow_double_book: e.target.checked }))} className="rounded border-border" /> Double-book</label>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowForm(false)} className="px-3 py-1 text-xs rounded bg-surface-secondary text-muted">Cancel</button>
            <button onClick={save} className="px-3 py-1 text-xs rounded bg-primary text-white">Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReminderConfigManager({ tenantId, appointmentTypes, isReadOnly }: { tenantId: string; appointmentTypes: AppointmentType[]; isReadOnly: boolean }) {
  const [reminders, setReminders] = useState<Array<{
    id: string; appointment_type_name: string | null; reminder_type: string;
    channel: string; timing_minutes: number; template: string; is_active: boolean;
  }>>([]);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    appointment_type_id: '', reminder_type: 'reminder', channel: 'sms', timing_minutes: 1440, template: '',
  });

  useEffect(() => {
    api.get<{ reminders: typeof reminders }>('/scheduling/reminders').then(d => setReminders(d.reminders)).catch(() => {});
  }, []);

  const save = async () => {
    try {
      await api.post('/scheduling/reminders', {
        ...formData,
        appointment_type_id: formData.appointment_type_id || null,
      });
      setShowForm(false);
      const d = await api.get<{ reminders: typeof reminders }>('/scheduling/reminders');
      setReminders(d.reminders);
    } catch { /* ignore */ }
  };

  const deleteReminder = async (id: string) => {
    try {
      await api.delete(`/scheduling/reminders/${id}`);
      const d = await api.get<{ reminders: typeof reminders }>('/scheduling/reminders');
      setReminders(d.reminders);
    } catch { /* ignore */ }
  };

  const timingLabel = (mins: number) => {
    if (mins < 60) return `${mins} min`;
    if (mins < 1440) return `${Math.round(mins / 60)} hr`;
    return `${Math.round(mins / 1440)} day`;
  };

  return (
    <div className="space-y-3">
      {reminders.map(r => (
        <div key={r.id} className="flex items-center justify-between bg-surface-secondary rounded-lg p-3 text-xs">
          <div>
            <span className="font-medium text-heading capitalize">{r.reminder_type.replace('_', ' ')}</span>
            <span className="text-muted ml-2">via {r.channel} | {timingLabel(r.timing_minutes)} before</span>
            {r.appointment_type_name && <span className="text-muted ml-2">| {r.appointment_type_name}</span>}
          </div>
          {!isReadOnly && (
            <button onClick={() => deleteReminder(r.id)} className="p-1 rounded hover:bg-danger-light text-danger">
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      ))}
      {reminders.length === 0 && (
        <EmptyState
          icon={Clock}
          title="No reminders configured"
          description="Set up automated SMS, email, or call reminders to reduce no-shows."
          primaryAction={!isReadOnly ? { label: 'Add Reminder', icon: Plus, onClick: () => setShowForm(true) } : undefined}
          variant="compact"
        />
      )}
      {!isReadOnly && !showForm && (
        <button onClick={() => setShowForm(true)} className="text-xs text-primary hover:underline flex items-center gap-1">
          <Plus className="h-3 w-3" /> Add Reminder
        </button>
      )}
      {showForm && (
        <div className="bg-surface-secondary rounded-lg p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-medium text-muted mb-0.5">Type</label>
              <select value={formData.reminder_type} onChange={e => setFormData(p => ({ ...p, reminder_type: e.target.value }))}
                className="w-full px-2 py-1 text-xs rounded border border-border bg-surface text-heading">
                <option value="confirmation">Confirmation</option>
                <option value="reminder">Reminder</option>
                <option value="cancellation_followup">Cancellation Follow-up</option>
                <option value="reschedule_prompt">Reschedule Prompt</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted mb-0.5">Channel</label>
              <select value={formData.channel} onChange={e => setFormData(p => ({ ...p, channel: e.target.value }))}
                className="w-full px-2 py-1 text-xs rounded border border-border bg-surface text-heading">
                <option value="sms">SMS</option>
                <option value="email">Email</option>
                <option value="both">Both</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[10px] font-medium text-muted mb-0.5">Timing (minutes before)</label>
              <input type="number" value={formData.timing_minutes} onChange={e => setFormData(p => ({ ...p, timing_minutes: parseInt(e.target.value) || 60 }))}
                className="w-full px-2 py-1 text-xs rounded border border-border bg-surface text-heading" />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-muted mb-0.5">Appointment Type</label>
              <select value={formData.appointment_type_id} onChange={e => setFormData(p => ({ ...p, appointment_type_id: e.target.value }))}
                className="w-full px-2 py-1 text-xs rounded border border-border bg-surface text-heading">
                <option value="">All types</option>
                {appointmentTypes.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-muted mb-0.5">Template</label>
            <textarea value={formData.template} onChange={e => setFormData(p => ({ ...p, template: e.target.value }))} rows={2}
              placeholder="Hi {contact_name}, reminder about your {appointment_type} on {date} at {time}."
              className="w-full px-2 py-1 text-xs rounded border border-border bg-surface text-heading" />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowForm(false)} className="px-3 py-1 text-xs rounded bg-surface-secondary text-muted">Cancel</button>
            <button onClick={save} className="px-3 py-1 text-xs rounded bg-primary text-white">Save</button>
          </div>
        </div>
      )}
    </div>
  );
}
