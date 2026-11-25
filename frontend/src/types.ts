export type User = {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
  gender: string | null;
  birthday: string | null;
  roles: string[];
  groups: string[];
  is_admin: boolean;
  last_login_at: string | null;
};

export type SessionData = {
  user: User | null;
  is_admin: boolean;
  modules: string[];
};

export type Brand = {
  name: string;
  subtitle: string;
  logo_url: string;
  default_name?: string;
  default_subtitle?: string;
};

export type HabitItem = {
  id: number;
  title: string;
  frequency: string;
  target_count: number;
  status: string;
  start_date: string | null;
  note: string | null;
  month_done: number;
  month_goal: number;
  progress: number;
  streak: number;
  today_done: boolean;
  today_log_id: number | null;
  last_done: string | null;
};

export type Overview = {
  today: string;
  week_start: string;
  kpi: {
    todo_open: number;
    todo_overdue: number;
    todo_done_today: number;
    focus_week_minutes: number;
    focus_today_minutes: number;
    focus_7_minutes: number;
    focus_week_sessions: number;
    wake_days: number;
    wake_hits: number;
    wake_rate: number | null;
    sleep_avg_7: number | null;
    workout_month_count: number;
    workout_month_minutes: number;
    study_month_minutes: number;
    money_total: number | null;
    money_month: string;
    money_accounts: number;
    milestone_open: number;
    milestone_done: number;
    milestone_total: number;
    milestone_rate: number | null;
  };
  focus_trend: { date: string; minutes: number }[];
  sleep_trend: { date: string; hours: number | null }[];
  todos: RecordItem[];
  money_accounts: { account: string; opening: number; closing: number; net: number }[];
  finance_trend: { month: string; total: number; accounts: number }[];
  milestones: RecordItem[];
  today_focus: { id: number; item: string; type: string; minutes: number }[];
  habits: HabitItem[];
  today_sleep: RecordItem | null;
  today_log: RecordItem | null;
  review: RecordItem | null;
};

export type RecordItem = Record<string, unknown> & { id?: number };

export type ToastAction = { label: string; run: () => void };

export type AppContextValue = {
  session: SessionData;
  brand: Brand;
  refreshKey: number;
  refresh: () => void;
  toast: (message: string, action?: ToastAction) => void;
  openForm: (module: string, item?: RecordItem) => void;
  openHabit: (item?: HabitItem) => void;
  openReview: () => void;
  go: (key: string) => void;
};

