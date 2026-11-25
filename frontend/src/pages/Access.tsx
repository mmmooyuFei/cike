import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import type { AppContextValue } from "../types";

type Rule = {
  module: string;
  subject_type: "role" | "group" | "user";
  subject: string;
  can_view: boolean;
  can_edit: boolean;
};

type AccessData = {
  modules: { key: string; label: string }[];
  roles: string[];
  groups: string[];
  users: { id: string; username: string; display_name: string }[];
  rules: Rule[];
};

export function Access({ ctx }: { ctx: AppContextValue }) {
  const [data, setData] = useState<AccessData | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Rule>({
    module: "todos",
    subject_type: "role",
    subject: "",
    can_view: false,
    can_edit: false,
  });

  const load = async () => {
    try {
      const payload = await api.get<AccessData>("/access");
      setData(payload);
      setRules(payload.rules);
      setError("");
    } catch (err) {
      setError(errorText(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.refreshKey]);

  if (error) {
    return (
      <div className="panel empty">
        <b>无法读取权限配置</b>
        <p>{error}</p>
        <button type="button" className="primary" onClick={() => void load()}>重试</button>
      </div>
    );
  }
  if (!data) {
    return <div className="skeleton row-skeleton" />;
  }

  const subjects =
    form.subject_type === "role" ? data.roles : form.subject_type === "group" ? data.groups : data.users.map((user) => user.username);

  const add = () => {
    if (!form.subject) {
      ctx.toast("请选择角色、群组或用户");
      return;
    }
    const next = rules.filter(
      (rule) => !(rule.module === form.module && rule.subject_type === form.subject_type && rule.subject === form.subject),
    );
    setRules([...next, { ...form }]);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put("/access", { rules });
      ctx.toast("权限已保存");
      ctx.refresh();
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h3>模块权限</h3>
            <div className="sub">默认允许；命中规则的模块按规则拒绝。管理员始终可见。</div>
          </div>
          <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存权限"}
          </button>
        </div>
        <div className="panel-body">
          <div className="rule-form">
            <div className="field">
              <label>对象类型</label>
              <select
                value={form.subject_type}
                onChange={(event) => setForm({ ...form, subject_type: event.target.value as Rule["subject_type"], subject: "" })}
              >
                <option value="role">Casdoor 角色</option>
                <option value="group">Casdoor 群组</option>
                <option value="user">具体用户</option>
              </select>
            </div>
            <div className="field">
              <label>对象</label>
              <select value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })}>
                <option value="">选择…</option>
                {subjects.map((subject) => (
                  <option value={subject} key={subject}>{subject}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>模块</label>
              <select value={form.module} onChange={(event) => setForm({ ...form, module: event.target.value })}>
                {data.modules.map((module) => (
                  <option value={module.key} key={module.key}>{module.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>可查看</label>
              <select value={String(form.can_view)} onChange={(event) => setForm({ ...form, can_view: event.target.value === "true" })}>
                <option value="true">允许</option>
                <option value="false">拒绝</option>
              </select>
            </div>
            <div className="field">
              <label>可编辑</label>
              <select value={String(form.can_edit)} onChange={(event) => setForm({ ...form, can_edit: event.target.value === "true" })}>
                <option value="true">允许</option>
                <option value="false">拒绝</option>
              </select>
            </div>
            <button type="button" onClick={add}>加入规则</button>
          </div>

          {rules.length === 0 ? (
            <div className="empty small">
              <b>还没有限制规则</b>
              <p>所有普通用户当前都能看到全部模块。添加规则后才会对指定角色 / 群组 / 用户生效。</p>
            </div>
          ) : (
            <div className="stack" style={{ marginTop: 14 }}>
              {rules.map((rule) => (
                <div className="panel row-panel" key={`${rule.module}-${rule.subject_type}-${rule.subject}`}>
                  <div className="row-copy">
                    <div className="t">{rule.subject_type === "role" ? "角色" : rule.subject_type === "group" ? "群组" : "用户"} · {rule.subject}</div>
                    <div className="s">模块 {rule.module} · 查看 {rule.can_view ? "允许" : "拒绝"} · 编辑 {rule.can_edit ? "允许" : "拒绝"}</div>
                  </div>
                  <button
                    type="button"
                    className="ghost danger-text"
                    onClick={() => setRules(rules.filter((item) => item !== rule))}
                  >
                    移除
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="note">
            数据隔离不依赖这里：每条业务记录始终带当前用户条件，管理员也看不到别人的个人记录。这里只控制“能不能进入某个模块”。
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h3>当前可识别的角色 / 群组</h3></div>
        <div className="panel-body">
          <div className="perm-grid">
            <div>
              <label>角色</label>
              <div className="tags">{data.roles.length ? data.roles.map((role) => <span key={role}>{role}</span>) : <span>暂无</span>}</div>
            </div>
            <div>
              <label>群组</label>
              <div className="tags">{data.groups.length ? data.groups.map((group) => <span key={group}>{group}</span>) : <span>暂无</span>}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
