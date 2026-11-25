import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import type { AppContextValue, HabitItem, Overview, RecordItem } from "../types";

function fmtMinutes(minutes: number): { value: string; unit: string } {
  if (minutes < 60) return { value: String(minutes), unit: "分钟" };
  return { value: String(Math.round((minutes / 60) * 10) / 10), unit: "小时" };
}

function weekday(day: string): string {
  const names = ["日", "一", "二", "三", "四", "五", "六"];
  return names[new Date(`${day}T00:00:00`).getDay()];
}

function daysLeft(target: unknown, today: string): number | null {
  if (!target) return null;
  const diff = (new Date(`${String(target).slice(0, 10)}T00:00:00`).getTime() - new Date(`${today}T00:00:00`).getTime()) / 86400000;
  return Number.isFinite(diff) ? Math.round(diff) : null;
}

export function Dashboard({ ctx }: { ctx: AppContextValue }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busyTodo, setBusyTodo] = useState<number | null>(null);
  const [punching, setPunching] = useState(false);
  const [busyHabit, setBusyHabit] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      setData(await api.get<Overview>("/overview"));
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

  const toggle = async (id: number, done: boolean) => {
    if (busyTodo !== null) return;
    setBusyTodo(id);
    try {
      await api.post(`/data/todos/${id}/toggle`, { done: !done });
      ctx.toast(done ? "已恢复为未完成" : "已完成");
      ctx.refresh();
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      setBusyTodo(null);
    }
  };

  const punch = async (kind: "wake" | "sleep") => {
    if (punching) return;
    setPunching(true);
    try {
      const now = new Date();
      const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      const result = await api.post<{ shifted: boolean; achieved: boolean; item?: { hours?: number } }>("/data/sleep/punch", {
        kind,
        time,
      });
      const hours = result.item?.hours;
      const detail =
        kind === "wake"
          ? `${result.achieved ? "达标" : "未达标"}${hours ? ` · 睡了 ${hours} 小时` : ""}`
          : result.shifted
            ? "已记到昨天"
            : "已记录";
      ctx.toast(`${kind === "wake" ? "起床" : "睡前"}打卡 ${time} · ${detail}`);
      ctx.refresh();
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      setPunching(false);
    }
  };

  const openMoney = async () => {
    try {
      const { items } = await api.get<{ items: RecordItem[] }>("/data/money");
      const month = (data?.today || "").slice(0, 7);
      const sameMonth = items.filter((row) => String(row.month).slice(0, 7) === month);
      const existing = sameMonth.find((row) => row.account === "支付宝") || sameMonth[0];
      ctx.openForm("money", existing || { account: "支付宝", month: `${month}-01` });
    } catch {
      ctx.openForm("money");
    }
  };

  const quickOpen = (key: string) => {
    if (key === "daily" && data?.today_log) {
      ctx.openForm("daily", data.today_log);
      return;
    }
    if (key === "sleep" && data?.today_sleep) {
      ctx.openForm("sleep", data.today_sleep);
      return;
    }
    if (key === "habits") {
      ctx.go("habits");
      return;
    }
    if (key === "money") {
      void openMoney();
      return;
    }
    ctx.openForm(key);
  };

  const toggleHabit = async (habit: HabitItem) => {
    if (busyHabit !== null) return;
    setBusyHabit(habit.id);
    try {
      if (habit.today_done) {
        await api.del(`/habits/${habit.id}/check?date=${data?.today || ""}`);
        ctx.toast("已取消今日打卡");
      } else {
        await api.post(`/habits/${habit.id}/check`, {});
        ctx.toast(`「${habit.title}」今日打卡 ✓`);
      }
      ctx.refresh();
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      setBusyHabit(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="skeleton-grid">
        {Array.from({ length: 6 }).map((_, index) => (
          <div className="skeleton" key={index} />
        ))}
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="panel empty">
        <b>暂时读不到数据</b>
        <p>{error}</p>
        <button type="button" className="primary" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }
  if (!data) return null;

  const kpi = data.kpi;
  const focus = fmtMinutes(kpi.focus_7_minutes);
  const todayFocus = fmtMinutes(kpi.focus_today_minutes);
  const study = fmtMinutes(kpi.study_month_minutes);
  const maxFocus = Math.max(...data.focus_trend.map((item) => item.minutes), 1);
  const maxMoney = Math.max(...data.finance_trend.map((item) => item.total), 1);
  const empty =
    kpi.todo_open + kpi.focus_7_minutes + kpi.wake_days + kpi.workout_month_count + kpi.study_month_minutes + kpi.milestone_open === 0;

  return (
    <div>
      {empty ? (
        <div className="guide">
          <h4>还是空的，从这里开始</h4>
          <p>先记一条，明天就有数可看了。三天之后这里会开始像仪表盘。</p>
          <div className="guide-steps">
            <div>
              <i>01</i>
              <b>随手记一件</b>
              <span>点「记一笔」，待办、专注、日志都能记。</span>
            </div>
            <div>
              <i>02</i>
              <b>每天两个动作</b>
              <span>早上起床打卡，睡前打卡。忘了第二天补也行。</span>
            </div>
            <div>
              <i>03</i>
              <b>每周一次回顾</b>
              <span>三个问题，5 分钟，把这一周收个尾。</span>
            </div>
          </div>
        </div>
      ) : null}

      <div className="kpi-grid">
        <div className="kpi">
          <div className="label">待办</div>
          <div className="value">
            {kpi.todo_open}
            <span>件未完成</span>
          </div>
          <div className="hint">{kpi.todo_overdue ? `${kpi.todo_overdue} 件已过期` : "没有逾期"}</div>
        </div>
        <div className="kpi">
          <div className="label">本周专注</div>
          <div className="value">
            {fmtMinutes(kpi.focus_week_minutes).value}
            <span>{fmtMinutes(kpi.focus_week_minutes).unit}</span>
          </div>
          <div className="hint">今天 {todayFocus.value} {todayFocus.unit}</div>
        </div>
        <div className="kpi">
          <div className="label">起床达标</div>
          <div className="value">
            {kpi.wake_hits}/{kpi.wake_days}
            <span>天</span>
          </div>
          <div className="hint">{kpi.wake_rate == null ? "还没有打卡" : `${kpi.wake_rate}% 达标`}</div>
        </div>
        <div className="kpi">
          <div className="label">本月运动</div>
          <div className="value">
            {kpi.workout_month_count}
            <span>次</span>
          </div>
          <div className="hint">累计 {kpi.workout_month_minutes} 分钟</div>
        </div>
        <div className="kpi">
          <div className="label">本月学习</div>
          <div className="value">
            {study.value}
            <span>{study.unit}</span>
          </div>
          <div className="hint">来自「专注学习」</div>
        </div>
        <div className="kpi">
          <div className="label">本月余额</div>
          <div className="value">
            {kpi.money_total == null ? "—" : kpi.money_total.toLocaleString("zh-CN")}
            <span>元</span>
          </div>
          <div className="hint">{kpi.money_total == null ? "还没有账户记录" : `${kpi.money_accounts} 个账户 · ${kpi.money_month}`}</div>
        </div>
      </div>

      <div className="cols">
        <div>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>专注节奏</h3>
                <div className="sub">近 7 天 · 分钟 · 合计 {kpi.focus_7_minutes}</div>
              </div>
              <button type="button" className="link" onClick={() => ctx.openForm("focus")}>
                记一段 →
              </button>
            </div>
            <div className="panel-body">
              <div className="chart">
                {data.focus_trend.map((item, index) => (
                  <div className="bar-col" key={item.date}>
                    <div className="bar-val">{item.minutes}</div>
                    <div
                      className={`bar ${index === data.focus_trend.length - 1 ? "hot" : ""}`}
                      style={{ height: `${Math.max(4, Math.round((item.minutes / maxFocus) * 100))}%` }}
                    />
                    <div className="bar-label">{index === data.focus_trend.length - 1 ? "今天" : `周${weekday(item.date)}`}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>今日坚持</h3>
                <div className="sub">
                  {data.habits.length
                    ? `今天 ${data.habits.filter((habit) => habit.today_done).length} / ${data.habits.length} 件`
                    : "还没有坚持事项"}
                </div>
              </div>
              <button type="button" className="link" onClick={() => ctx.go("habits")}>
                坚持打卡 →
              </button>
            </div>
            <div className="panel-body">
              {data.habits.length === 0 ? (
                <div className="empty small">
                  <b>还没有坚持事项</b>
                  <p>点右上角「坚持打卡」去加一件想长期坚持的事。</p>
                </div>
              ) : (
                data.habits.map((habit) => (
                  <div className="row-item" key={habit.id}>
                    <div className="row-copy">
                      <div className="t">{habit.title}</div>
                      <div className="s">
                        {habit.month_done} / {habit.month_goal} 天{habit.streak ? ` · 连续 ${habit.streak} 天` : ""}
                      </div>
                      <div className="prog">
                        <i style={{ width: `${Math.min(100, Math.max(0, habit.progress))}%` }} />
                      </div>
                    </div>
                    <div className="row-actions">
                      <span className={`tag ${habit.today_done ? "ok" : "warn"}`}>{habit.today_done ? "已打卡" : "未打卡"}</span>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busyHabit !== null}
                        onClick={() => void toggleHabit(habit)}
                      >
                        {habit.today_done ? "取消" : "打卡"}
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>今天在专注什么</h3>
                <div className="sub">
                  {data.today_focus.length ? `${data.today_focus.length} 段 · 合计 ${todayFocus.value} ${todayFocus.unit}` : "今天还没有专注记录"}
                </div>
              </div>
              <button type="button" className="link" onClick={() => ctx.openForm("focus")}>
                记一段 →
              </button>
            </div>
            <div className="panel-body">
              {data.today_focus.length === 0 ? (
                <div className="empty small">
                  <b>今天还没有专注记录</b>
                  <p>一段一记，45 分钟起算；学到的顺手写一句收获。</p>
                </div>
              ) : (
                data.today_focus.map((item) => (
                  <div className="fin-row" key={item.id}>
                    <span className="acct">
                      <i>{item.type.slice(0, 1)}</i>
                      {item.item}
                    </span>
                    <b className="muted">{item.minutes} 分钟</b>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>今天要做</h3>
                <div className="sub">{kpi.todo_open} 件未完成 · 按截止日期排列</div>
              </div>
              <button type="button" className="link" onClick={() => ctx.openForm("todos")}>
                ＋ 新增
              </button>
            </div>
            <div className="panel-body">
              {data.todos.length === 0 ? (
                <div className="empty small">
                  <b>今天还没有待办</b>
                  <p>只登记明天有人问起来答不上来会出问题的那种事。</p>
                </div>
              ) : (
                data.todos.map((todo) => {
                  const done = todo.status === "done";
                  return (
                    <div className={`row-item ${done ? "is-done" : ""}`} key={String(todo.id)}>
                      <button
                        type="button"
                        className={`check ${done ? "on" : ""}`}
                        aria-label={done ? "标记未完成" : "标记完成"}
                        disabled={busyTodo !== null}
                        onClick={() => void toggle(Number(todo.id), done)}
                      >
                        ✓
                      </button>
                      <div className="row-copy">
                        <div className="t">{String(todo.title)}</div>
                        <div className="s">
                          {String(todo.category || "工作")} · {todo.due_date ? String(todo.due_date) : "未设截止"}
                        </div>
                      </div>
                      <span className={`tag ${todo.priority === "P0" ? "hot" : todo.priority === "P1" ? "warn" : ""}`}>
                        {String(todo.priority || "P1")}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>

        <div>
          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>睡眠</h3>
                <div className="sub">近 7 天 · {kpi.sleep_avg_7 ?? "—"} 小时均值</div>
              </div>
              <button type="button" className="link" onClick={() => void punch("sleep")}>
                打卡 →
              </button>
            </div>
            <div className="panel-body">
              <div className="chart mini">
                {data.sleep_trend.map((item, index) => (
                  <div className="bar-col" key={item.date}>
                    <div className="bar" style={{ height: `${item.hours ? Math.min(100, (item.hours / 10) * 100) : 4}%` }} />
                    <div className="bar-label">{index === data.sleep_trend.length - 1 ? "今" : weekday(item.date)}</div>
                  </div>
                ))}
              </div>
              <div className="btn-row">
                <button type="button" className="primary" onClick={() => void punch("wake")}>
                  起床打卡
                </button>
                <button type="button" onClick={() => void punch("sleep")}>
                  睡前打卡
                </button>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>资金</h3>
                <div className="sub">{kpi.money_month || "本月"} · {kpi.money_accounts} 个账户</div>
              </div>
              <button type="button" className="link" onClick={() => void openMoney()}>
                记这个月 →
              </button>
            </div>
            <div className="panel-body">
              {data.money_accounts.length === 0 ? (
                <div className="empty small">
                  <b>还没有月度余额</b>
                  <p>月底填两个数：期初、期末，净变动自动算。</p>
                </div>
              ) : (
                <>
                  <div className="fin-sum">
                    <b>¥{(kpi.money_total ?? 0).toLocaleString("zh-CN")}</b>
                    <span>期末合计</span>
                  </div>
                  {data.finance_trend.length > 1 ? (
                    <div className="chart mini">
                      {data.finance_trend.map((point) => (
                        <div className="bar-col" key={point.month}>
                          <div
                            className="bar"
                            style={{ height: `${point.total > 0 ? Math.max(8, Math.round((point.total / maxMoney) * 100)) : 4}%` }}
                            title={`${point.month} · ¥${point.total.toLocaleString("zh-CN")} · ${point.accounts} 个账户`}
                          />
                          <div className="bar-label">{point.month.slice(5)} 月</div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {data.money_accounts.slice(0, 4).map((item) => (
                    <div className="fin-row" key={item.account}>
                      <span className="acct">
                        <i>{item.account.slice(0, 1)}</i>
                        {item.account}
                      </span>
                      <b className={item.net >= 0 ? "up" : "down"}>
                        {item.net >= 0 ? "+" : ""}
                        {item.net.toLocaleString("zh-CN")}
                      </b>
                    </div>
                  ))}
                </>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>年度里程碑</h3>
                <div className="sub">
                  {kpi.milestone_done}/{kpi.milestone_total} 已完成 · {kpi.milestone_open} 件进行中
                </div>
              </div>
              <button type="button" className="link" onClick={() => ctx.go("milestones")}>
                全部 →
              </button>
            </div>
            <div className="panel-body">
              {data.milestones.length === 0 ? (
                <div className="empty small">
                  <b>还没有里程碑</b>
                  <p>只写真正在乎的，五件起。</p>
                </div>
              ) : (
                data.milestones.map((item) => {
                  const left = daysLeft(item.target_date, data.today);
                  const leftText = left === null ? "" : left < 0 ? ` · 超期 ${Math.abs(left)} 天` : ` · 剩 ${left} 天`;
                  return (
                    <div className="row-item" key={String(item.id)}>
                      <div className="row-copy">
                        <div className="t">{String(item.title)}{leftText}</div>
                        <div className="s">{String(item.metric || item.next_step || "还没有下一步")}</div>
                        <div className="prog">
                          <i style={{ width: `${Math.min(100, Math.max(0, Number(item.progress || 0)))}%` }} />
                        </div>
                      </div>
                      <span className="tag">{Number(item.progress || 0)}%</span>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </div>

      <div className="review-strip">
        <div>
          <b>{data.review ? "本周回顾已完成" : "本周回顾：3 个问题，5 分钟"}</b>
          <span>{data.review ? String(data.review.next_focus || "下周最重要的一件事已经写下。") : "做完这一周才算真的结束。"}</span>
        </div>
        <button type="button" className="primary" onClick={ctx.openReview}>
          {data.review ? "再改一版" : "开始回顾"}
        </button>
      </div>

      <div className="section-head">
        <h3>快速记录</h3>
        <span className="muted">选一类，填两三个空就够</span>
      </div>
      <div className="quick-row">
        {[
          ["todos", "☷", "待办"],
          ["habits", "◈", "坚持打卡"],
          ["focus", "◷", "专注"],
          ["daily", "✎", "日志"],
          ["sleep", "◒", "睡眠"],
          ["workouts", "△", "健身"],
          ["milestones", "◇", "里程碑"],
          ["money", "¥", "月度余额"],
        ].map(([key, icon, label]) => (
          <button type="button" key={key} onClick={() => quickOpen(key)}>
            {icon} {label}
          </button>
        ))}
      </div>
    </div>
  );
}
