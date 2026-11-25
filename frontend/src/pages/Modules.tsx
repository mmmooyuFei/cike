import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import { MODULE_LABELS } from "../components";
import type { AppContextValue, RecordItem } from "../types";

function isoToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function monthStart(): string {
  return `${isoToday().slice(0, 7)}-01`;
}

function fmtDay(value: unknown): string {
  return value ? String(value).slice(0, 10) : "未填日期";
}

function num(value: unknown): number {
  return Number(value || 0);
}

export function ModulePage({ module, ctx }: { module: string; ctx: AppContextValue }) {
  const [items, setItems] = useState<RecordItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [account, setAccount] = useState("全部");
  const [punching, setPunching] = useState(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<{ items: RecordItem[] }>(`/data/${module}`);
      setItems(data.items);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [module, ctx.refreshKey]);

  const remove = async (item: RecordItem) => {
    try {
      await api.del(`/data/${module}/${item.id}`);
      setItems((current) => current.filter((row) => row.id !== item.id));
      ctx.toast("已删除", {
        label: "撤销",
        run: async () => {
          try {
            await api.post(`/data/${module}/${item.id}/restore`);
            ctx.toast("已恢复");
            ctx.refresh();
          } catch (err) {
            ctx.toast(errorText(err));
          }
        },
      });
    } catch (err) {
      ctx.toast(errorText(err));
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

  const header = (
    <div className="toolbar">
      <div className="muted">{loading ? "加载中…" : `共 ${items.length} 条`}</div>
      <button type="button" className="primary" onClick={() => ctx.openForm(module)}>
        ＋ {MODULE_LABELS[module]}
      </button>
    </div>
  );

  if (loading) {
    return (
      <div className="stack">
        {Array.from({ length: 3 }).map((_, index) => (
          <div className="skeleton row-skeleton" key={index} />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="panel empty">
        <b>读取失败</b>
        <p>{error}</p>
        <button type="button" className="primary" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  if (module === "milestones") {
    return (
      <div>
        {header}
        {items.length === 0 ? (
          <Empty title="还没有里程碑" body="只写真正在乎的，五件起。" action={() => ctx.openForm(module)} examples={["月利润稳定过 150 万 · Q4", "体重降到 75kg 以内 · 全年"]} />
        ) : (
          <div className="cards">
            {items.map((item) => (
              <article
                className="panel card"
                key={String(item.id)}
                role="button"
                tabIndex={0}
                onClick={() => ctx.openForm(module, item)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    ctx.openForm(module, item);
                  }
                }}
              >
                <div className="card-top">
                  <span className={`tag ${item.status === "已完成" ? "ok" : item.status === "已放弃" ? "warn" : ""}`}>{String(item.status || "进行中")}</span>
                  <div className="row-actions">
                    <span className="muted">{String(item.quarter || "")}</span>
                    <button
                      type="button"
                      className="ghost danger-text"
                      onClick={(event) => {
                        event.stopPropagation();
                        void remove(item);
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
                <h3 className="card-title">{String(item.title)}</h3>
                <div className="card-meta">{String(item.metric || item.next_step || "还没有衡量标准")}</div>
                <div className="prog">
                  <i style={{ width: `${Math.min(100, Math.max(0, num(item.progress)))}%` }} />
                </div>
                <div className="card-meta">{num(item.progress)}%</div>
              </article>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (module === "daily") {
    return (
      <div>
        {header}
        {items.length === 0 ? (
          <Empty title="还没有每日日志" body="今天做了什么、明天打算、卡在哪。同一天只保留一条。" action={() => ctx.openForm(module)} examples={["今天谈定了排产，明天跟进样品确认", "卡点：物流报价没回，明天再催"]} />
        ) : (
          <div className="stack">
            {items.map((item) => (
              <article className="panel log" key={String(item.id)}>
                <div className="panel-head">
                  <h3>{fmtDay(item.log_date)}</h3>
                  <div className="row-actions">
                    <button type="button" className="ghost" onClick={() => ctx.openForm(module, item)}>
                      编辑
                    </button>
                    <button type="button" className="ghost danger-text" onClick={() => void remove(item)}>
                      删除
                    </button>
                  </div>
                </div>
                <div className="panel-body">
                  <p className="log-text">{String(item.content || "（没有写今日内容）")}</p>
                  {item.tomorrow_plan ? <p className="log-text"><b>明天：</b>{String(item.tomorrow_plan)}</p> : null}
                  {item.blockers ? <p className="log-text"><b>卡点：</b>{String(item.blockers)}</p> : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (module === "sleep") {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 6);
    const cutoff = `${cutoffDate.getFullYear()}-${String(cutoffDate.getMonth() + 1).padStart(2, "0")}-${String(cutoffDate.getDate()).padStart(2, "0")}`;
    const last7 = items.filter((item) => String(item.record_date) >= cutoff).slice(0, 7);
    const hours = last7.filter((item) => item.hours).map((item) => num(item.hours));
    const avg = hours.length ? Math.round((hours.reduce((sum, value) => sum + value, 0) / hours.length) * 10) / 10 : null;
    const hits = last7.filter((item) => item.achieved).length;
    return (
      <div>
        <div className="kpi-grid two">
          <div className="kpi">
            <div className="label">近 7 天平均睡眠</div>
            <div className="value">{avg ?? "—"}<span>小时</span></div>
            <div className="hint">只统计有记录的日期</div>
          </div>
          <div className="kpi">
            <div className="label">起床达标</div>
            <div className="value">{hits}<span>天</span></div>
            <div className="hint">{last7.length ? `${Math.round((hits / last7.length) * 100)}% 达标` : "还没有打卡"}</div>
          </div>
        </div>
        <div className="toolbar">
          <div className="muted">凌晨 0–6 点睡前打卡自动归到前一天</div>
          <div className="btn-row">
            <button type="button" disabled={punching} onClick={() => void punch("wake")}>起床打卡</button>
            <button type="button" className="primary" disabled={punching} onClick={() => void punch("sleep")}>睡前打卡</button>
          </div>
        </div>
        {items.length === 0 ? (
          <Empty title="还没有睡眠记录" body="平时点打卡，这里看历史、补卡。" action={() => ctx.openForm(module)} examples={["11 月 24 日 · 睡 00:40 → 起 07:30 · 6.8 小时"]} />
        ) : (
          <div className="stack">
            {items.map((item) => (
              <div className="panel row-panel" key={String(item.id)}>
                <div className="row-copy">
                  <div className="t">{fmtDay(item.record_date)} · {String(item.bed_time || "--:--")} → {String(item.wake_time || "--:--")}</div>
                  <div className="s">{item.hours ? `${item.hours} 小时` : "还没有睡眠时长"}</div>
                </div>
                <span className={`tag ${item.achieved ? "ok" : "warn"}`}>{item.achieved ? "达标" : "未达标"}</span>
                <div className="row-actions">
                  <button type="button" className="ghost" onClick={() => ctx.openForm(module, item)}>编辑</button>
                  <button type="button" className="ghost danger-text" onClick={() => void remove(item)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (module === "focus" || module === "workouts") {
    const monthItems = items.filter((item) => String(item[module === "focus" ? "session_date" : "workout_date"]) >= monthStart());
    const minutes = monthItems.reduce((sum, item) => sum + num(item.minutes), 0);
    return (
      <div>
        <div className="kpi-grid two">
          <div className="kpi">
            <div className="label">{module === "focus" ? "本月专注" : "本月训练"}</div>
            <div className="value">{module === "focus" ? Math.round((minutes / 60) * 10) / 10 : monthItems.length}<span>{module === "focus" ? "小时" : "次"}</span></div>
            <div className="hint">{module === "focus" ? `${monthItems.length} 段` : `累计 ${minutes} 分钟`}</div>
          </div>
          <div className="kpi">
            <div className="label">记录总数</div>
            <div className="value">{items.length}<span>条</span></div>
            <div className="hint">{module === "focus" ? "一段一记" : "一周三次就够"}</div>
          </div>
        </div>
        {header}
        {items.length === 0 ? (
          <Empty title={`还没有${MODULE_LABELS[module]}`} body={module === "focus" ? "一段 45 分钟起算，学完顺手写收获。" : "练完顺手记一笔，不用写长。"} action={() => ctx.openForm(module)} examples={module === "focus" ? ["拆解 12 月投放预算 · 60 分钟", "《组织行为学》第 3 章 · 45 分钟 · 收获 + 怎么用"] : ["力量训练 45 分钟 · 中等强度"]} />
        ) : (
          <div className="stack">
            {items.map((item) => (
              <div className="panel row-panel" key={String(item.id)}>
                <div className="row-copy">
                  <div className="t">{String(item.item || (Array.isArray(item.items) ? item.items.join(" / ") : "训练"))}</div>
                  <div className="s">
                    {fmtDay(item.session_date || item.workout_date)} · {String(item.type || item.intensity || "")}
                    {item.minutes ? ` · ${item.minutes} 分钟` : ""}
                    {item.takeaway ? ` · ${String(item.takeaway)}` : ""}
                  </div>
                </div>
                <div className="row-actions">
                  <button type="button" className="ghost" onClick={() => ctx.openForm(module, item)}>编辑</button>
                  <button type="button" className="ghost danger-text" onClick={() => void remove(item)}>删除</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (module === "money") {
    const accounts = ["全部", "支付宝", "微信", "现金", "银行卡一", "银行卡二", "银行卡三"];
    const visible = items.filter((item) => account === "全部" || item.account === account);
    // 合计只算每个账户最新月份的期末，避免把历史月份重复相加
    const latestByAccount = new Map<string, RecordItem>();
    for (const item of items) {
      const key = String(item.account || "未填账户");
      const current = latestByAccount.get(key);
      if (!current || String(item.month) > String(current.month)) latestByAccount.set(key, item);
    }
    // 个人总余额：各账户最新月份的期末自动加总（与筛选无关，筛选只影响下面的列表）
    const total = Array.from(latestByAccount.values()).reduce((sum, item) => sum + num(item.closing), 0);
    const breakdown = Array.from(latestByAccount.entries())
      .map(([name, row]) => `${name} ¥${num(row.closing).toLocaleString("zh-CN")}`)
      .join(" · ");
    return (
      <div>
        <div className="panel">
          <div className="panel-head">
            <div>
              <h3>账户余额</h3>
              <div className="sub">每月只填期初与期末，净变动自动算</div>
            </div>
            <button type="button" className="primary" onClick={() => ctx.openForm(module)}>＋ 记这个月</button>
          </div>
          <div className="panel-body">
            {latestByAccount.size > 0 ? (
              <div className="fin-total">
                <div className="ft-top">
                  <span>个人总余额</span>
                  <i>各账户最新余额自动加总 · 不用自己算</i>
                </div>
                <div className="ft-value">¥{total.toLocaleString("zh-CN")}</div>
                <div className="ft-accounts">{breakdown}</div>
              </div>
            ) : (
              <div className="fin-sum">
                <b>¥0</b>
                <span>还没有账户记录</span>
              </div>
            )}
            <div className="chips">
              {accounts.map((name) => (
                <button type="button" key={name} className={`chip ${account === name ? "on" : ""}`} onClick={() => setAccount(name)}>
                  {name}
                </button>
              ))}
            </div>
            <div className="stack" style={{ marginTop: 10 }}>
              {visible.length === 0 ? (
                <Empty title="这个账户还没有记录" body="月底花两分钟填两个数：月初余额、月末余额。" action={() => ctx.openForm(module)} examples={["11 月 · 支付宝 · 期初 ¥12,000 → 期末 ¥13,400"]} />
              ) : (
                visible.map((item) => (
                  <div className="panel row-panel" key={String(item.id)}>
                    <div className="row-copy">
                      <div className="t">{String(item.account)} · {String(item.month).slice(0, 7)}</div>
                      <div className="s">
                        期初 ¥{num(item.opening).toLocaleString("zh-CN")} → 期末 ¥{num(item.closing).toLocaleString("zh-CN")}
                        {item.note ? ` · ${String(item.note)}` : ""}
                      </div>
                    </div>
                    <b className={num(item.net) >= 0 ? "up" : "down"}>{num(item.net) >= 0 ? "+" : ""}{num(item.net).toLocaleString("zh-CN")}</b>
                    <div className="row-actions">
                      <button type="button" className="ghost" onClick={() => ctx.openForm(module, item)}>编辑</button>
                      <button type="button" className="ghost danger-text" onClick={() => void remove(item)}>删除</button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

function Empty({
  title,
  body,
  action,
  examples,
}: {
  title: string;
  body: string;
  action: () => void;
  examples?: string[];
}) {
  return (
    <div className="panel empty">
      <b>{title}</b>
      <p>{body}</p>
      {examples?.length ? (
        <div className="ex-list">
          {examples.map((example) => (
            <span key={example}>{example}</span>
          ))}
        </div>
      ) : null}
      <button type="button" className="primary" onClick={action}>
        记第一条
      </button>
    </div>
  );
}
