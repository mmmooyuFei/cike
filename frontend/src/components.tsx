import { useEffect, useState, type ReactNode } from "react";
import { api, errorText } from "./api";
import type { HabitItem, RecordItem } from "./types";

export function Sheet({
  open,
  title,
  sub,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  sub?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  if (!open) return null;
  return (
    <div className="sheet-back" onMouseDown={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <h2>
            {title}
            {sub ? <span className="sh-sub">{sub}</span> : null}
          </h2>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>
  );
}

type Field = {
  name: string;
  label: string;
  type: "text" | "textarea" | "number" | "date" | "month" | "select" | "time" | "tags" | "multiselect";
  options?: string[];
  optionValues?: string[];
  placeholder?: string;
  required?: boolean;
  hint?: string;
};

export const FORMS: Record<string, Field[]> = {
  todos: [
    { name: "title", label: "标题", type: "text", required: true, placeholder: "动词开头：确认 / 回访 / 看完" },
    { name: "priority", label: "优先级", type: "select", options: ["P0", "P1", "P2", "P3"], hint: "P0 是今天必须做的那件" },
    { name: "category", label: "分类", type: "select", options: ["工作", "个人", "学习", "生活"] },
    { name: "due_date", label: "截止日期", type: "date" },
    { name: "note", label: "备注", type: "textarea", placeholder: "补充一句，可留空" },
  ],
  milestones: [
    { name: "title", label: "事项", type: "text", required: true, placeholder: "今年想做成的一件事" },
    { name: "category", label: "类别", type: "select", options: ["事业", "财富", "健康", "家庭", "成长", "体验"] },
    { name: "quarter", label: "目标季度", type: "select", options: ["Q1", "Q2", "Q3", "Q4", "全年"] },
    { name: "target_date", label: "目标日期", type: "date" },
    { name: "metric", label: "衡量标准", type: "text", placeholder: "做到什么程度算完成", hint: "写成能判断真假的一句，比如「连续 3 个月过 150 万」" },
    { name: "status", label: "状态", type: "select", options: ["未开始", "进行中", "已完成", "已放弃"] },
    { name: "progress", label: "进度 %", type: "number", hint: "0–100" },
    { name: "next_step", label: "下一步", type: "text" },
    { name: "review", label: "复盘", type: "textarea" },
  ],
  daily: [
    { name: "log_date", label: "日期", type: "date", hint: "同一天只保留一条，重复填写会合并" },
    { name: "content", label: "今日内容", type: "textarea", placeholder: "今天真正推动的几件事" },
    { name: "tomorrow_plan", label: "明天计划", type: "textarea", placeholder: "明天要做的 1–3 件" },
    { name: "blockers", label: "问题与卡点", type: "textarea", placeholder: "卡在哪、需要谁配合" },
  ],
  sleep: [
    { name: "record_date", label: "日期", type: "date", hint: "凌晨 0–6 点睡前打卡会自动记到前一天" },
    { name: "bed_time", label: "睡觉时间", type: "time" },
    { name: "wake_time", label: "起床时间", type: "time" },
    { name: "target_time", label: "目标时间", type: "time", hint: "给自己定的起床线，打卡按这个判达标" },
    { name: "achieved", label: "是否达标", type: "select", options: ["达标", "未达标"], optionValues: ["true", "false"] },
    { name: "hours", label: "睡眠小时", type: "number", hint: "留空时按睡觉 / 起床时间自动算" },
  ],
  focus: [
    { name: "session_date", label: "日期", type: "date" },
    { name: "item", label: "事项", type: "text", required: true, placeholder: "这段时间在做什么" },
    { name: "type", label: "类型", type: "select", options: ["深度工作", "学习输入", "会议", "事务处理"] },
    { name: "category", label: "类别", type: "select", options: ["行业研究", "电商运营", "管理组织", "AI工具", "财税法务", "英语", "其他"] },
    { name: "minutes", label: "时长分钟", type: "number", hint: "45 分钟起算" },
    { name: "start_time", label: "开始时间", type: "time" },
    { name: "source", label: "来源", type: "text", placeholder: "书 / 课程 / 文章" },
    { name: "takeaway", label: "核心收获", type: "textarea" },
    { name: "action", label: "可落地动作", type: "textarea" },
    { name: "note", label: "备注", type: "text" },
  ],
  workouts: [
    { name: "workout_date", label: "日期", type: "date" },
    {
      name: "items",
      label: "项目",
      type: "multiselect",
      options: ["力量训练", "有氧", "球类", "游泳", "拉伸", "户外"],
      hint: "可多选",
    },
    { name: "minutes", label: "时长分钟", type: "number" },
    { name: "intensity", label: "强度", type: "select", options: ["轻", "中", "高"] },
    { name: "calories", label: "消耗千卡", type: "number" },
    { name: "note", label: "感受备注", type: "textarea" },
  ],
  money: [
    { name: "month", label: "月份", type: "month", required: true },
    { name: "account", label: "账户", type: "select", options: ["支付宝", "微信", "现金", "银行卡一", "银行卡二", "银行卡三"], required: true },
    { name: "opening", label: "期初余额", type: "number", hint: "这个月 1 号的余额" },
    { name: "closing", label: "期末余额", type: "number", hint: "这个月最后一天的余额，没到月底可以先空着" },
    { name: "note", label: "大额收支说明", type: "text", hint: "这个月进出的几笔大的，写一句就够" },
  ],
};

export function LogoMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="11" fill="#f3f0e4" />
      <path d="M29.55 10.45A13.5 13.5 0 1 1 10.45 10.45" fill="none" stroke="#1e5138" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="20" cy="6.5" r="3" fill="#b8832f" />
    </svg>
  );
}

export function Avatar({
  src,
  name,
  className,
}: {
  src?: string | null;
  name?: string | null;
  className: string;
}) {
  const [failed, setFailed] = useState(false);
  const initial = (name || "此").slice(0, 1);
  if (src && !failed) {
    return <img className={className} src={src} alt={name || "头像"} onError={() => setFailed(true)} />;
  }
  return <span className={className}>{initial}</span>;
}

export const MODULE_LABELS: Record<string, string> = {
  dashboard: "驾驶舱",
  todos: "待办",
  habits: "坚持打卡",
  milestones: "里程碑",
  daily: "每日日志",
  sleep: "睡眠",
  focus: "专注学习",
  workouts: "健身",
  money: "月度余额",
};

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function initialValues(module: string, item?: RecordItem): Record<string, string> {
  const values: Record<string, string> = {};
  const today = todayIso();
  for (const field of FORMS[module] || []) {
    const raw = item?.[field.name];
    if (field.type === "tags" || field.type === "multiselect") {
      values[field.name] = Array.isArray(raw) ? raw.join(", ") : "";
    } else if (field.type === "month") {
      values[field.name] = typeof raw === "string" ? raw.slice(0, 7) : item ? "" : today.slice(0, 7);
    } else if (field.type === "date") {
      values[field.name] = typeof raw === "string" ? raw.slice(0, 10) : item ? "" : today;
    } else if (field.type === "select" && field.optionValues) {
      const index = field.optionValues.indexOf(raw === null || raw === undefined ? "" : String(raw));
      values[field.name] = index >= 0 ? field.options?.[index] || "" : "";
    } else if (field.type === "select" && !item && field.required && field.options?.length) {
      values[field.name] = field.options[0];
    } else {
      values[field.name] = raw === null || raw === undefined ? "" : String(raw);
    }
  }
  return values;
}

export function RecordForm({
  module,
  item,
  onDone,
  onCancel,
  onError,
}: {
  module: string;
  item?: RecordItem;
  onDone: (message: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const fields = FORMS[module] || [];
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(module, item));
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    for (const field of fields) {
      if (field.required && !values[field.name]?.trim()) {
        onError(`请填写「${field.label}」`);
        return;
      }
    }
    const payload: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = values[field.name] ?? "";
      if (field.type === "number") {
        payload[field.name] = raw === "" ? null : Number(raw);
      } else if (field.type === "multiselect") {
        payload[field.name] = raw.split(/[,，]/).map((part) => part.trim()).filter(Boolean);
      } else if (field.type === "tags") {
        payload[field.name] = raw.split(/[,，]/).map((part) => part.trim()).filter(Boolean);
      } else if (field.type === "month") {
        payload[field.name] = raw ? `${raw}-01` : null;
      } else if (field.type === "select" && field.optionValues) {
        const index = raw ? (field.options || []).indexOf(raw) : -1;
        payload[field.name] = index >= 0 ? field.optionValues[index] : null;
      } else {
        payload[field.name] = raw === "" ? null : raw;
      }
    }
    setSaving(true);
    try {
      if (item?.id) {
        await api.patch(`/data/${module}/${item.id}`, payload);
        onDone("已更新");
      } else {
        const result = await api.post<{ merged?: boolean }>(`/data/${module}`, payload);
        onDone(result?.merged ? "已合并到当天的记录" : "已记录");
      }
    } catch (error) {
      onError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const selected = (field: Field): string[] =>
    (values[field.name] || "").split(/[,，]/).map((part) => part.trim()).filter(Boolean);

  return (
    <div className="record-form">
      {fields.map((field) => (
        <div className="field" key={field.name}>
          <label htmlFor={`f-${field.name}`}>
            {field.label}
            {field.required ? <span className="req">*</span> : null}
          </label>
          {field.type === "textarea" ? (
            <textarea
              id={`f-${field.name}`}
              value={values[field.name] || ""}
              placeholder={field.placeholder}
              onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
            />
          ) : field.type === "select" ? (
            <select
              id={`f-${field.name}`}
              value={values[field.name] || ""}
              onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
            >
              <option value="">未填写</option>
              {field.options?.map((option) => (
                <option value={option} key={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : field.type === "multiselect" ? (
            <div className="chips" id={`f-${field.name}`}>
              {field.options?.map((option) => {
                const on = selected(field).includes(option);
                return (
                  <button
                    type="button"
                    key={option}
                    className={`chip ${on ? "on" : ""}`}
                    aria-pressed={on}
                    onClick={() => {
                      const current = selected(field);
                      const next = on ? current.filter((value) => value !== option) : [...current, option];
                      setValues({ ...values, [field.name]: next.join(", ") });
                    }}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          ) : (
            <input
              id={`f-${field.name}`}
              type={field.type === "tags" ? "text" : field.type}
              value={values[field.name] || ""}
              placeholder={field.placeholder}
              onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
            />
          )}
          {field.type === "tags" ? <div className="field-hint">用逗号分隔多个项目</div> : null}
          {field.hint ? <div className="field-hint">{field.hint}</div> : null}
        </div>
      ))}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="primary" onClick={() => void submit()} disabled={saving}>
          {saving ? "保存中…" : item?.id ? "保存修改" : "保存"}
        </button>
      </div>
    </div>
  );
}

export function Picker({ onPick }: { onPick: (module: string) => void }) {
  const items = [
    ["todos", "待办", "一件要去做的事"],
    ["habits", "坚持事项", "想长期坚持、每天打卡的事"],
    ["focus", "专注学习", "刚做完的一段专注 / 学到的一样东西"],
    ["daily", "每日日志", "今天做了什么、明天打算、卡在哪"],
    ["sleep", "睡眠", "补一晚的睡觉 / 起床时间"],
    ["workouts", "健身", "练了什么、多久"],
    ["milestones", "里程碑", "这一年想做成的事"],
    ["money", "月度余额", "这个月的期初和期末"],
  ];
  return (
    <div>
      {items.map(([key, label, desc]) => (
        <button type="button" className="pick" key={key} onClick={() => onPick(key)}>
          <b>{label}</b>
          <span>{desc}</span>
        </button>
      ))}
      <div className="tip">不知道记哪一类：今天做完的事放「专注」，要别人配合的事放「待办」，自己的状态放「每日日志」。</div>
    </div>
  );
}

export function HabitForm({
  item,
  onDone,
  onCancel,
  onError,
}: {
  item?: HabitItem;
  onDone: (message: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [values, setValues] = useState({
    title: item?.title || "",
    frequency: item?.frequency || "每天",
    target_count: item && item.target_count ? String(item.target_count) : "",
    status: item?.status || "进行中",
    start_date: item?.start_date ? item.start_date.slice(0, 10) : todayIso(),
    note: item?.note || "",
  });
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (saving) return;
    if (!values.title.trim()) {
      onError("请填写坚持事项");
      return;
    }
    const payload = {
      title: values.title.trim(),
      frequency: values.frequency,
      target_count: values.target_count === "" ? 0 : Number(values.target_count),
      status: values.status,
      start_date: values.start_date || null,
      note: values.note,
    };
    setSaving(true);
    try {
      if (item?.id) {
        await api.patch(`/habits/${item.id}`, payload);
        onDone("已更新");
      } else {
        await api.post("/habits", payload);
        onDone("已新增坚持事项");
      }
    } catch (error) {
      onError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!item?.id) return;
    if (!window.confirm(`删除「${item.title}」？删除后这个事项的打卡记录也不再见。`)) return;
    try {
      await api.del(`/habits/${item.id}`);
      onDone("已删除");
    } catch (error) {
      onError(errorText(error));
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="record-form">
      <div className="field">
        <label htmlFor="habit-title">
          事项<span className="req">*</span>
        </label>
        <input
          id="habit-title"
          value={values.title}
          maxLength={200}
          placeholder="要长期坚持的事，如：健身 / 读书 / 早睡"
          onChange={(event) => setValues({ ...values, title: event.target.value })}
        />
        <div className="field-hint">坚持什么就写什么，比如「健身」「早睡」「读书 30 分钟」。</div>
      </div>
      <div className="field">
        <label htmlFor="habit-frequency">目标频率</label>
        <select id="habit-frequency" value={values.frequency} onChange={(event) => setValues({ ...values, frequency: event.target.value })}>
          <option value="每天">每天</option>
          <option value="每周">每周</option>
          <option value="每月">每月</option>
        </select>
        <div className="field-hint">每天 = 固定每天一次；每周 / 每月按你定的次数折算月度目标。</div>
      </div>
      <div className="field">
        <label htmlFor="habit-count">目标次数</label>
        <input
          id="habit-count"
          type="number"
          min={0}
          max={99}
          value={values.target_count}
          placeholder="每周 3 次 / 每月 20 次；每天不用填"
          onChange={(event) => setValues({ ...values, target_count: event.target.value })}
        />
        <div className="field-hint">每周几次或每月几次；选「每天」时不用填。</div>
      </div>
      <div className="field">
        <label htmlFor="habit-status">状态</label>
        <select id="habit-status" value={values.status} onChange={(event) => setValues({ ...values, status: event.target.value })}>
          <option value="进行中">进行中</option>
          <option value="已暂停">已暂停</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="habit-start">开始日期</label>
        <input id="habit-start" type="date" value={values.start_date} onChange={(event) => setValues({ ...values, start_date: event.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="habit-note">备注</label>
        <input id="habit-note" value={values.note} placeholder="选填" onChange={(event) => setValues({ ...values, note: event.target.value })} />
      </div>
      <div className="tip">每天做到就点一下打卡，月度进度自动算。想暂停一件，把状态改成「已暂停」就行。</div>
      <div className="form-actions">
        {item?.id ? (
          <button type="button" className="danger-text" onClick={() => void remove()}>
            删除
          </button>
        ) : null}
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="primary" onClick={() => void submit()} disabled={saving}>
          {saving ? "保存中…" : item?.id ? "保存修改" : "保存"}
        </button>
      </div>
    </div>
  );
}

function mondayIso(): string {
  const now = new Date();
  const offset = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
  return `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
}

export function ReviewForm({
  onDone,
  onCancel,
  onError,
}: {
  onDone: (message: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [values, setValues] = useState({ wins: "", blockers: "", next_focus: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .get<{ items: Record<string, unknown>[] }>("/reviews")
      .then(({ items }) => {
        if (!alive) return;
        const monday = mondayIso();
        const row = items.find((entry) => String(entry.week_start || "").slice(0, 10) === monday);
        if (row) {
          setValues({
            wins: String(row.wins || ""),
            blockers: String(row.blockers || ""),
            next_focus: String(row.next_focus || ""),
          });
        }
      })
      .catch(() => {
        /* 读不到就当新写 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await api.post("/reviews", values);
      onDone("本周回顾已完成");
    } catch (error) {
      onError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void submit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="record-form">
      <div className="field">
        <label>这周真正推进了什么？</label>
        <textarea value={values.wins} placeholder="写结果，不写忙碌" onChange={(event) => setValues({ ...values, wins: event.target.value })} />
      </div>
      <div className="field">
        <label>卡在哪、需要谁配合？</label>
        <textarea value={values.blockers} placeholder="写具体卡点，不写情绪" onChange={(event) => setValues({ ...values, blockers: event.target.value })} />
      </div>
      <div className="field">
        <label>下周最重要的一件是什么？</label>
        <textarea value={values.next_focus} placeholder="只写一件" onChange={(event) => setValues({ ...values, next_focus: event.target.value })} />
      </div>
      <div className="form-actions">
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="primary" onClick={() => void submit()} disabled={saving}>
          {saving ? "保存中…" : "完成回顾"}
        </button>
      </div>
    </div>
  );
}

