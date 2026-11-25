import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { LogoMark } from "../components";
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

const SUBJECT_LABEL: Record<Rule["subject_type"], string> = { role: "角色", group: "群组", user: "用户" };
const SUBJECT_BADGE: Record<Rule["subject_type"], string> = { role: "角", group: "组", user: "人" };

export function Access({ ctx }: { ctx: AppContextValue }) {
  const [data, setData] = useState<AccessData | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [form, setForm] = useState<Rule>({
    module: "todos",
    subject_type: "role",
    subject: "",
    can_view: false,
    can_edit: false,
  });

  const [brandName, setBrandName] = useState(ctx.brand.name);
  const [brandSubtitle, setBrandSubtitle] = useState(ctx.brand.subtitle);
  const [brandSaving, setBrandSaving] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setBrandName(ctx.brand.name);
    setBrandSubtitle(ctx.brand.subtitle);
  }, [ctx.brand.name, ctx.brand.subtitle]);

  const load = async () => {
    try {
      const payload = await api.get<AccessData>("/access");
      setData(payload);
      setRules(payload.rules);
      setDirty(false);
      setError("");
    } catch (err) {
      setError(errorText(err));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.refreshKey]);

  // 页面本身只在管理员导航里出现；这里再挡一层，避免品牌与权限被普通用户操作
  if (!ctx.session.is_admin) {
    return null;
  }

  const saveBrand = async () => {
    const name = brandName.trim();
    if (!name) {
      ctx.toast("站点名称不能为空");
      return;
    }
    setBrandSaving(true);
    try {
      await api.put("/settings/brand", { name, subtitle: brandSubtitle.trim() });
      ctx.toast("品牌已保存");
      ctx.refresh();
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      setBrandSaving(false);
    }
  };

  const uploadLogo = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      ctx.toast("LOGO 图片超过 2MB");
      return;
    }
    try {
      await api.upload("/settings/brand/logo", file);
      ctx.toast("LOGO 已更新");
      ctx.refresh();
    } catch (err) {
      ctx.toast(errorText(err));
    }
  };

  const moduleLabel = (key: string) => data?.modules.find((entry) => entry.key === key)?.label || key;

  const subjects =
    form.subject_type === "role" ? data?.roles || [] : form.subject_type === "group" ? data?.groups || [] : (data?.users || []).map((user) => user.username);

  const add = () => {
    if (!form.subject) {
      ctx.toast("请选择角色、群组或用户");
      return;
    }
    const next = rules.filter(
      (rule) => !(rule.module === form.module && rule.subject_type === form.subject_type && rule.subject === form.subject),
    );
    setRules([...next, { ...form }]);
    setDirty(true);
  };

  const editRule = (rule: Rule) => {
    setForm({ ...rule });
    setRules(rules.filter((item) => item !== rule));
    setDirty(true);
    ctx.toast("已载入表单，改完点「加入规则」");
  };

  const removeRule = (rule: Rule) => {
    setRules(rules.filter((item) => item !== rule));
    setDirty(true);
  };

  const save = async () => {
    if (!window.confirm(`保存会用下面 ${rules.length} 条规则整体替换站点权限，确定继续？`)) return;
    setSaving(true);
    try {
      await api.put("/access", { rules });
      ctx.toast("权限已保存");
      setDirty(false);
      ctx.refresh();
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  if (error) {
    return (
      <div className="panel empty">
        <b>无法读取站点配置</b>
        <p>{error}</p>
        <button type="button" className="primary" onClick={() => void load()}>重试</button>
      </div>
    );
  }
  if (!data) {
    return <div className="skeleton row-skeleton" />;
  }

  const coveredModules = new Set(rules.map((rule) => rule.module)).size;

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>品牌与外观</h3>
            <div className="sub">左上角名称、副标题与 LOGO</div>
          </div>
        </div>
        <div className="panel-body">
          <div className="brand-box">
            <div className="brand-preview">
              {ctx.brand.logo_url ? <img className="brand-logo" src={ctx.brand.logo_url} alt="" /> : <LogoMark size={38} />}
              <div>
                <b>{brandName || "此刻"}</b>
                {brandSubtitle ? <small>{brandSubtitle}</small> : null}
              </div>
            </div>
            <div className="brand-fields">
              <div className="field">
                <label htmlFor="brand-name">站点名称</label>
                <input id="brand-name" value={brandName} maxLength={12} onChange={(event) => setBrandName(event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="brand-subtitle">副标题</label>
                <input
                  id="brand-subtitle"
                  value={brandSubtitle}
                  maxLength={24}
                  placeholder="笔记 · 备忘录"
                  onChange={(event) => setBrandSubtitle(event.target.value)}
                />
              </div>
              <div className="field">
                <label>LOGO</label>
                <button type="button" className="file-btn" onClick={() => logoInput.current?.click()}>
                  上传图片
                </button>
                <input
                  ref={logoInput}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  hidden
                  onChange={(event) => {
                    void uploadLogo(event.target.files?.[0]);
                    event.target.value = "";
                  }}
                />
              </div>
            </div>
            <div className="brand-actions">
              <div className="field-hint">LOGO 用 PNG / JPG / WebP，建议方形，≤2MB；透明底 PNG 会保留透明</div>
              <div className="btn-row">
                <button
                  type="button"
                  onClick={() => {
                    setBrandName(ctx.brand.default_name || "此刻");
                    setBrandSubtitle(ctx.brand.default_subtitle || "笔记 · 备忘录");
                  }}
                >
                  恢复默认
                </button>
                <button type="button" className="primary" onClick={() => void saveBrand()} disabled={brandSaving}>
                  {brandSaving ? "保存中…" : "保存品牌"}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>访问规则</h3>
            <div className="sub">
              默认允许；已配置 {rules.length} 条规则，覆盖 {coveredModules} 个模块。管理员始终可见。
            </div>
          </div>
          <div className="btn-row">
            {dirty ? <span className="pill warn">有未保存改动</span> : null}
            <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
              {saving ? "保存中…" : "保存权限"}
            </button>
          </div>
        </div>
        <div className="panel-body">
          <div className="rule-editor">
            <div className="rule-editor-head">
              <b>新增 / 编辑规则</b>
              <span>选择对象与模块，设置查看与编辑权限</span>
            </div>
            <div className="rule-editor-grid">
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
                <div className="seg">
                  <button
                    type="button"
                    className={form.can_view ? "on" : ""}
                    onClick={() => setForm({ ...form, can_view: true })}
                  >
                    允许
                  </button>
                  <button
                    type="button"
                    className={form.can_view ? "" : "on reject"}
                    onClick={() => setForm({ ...form, can_view: false })}
                  >
                    拒绝
                  </button>
                </div>
              </div>
              <div className="field">
                <label>可编辑</label>
                <div className="seg">
                  <button
                    type="button"
                    className={form.can_edit ? "on" : ""}
                    onClick={() => setForm({ ...form, can_edit: true })}
                  >
                    允许
                  </button>
                  <button
                    type="button"
                    className={form.can_edit ? "" : "on reject"}
                    onClick={() => setForm({ ...form, can_edit: false })}
                  >
                    拒绝
                  </button>
                </div>
              </div>
              <button type="button" className="primary rule-add" onClick={add}>
                加入规则
              </button>
            </div>
          </div>

          {rules.length === 0 ? (
            <div className="upd-empty">
              <b>还没有限制规则</b>
              <p>所有普通用户当前都能看到全部模块。添加规则后才会对指定角色、群组或用户生效。</p>
            </div>
          ) : (
            <div className="rules">
              {rules.map((rule) => (
                <article className="rule-row" key={`${rule.module}-${rule.subject_type}-${rule.subject}`}>
                  <span className={`rule-badge ${rule.subject_type}`}>{SUBJECT_BADGE[rule.subject_type]}</span>
                  <div className="rule-main">
                    <div className="rule-title">
                      <b>{rule.subject}</b>
                      <span className="rule-type">{SUBJECT_LABEL[rule.subject_type]}</span>
                    </div>
                    <div className="rule-sub">模块：{moduleLabel(rule.module)}</div>
                  </div>
                  <div className="rule-perms">
                    <span className={`perm ${rule.can_view ? "on" : "off"}`}>查看 {rule.can_view ? "允许" : "拒绝"}</span>
                    <span className={`perm ${rule.can_edit ? "on" : "off"}`}>编辑 {rule.can_edit ? "允许" : "拒绝"}</span>
                  </div>
                  <div className="row-actions">
                    <button type="button" className="ghost" onClick={() => editRule(rule)}>编辑</button>
                    <button type="button" className="ghost danger-text" onClick={() => removeRule(rule)}>移除</button>
                  </div>
                </article>
              ))}
            </div>
          )}

          <div className="note">
            数据隔离不依赖这里：每条业务记录始终带当前用户条件，管理员也看不到别人的个人记录。这里只控制“能不能进入某个模块”。
          </div>
        </div>
      </section>

      <div className="access-cols">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>已识别的角色</h3>
              <div className="sub">来自已登录用户的 Casdoor 角色</div>
            </div>
            <span className="pill muted">{data.roles.length}</span>
          </div>
          <div className="panel-body">
            <div className="tags">
              {data.roles.length ? data.roles.map((role) => <span key={role}>{role}</span>) : <span>暂无</span>}
            </div>
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>已识别的群组</h3>
              <div className="sub">来自已登录用户的 Casdoor 群组</div>
            </div>
            <span className="pill muted">{data.groups.length}</span>
          </div>
          <div className="panel-body">
            <div className="tags">
              {data.groups.length ? data.groups.map((group) => <span key={group}>{group}</span>) : <span>暂无</span>}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
