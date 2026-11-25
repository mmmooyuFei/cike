import { useEffect, useRef, useState } from "react";
import { api, errorText } from "../api";
import { useAuth } from "../auth";
import { LogoMark, MODULE_LABELS } from "../components";
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
  const [brandName, setBrandName] = useState(ctx.brand.name);
  const [brandSaving, setBrandSaving] = useState(false);
  const avatarInput = useRef<HTMLInputElement>(null);
  const logoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDisplayName(user.display_name);
    setGender(user.gender || "");
    setBirthday(user.birthday || "");
  }, [user.id, user.display_name, user.gender, user.birthday]);

  useEffect(() => {
    setBrandName(ctx.brand.name);
  }, [ctx.brand.name]);

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
    try {
      await api.upload("/account/avatar", file);
      ctx.toast("头像已更新");
      ctx.refresh();
    } catch (error) {
      ctx.toast(errorText(error));
    }
  };

  const saveBrand = async () => {
    setBrandSaving(true);
    try {
      await api.put("/settings/brand", { name: brandName.trim() || "此刻" });
      ctx.toast("品牌已保存");
      ctx.refresh();
    } catch (error) {
      ctx.toast(errorText(error));
    } finally {
      setBrandSaving(false);
    }
  };

  const uploadLogo = async (file: File | undefined) => {
    if (!file) return;
    try {
      await api.upload("/settings/brand/logo", file);
      ctx.toast("LOGO 已更新");
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
              {user.avatar_url ? (
                <img className="avatar-big" src={user.avatar_url} alt={displayName} />
              ) : (
                <div className="avatar-big">{(displayName || "此").slice(0, 1)}</div>
              )}
              <button type="button" className="link" onClick={() => avatarInput.current?.click()}>
                更换头像
              </button>
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
          <div className="note">用户名、手机号、邮箱由 Casdoor 统一身份托管；本页只展示，不代写。头像与显示名保存在本站。</div>
        </div>
      </section>

      {ctx.session.is_admin ? (
        <section className="panel acct">
          <div className="panel-head">
            <div>
              <h3>品牌与外观</h3>
              <div className="sub">左上角名称与 LOGO · 默认“此刻”</div>
            </div>
          </div>
          <div className="panel-body">
            <div className="brand-box">
              <div className="brand-preview">
                {ctx.brand.logo_url ? <img className="brand-logo" src={ctx.brand.logo_url} alt="" /> : <LogoMark size={38} />}
                <div>
                  <b>{ctx.brand.name}</b>
                  <small>个人工作台</small>
                </div>
              </div>
              <div className="brand-fields">
                <div className="field">
                  <label htmlFor="brand-name">站点名称</label>
                  <input id="brand-name" value={brandName} maxLength={12} onChange={(event) => setBrandName(event.target.value)} />
                </div>
                <div className="field">
                  <label>LOGO</label>
                  <div className="btn-row">
                    <button type="button" onClick={() => logoInput.current?.click()}>上传图片</button>
                    <button type="button" onClick={() => setBrandName("此刻")}>恢复默认名称</button>
                  </div>
                  <input
                    ref={logoInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    hidden
                    onChange={(event) => {
                      void uploadLogo(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                  <div className="field-hint">PNG / JPG / SVG，建议方形，≤2MB</div>
                </div>
                <button type="button" className="primary" onClick={() => void saveBrand()} disabled={brandSaving}>
                  {brandSaving ? "保存中…" : "保存品牌"}
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

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
              权限管理 →
            </button>
          ) : null}
        </div>
        <div className="panel-body">
          <div className="role-line">
            <span>当前身份</span>
            <span className="role-pill">{ctx.session.is_admin ? "站点管理员" : "个人用户"}</span>
            {user.roles.map((role) => (
              <span className="role-pill soft" key={role}>{role}</span>
            ))}
            {user.groups.map((group) => (
              <span className="role-pill soft" key={group}>{group}</span>
            ))}
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
            <a className="btn" href="/api/export/todos.csv" download>导出待办 CSV</a>
            <button type="button" onClick={() => void logout()}>退出登录</button>
          </div>
          <div className="note">生产环境为 Casdoor OIDC 会话；本地开发为身份切换器。导出只包含当前用户的数据。</div>
        </div>
      </section>
    </div>
  );
}
