import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import type { AppContextValue, RecordItem } from "../types";

type Filter = "all" | "today" | "overdue" | "done";

const FILTER_LABEL: Record<Filter, string> = { all: "全部", today: "今天", overdue: "逾期", done: "已完成" };

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function Todos({ ctx }: { ctx: AppContextValue }) {
  const [items, setItems] = useState<RecordItem[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<{ items: RecordItem[] }>("/data/todos");
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
  }, [ctx.refreshKey]);

  const counts = {
    all: items.length,
    today: items.filter((item) => item.status !== "done" && item.due_date === todayIso()).length,
    overdue: items.filter((item) => item.status !== "done" && item.due_date && String(item.due_date) < todayIso()).length,
    done: items.filter((item) => item.status === "done").length,
  };

  const visible = items.filter((item) => {
    const done = item.status === "done";
    if (filter === "done") return done;
    if (done) return false;
    if (filter === "today") return item.due_date === todayIso();
    if (filter === "overdue") return Boolean(item.due_date && String(item.due_date) < todayIso());
    return true;
  });

  const toggle = async (item: RecordItem) => {
    const done = item.status === "done";
    try {
      await api.post(`/data/todos/${item.id}/toggle`, { done: !done });
      ctx.toast(done ? "已恢复为未完成" : "已完成");
      ctx.refresh();
    } catch (err) {
      ctx.toast(errorText(err));
    }
  };

  const remove = async (item: RecordItem) => {
    try {
      await api.del(`/data/todos/${item.id}`);
      setItems((current) => current.filter((row) => row.id !== item.id));
      ctx.toast(`已删除「${String(item.title)}」`, {
        label: "撤销",
        run: async () => {
          try {
            await api.post(`/data/todos/${item.id}/restore`);
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

  return (
    <div>
      <div className="toolbar">
        <div className="chips">
          {(Object.keys(FILTER_LABEL) as Filter[]).map((key) => (
            <button type="button" key={key} className={`chip ${filter === key ? "on" : ""}`} onClick={() => setFilter(key)}>
              {FILTER_LABEL[key]} {counts[key]}
            </button>
          ))}
        </div>
        <button type="button" className="primary" onClick={() => ctx.openForm("todos")}>
          ＋ 新增
        </button>
      </div>

      {loading ? (
        <div className="stack">
          {Array.from({ length: 4 }).map((_, index) => (
            <div className="skeleton row-skeleton" key={index} />
          ))}
        </div>
      ) : error ? (
        <div className="panel empty">
          <b>读取失败</b>
          <p>{error}</p>
          <button type="button" className="primary" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="panel empty">
          <b>{filter === "done" ? "还没有完成的事" : "这个筛选下没有待办"}</b>
          <p>只登记明天有人问起来答不上来会出问题的那种事。</p>
          <button type="button" className="primary" onClick={() => ctx.openForm("todos")}>
            新增待办
          </button>
        </div>
      ) : (
        <div className="stack">
          {visible.map((item) => {
            const done = item.status === "done";
            return (
              <div className={`panel todo ${done ? "is-done" : ""}`} key={String(item.id)}>
                <button type="button" className={`check ${done ? "on" : ""}`} onClick={() => void toggle(item)} aria-label="切换完成">
                  ✓
                </button>
                <div className="row-copy">
                  <div className="t">{String(item.title)}</div>
                  <div className="s">
                    {String(item.category || "工作")} · {item.due_date ? String(item.due_date) : "未设截止"}
                    {item.note ? ` · ${String(item.note)}` : ""}
                  </div>
                </div>
                <span className={`tag ${item.priority === "P0" ? "hot" : item.priority === "P1" ? "warn" : ""}`}>
                  {String(item.priority || "P1")}
                </span>
                <div className="row-actions">
                  <button type="button" className="ghost" onClick={() => ctx.openForm("todos", item)}>
                    编辑
                  </button>
                  <button type="button" className="ghost danger-text" onClick={() => void remove(item)}>
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
