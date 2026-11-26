import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { useAuth } from "../auth";
import { Avatar, MODULE_LABELS } from "../components";
import type { AppContextValue } from "../types";

export function Account({ ctx }: { ctx: AppContextValue }) {
  const { logout } = useAuth();
  const user = ctx.session.user!;
  const [displayName, setDisplayName] = useState(user.display_name);
  const [gender, setGender] = useState(user.gender || "");
  const [birthday, setBirthday] = useState(user.birthday || "");
  const [saving, setSaving] = useState(false);
  const [password, setPassword] = useState({ old: "", next: "", confirm: "" });
  const [passwordReady, setPasswordReady] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDisplayName(user.display_name);
    setGender(user.gender || "");
    setBirthday(user.birthday || "");
  }, [user.id, user.display_name, user.gender, user.birthday]);

  useEffect(() => {
    api
      .get<{ password: boolean }>("/account/capabilities")
      .then((data) => setPasswordReady(data.password))
      .catch(() => setPasswordReady(false));
  }, []);

  const saveProfile = async () => {
    setSaving(true);
    try {
      await api.patch("/account/profile", { display_name: displayName, gender, birthday });
      ctx.toast("资料已保存");
      ctx.refresh();
    } catch (error) {
      ctx.toast(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      ctx.toast("头像图片超过 5MB");
      return;
    }
    try {
      await api.upload("/account/avatar", file);
      ctx.toast("头像已更新");
      ctx.refresh();
    } catch (error) {
      ctx.toast(errorText(error));
    }
  };

  const changePassword = async () => {
    if (!password.old || !password.next) {
      ctx.toast("请填写当前密码与新密码");
      return;
    }
    if (password.next.length < 12) {
      ctx.toast("新密码至少 12 位");
      return;
    }
    if (password.next !== password.confirm) {
      ctx.toast("两次新密码不一致");
      return;
    }
    try {
      await api.post("/account/password", { old_password: password.old, new_password: password.next });
      ctx.toast("密码已更新，请重新登录");
      await logout();
    } catch (error) {
      ctx.toast(errorText(error));
    }
  };

  return (
    <div className="stack">
      <section className="panel acct">
        <div className="panel-head">
          <div>
            <h3>账号资料</h3>
            <div className="sub">每一项能否修改由服务端逐字段决定</div>
          </div>
          <button type="button" className="primary" onClick={() => void saveProfile()} disabled={saving}>
            {saving ? "保存中…" : "保存修改"}
          </button>
        </div>
        <div className="panel-body">
          <div className="profile-row">
            <div className="avatar-side">
              <Avatar className="avatar-big" src={user.avatar_url} name={displayName} />
              <button type="button" className="link" onClick={() => avatarInput.current?.click()}>
                更换头像
              </button>
              <div className="field-hint avatar-hint">支持透明底 PNG</div>
              <input
                ref={avatarInput}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                hidden
                onChange={(event) => {
                  void uploadAvatar(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </div>
            <div className="profile-fields">
              <div className="field">
                <label htmlFor="display-name">显示名称</label>
                <input id="display-name" value={displayName} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="gender">性别</label>
                <select id="gender" value={gender} onChange={(event) => setGender(event.target.value)}>
                  <option value="">未设置</option>
                  <option value="male">男</option>
                  <option value="female">女</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="birthday">生日</label>
                <input id="birthday" type="date" value={birthday} onChange={(event) => setBirthday(event.target.value)} />
              </div>
              <div className="field">
                <label>用户名<span className="ro">只读</span></label>
                <input value={user.username} readOnly disabled />
              </div>
              <div className="field">
                <label>手机号<span className="ro">只读</span></label>
                <input value={user.phone || "—"} readOnly disabled />
              </div>
              <div className="field">
                <label>邮箱<span className="ro">只读</span></label>
                <input value={user.email || "—"} readOnly disabled />
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel acct">
        <div className="panel-head">
          <div>
            <h3>更改密码</h3>
            <div className="sub">{passwordReady ? "更新后需要重新登录" : "本地开发身份切换器不管理密码；生产由 Casdoor 处理"}</div>
          </div>
          <button type="button" className="primary" onClick={() => void changePassword()} disabled={!passwordReady}>
            更新密码
          </button>
        </div>
        <div className="panel-body">
          <div className="profile-fields">
            <div className="field">
              <label>当前密码</label>
              <input type="password" value={password.old} autoComplete="current-password" onChange={(event) => setPassword({ ...password, old: event.target.value })} />
            </div>
            <div className="field">
              <label>新密码</label>
              <input type="password" value={password.next} autoComplete="new-password" onChange={(event) => setPassword({ ...password, next: event.target.value })} />
            </div>
            <div className="field">
              <label>确认新密码</label>
              <input type="password" value={password.confirm} autoComplete="new-password" onChange={(event) => setPassword({ ...password, confirm: event.target.value })} />
            </div>
          </div>
        </div>
      </section>

      <section className="panel acct">
        <div className="panel-head">
          <div>
            <h3>角色与访问范围</h3>
            <div className="sub">权限由服务端计算，页面展示不等于数据授权</div>
          </div>
          {ctx.session.is_admin ? (
            <button type="button" className="link" onClick={() => { window.location.hash = "access"; }}>
              站点管理 →
            </button>
          ) : null}
        </div>
        <div className="panel-body">
          <div className="role-line">
            <span>当前身份</span>
            <span className="role-pill">{ctx.session.is_admin ? "站点管理员" : "个人账号"}</span>
          </div>
          <div className="perm-grid">
            <div>
              <label>可访问模块</label>
              <div className="tags">
                {ctx.session.modules.map((module) => (
                  <span key={module}>{MODULE_LABELS[module] || module}</span>
                ))}
              </div>
            </div>
            <div>
              <label>数据范围</label>
              <div className="tags outline">
                <span>仅本人记录</span>
                <span>本人资料与密码</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel acct">
        <div className="panel-head">
          <div>
            <h3>数据与登录</h3>
            <div className="sub">导出、会话与退出</div>
          </div>
        </div>
        <div className="panel-body">
          <div className="btn-row wrap">
            <a className="btn" href="/api/export" download>导出全部 JSON</a>
            <a className="btn" href="/api/export/todos.csv" download>导出短期待办 CSV</a>
            <button type="button" onClick={() => void logout()}>退出登录</button>
          </div>
        </div>
      </section>
    </div>
  );
}
