import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import type { AppContextValue, HabitItem } from "../types";

function freqText(frequency: string, per: number): string {
  if (frequency === "每周") return `每周 ${per > 0 ? per : 3} 次`;
  if (frequency === "每月") return `每月 ${per > 0 ? per : 1} 次`;
  return "每天";
}

function monthDayLabel(value: string | null): string {
  if (!value) return "";
  const [, month, day] = value.slice(0, 10).split("-");
  return `${Number(month)} 月 ${Number(day)} 日`;
}

export function Habits({ ctx }: { ctx: AppContextValue }) {
  const [items, setItems] = useState<HabitItem[]>([]);
  const [today, setToday] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<{ today: string; items: HabitItem[] }>("/habits");
      setItems(data.items);
      setToday(data.today);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.refreshKey]);

  const withBusy = async (habit: HabitItem, action: () => Promise<unknown>, message: string) => {
    if (busyId !== null) return;
    setBusyId(habit.id);
    try {
      await action();
      ctx.toast(message);
      await load();
      ctx.refresh();
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      setBusyId(null);
    }
  };

  const check = (habit: HabitItem) =>
    withBusy(habit, () => api.post(`/habits/${habit.id}/check`, {}), `「${habit.title}」今日打卡 ✓`);

  const uncheck = (habit: HabitItem) =>
    withBusy(habit, () => api.del(`/habits/${habit.id}/check?date=${today}`), "已取消今日打卡");

  const resume = (habit: HabitItem) =>
    withBusy(habit, () => api.patch(`/habits/${habit.id}`, { status: "进行中" }), "已恢复");

  const active = items.filter((item) => item.status !== "已暂停");
  const paused = items.filter((item) => item.status === "已暂停");
  const doneToday = active.filter((item) => item.today_done).length;

  if (loading && items.length === 0 && !error) {
    return (
      <div className="stack">
        {Array.from({ length: 3 }).map((_, index) => (
          <div className="skeleton row-skeleton" key={index} />
        ))}
      </div>
    );
  }

  if (error && items.length === 0) {
    return (
      <div className="panel empty">
        <b>读取坚持事项失败</b>
        <p>{error}</p>
        <button type="button" className="primary" onClick={() => void load()}>重试</button>
      </div>
    );
  }

  return (
    <div>
      <div className="habit-head">
        <div>
          <b>坚持打卡</b>
          <span>每天做到就点一下，按月看进度</span>
        </div>
        <button type="button" className="primary" onClick={() => ctx.openHabit()}>
          ＋ 新增坚持事项
        </button>
      </div>

      {active.length > 0 ? (
        <div className="habit-today">
          今天 {doneToday} / {active.length} 件
          {doneToday === active.length ? " · 全打卡，漂亮" : ` · 还有 ${active.length - doneToday} 件没点`}
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="panel empty">
          <b>还没有坚持事项</b>
          <p>把想长期坚持的事列出来，每天做到就点一下打卡，按月看进度。</p>
          <div className="ex-list">
            {["健身 · 每周 3 次", "读书 · 每天 30 分钟", "早睡 · 每天"].map((example) => (
              <span key={example}>{example}</span>
            ))}
          </div>
          <button type="button" className="primary" onClick={() => ctx.openHabit()}>
            添加第一件
          </button>
        </div>
      ) : (
        <div className="habit-grid">
          {items.map((habit) => {
            const isPaused = habit.status === "已暂停";
            const metaParts = [freqText(habit.frequency, habit.target_count)];
            if (habit.start_date) metaParts.push(`自 ${habit.start_date.slice(0, 10)}`);
            if (habit.streak) metaParts.push(`连续 ${habit.streak} 天`);
            if (habit.last_done) metaParts.push(`最近 ${monthDayLabel(habit.last_done)}`);
            return (
              <article className={`habit-card ${isPaused ? "is-paused" : ""}`} key={habit.id}>
                <div className="hc-top">
                  <div className="hc-name">{habit.title}</div>
                  {isPaused ? (
                    <span className="tag">已暂停</span>
                  ) : (
                    <span className={`tag ${habit.today_done ? "ok" : "warn"}`}>{habit.today_done ? "今日已打卡" : "今日未打卡"}</span>
                  )}
                </div>
                <div className="hc-meta">{metaParts.join(" · ")}</div>
                <div className="hc-prog-row">
                  <div className="prog" style={{ flex: 1, margin: 0 }}>
                    <i style={{ width: `${Math.min(100, Math.max(0, habit.progress))}%` }} />
                  </div>
                  <span className="hc-count">{habit.month_done} / {habit.month_goal} 天</span>
                </div>
                <div className="hc-actions">
                  {isPaused ? (
                    <button type="button" className="ghost" disabled={busyId !== null} onClick={() => void resume(habit)}>
                      恢复
                    </button>
                  ) : habit.today_done ? (
                    <button type="button" className="ghost" disabled={busyId !== null} onClick={() => void uncheck(habit)}>
                      取消今日打卡
                    </button>
                  ) : (
                    <button type="button" className="primary" disabled={busyId !== null} onClick={() => void check(habit)}>
                      ✓ 今日打卡
                    </button>
                  )}
                  <button type="button" className="ghost" onClick={() => ctx.openHabit(habit)}>
                    编辑
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {paused.length > 0 ? (
        <p className="muted" style={{ marginTop: 12 }}>
          已暂停 {paused.length} 件：暂停的事项不计入今日打卡，点「恢复」可以继续。
        </p>
      ) : null}
    </div>
  );
}
