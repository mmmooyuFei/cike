import { useEffect, useState } from "react";
import { api, errorText } from "../api";
import type { AppContextValue } from "../types";

type RepoState = {
  available: boolean;
  path: string;
  reason?: string;
  output?: string;
  branch?: string;
  detached?: boolean;
  commit?: string;
  commit_short?: string;
  subject?: string;
  date?: string;
  author?: string;
  dirty?: boolean;
  dirty_files?: number;
  remote?: string;
  upstream?: string;
  sync?: { ahead: number; behind: number } | null;
  local_commits?: LocalCommit[];
  diverged?: boolean;
};

type LocalCommit = { hash: string; short: string; date: string; author: string; subject: string };

type PullMode = "ff" | "rebase" | "reset";

type PullResult = {
  ok: boolean;
  reason?: string;
  mode?: PullMode;
  before?: string;
  after?: string;
  changed?: boolean;
  ahead?: number;
  behind?: number;
  local_commits?: LocalCommit[];
  output?: string;
  rebuild?: { queued: boolean; reason?: string };
};

type Conflict = { ahead: number; behind: number; commits: LocalCommit[]; output: string; conflict?: boolean };

type RebuildState = {
  state: "idle" | "queued" | "running" | "success" | "failed";
  from: string;
  to: string;
  trigger: string;
  requested_at: string;
  started_at: string;
  finished_at: string;
  duration_s: number | null;
  error: string;
  log_tail: string;
  available: boolean;
  runner: { installed: boolean; name: string; installed_at: string };
};

type UpdateStatus = {
  running: { commit: string; commit_short: string; deployment: string };
  repo: RepoState;
  hint: string | null;
  capabilities: { fetch: boolean; pull: boolean; rebuild: boolean; restart: boolean };
  commands: { update: string; install_runner: string; health: string; enable_repo: string };
  rebuild: RebuildState;
  checked_at: string;
};

type Commit = { hash: string; short: string; date: string; author: string; subject: string; current: boolean };

const REASON_TEXT: Record<string, string> = {
  repo_not_mounted: "容器里没有挂载 Git 仓库，只能显示构建时写入的版本号。",
  repo_path_invalid: "UPDATE_REPO_DIR 指向的目录没有 .git，检查挂载路径。",
  not_a_git_repository: "UPDATE_REPO_DIR 不是 Git 仓库。",
};

const POLL_MS = 4000;

function syncText(repo: RepoState): string {
  if (!repo.available) return "—";
  if (!repo.sync) return "未比较远端";
  if (repo.sync.behind === 0 && repo.sync.ahead === 0) return "与远端一致";
  const parts: string[] = [];
  if (repo.sync.behind) parts.push(`落后 ${repo.sync.behind} 个提交`);
  if (repo.sync.ahead) parts.push(`领先 ${repo.sync.ahead} 个提交`);
  return parts.join(" · ");
}

function secondsText(value: number | null): string {
  if (!value || value < 0) return "";
  if (value < 60) return `${Math.round(value)} 秒`;
  return `${Math.floor(value / 60)} 分 ${Math.round(value % 60)} 秒`;
}

function recentIso(iso: string, hours = 24): boolean {
  if (!iso) return false;
  const stamp = Date.parse(iso);
  if (Number.isNaN(stamp)) return false;
  return Date.now() - stamp < hours * 3600 * 1000;
}

export function Update({ ctx }: { ctx: AppContextValue }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"fetch" | "pull" | "rebuild" | "restart" | null>(null);
  const [polling, setPolling] = useState(false);
  const [settled, setSettled] = useState<"success" | "failed" | null>(null);
  const [giveUp, setGiveUp] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [divergedOpen, setDivergedOpen] = useState(false);

  const loadCommits = async () => {
    try {
      const log = await api.get<{ items: Commit[] }>("/update/commits?limit=15");
      setCommits(log.items);
    } catch {
      setCommits([]);
    }
  };

  const readStatus = async (quiet = false, withCommits = true) => {
    if (!quiet) setLoading(true);
    try {
      const payload = await api.get<UpdateStatus>("/update/status");
      setStatus(payload);
      setError("");
      if (payload.repo.available && withCommits) void loadCommits();
      else if (!payload.repo.available) setCommits([]);
      return payload;
    } catch (err) {
      if (!quiet) setError(errorText(err));
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    void readStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.refreshKey]);

  // 重建期间轮询：容器重建时请求会断开，重试到拿到终态为止
  useEffect(() => {
    if (!polling) return;
    let alive = true;
    let ticks = 0;
    const tick = async () => {
      ticks += 1;
      if (ticks > (15 * 60 * 1000) / POLL_MS) {
        setPolling(false);
        setGiveUp(true);
        ctx.toast("重建超过 15 分钟仍未结束，检查 systemctl status cike-update-wake.path");
        return;
      }
      const payload = await readStatus(true, false);
      if (!alive || !payload) return;
      const state = payload.rebuild.state;
      if (state === "success" || state === "failed") {
        setPolling(false);
        setSettled(state);
        void readStatus(true, true);
        ctx.toast(
          state === "success"
            ? `已更新到 ${payload.rebuild.to || payload.running.commit_short}`
            : "重建失败，已回滚到原镜像，详情见更新管理",
        );
      }
    };
    const timer = window.setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling]);

  // 刷新页面时如果重建还在跑，接着把进度轮询下去
  useEffect(() => {
    if (!status || polling || giveUp) return;
    if (status.rebuild.state === "queued" || status.rebuild.state === "running") setPolling(true);
  }, [status, polling, giveUp]);

  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      ctx.toast(`已复制${label}`);
    } catch {
      ctx.toast("浏览器不允许写剪贴板，请手动复制");
    }
  };

  const checkRemote = async () => {
    setBusy("fetch");
    try {
      const result = await api.post<{ sync: { ahead: number; behind: number } | null }>("/update/fetch");
      ctx.toast(result.sync?.behind ? `远端有 ${result.sync.behind} 个新提交` : "已是最新");
      await readStatus();
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const startPolling = () => {
    setSettled(null);
    setGiveUp(false);
    setPolling(true);
  };

  const pull = async (mode: PullMode = "ff") => {
    const willRebuild = Boolean(status?.capabilities.rebuild);
    const question =
      mode === "reset"
        ? `会丢弃部署机上的未推送提交（${aheadCount} 个），把仓库对齐到远端，然后自动安全重建。站点会短暂重启。确定？`
        : mode === "rebase"
          ? "会把部署机上的本地提交变基到远端之上，再自动安全重建。历史被改写，站点会短暂重启。继续？"
          : willRebuild
            ? "会先 git pull --ff-only，再自动执行安全重建：备份数据库 → 构建镜像 → 重建容器 → 健康检查，失败自动回滚上一镜像。重建期间站点会短暂重启。继续？"
            : "会用 git pull --ff-only 更新仓库。当前没有可用的宿主机重建执行器，拉取后不会自动生效。继续？";
    if (!window.confirm(question)) return;
    setBusy("pull");
    try {
      const result = await api.post<PullResult>("/update/pull", { mode });
      if (!result.ok) {
        if (result.reason === "diverged") {
          setConflict({
            ahead: result.ahead || 0,
            behind: result.behind || 0,
            commits: result.local_commits || [],
            output: result.output || "",
          });
          ctx.toast("本地提交和远端分叉了：选「变基」保留，或「以远端为准」丢弃");
        } else if (result.reason === "rebase_conflict") {
          setConflict({ ahead: 0, behind: 0, commits: [], output: result.output || "", conflict: true });
          ctx.toast("变基冲突，已自动中止；手动处理后重试");
        } else {
          ctx.toast("拉取没有成功");
        }
        await readStatus();
        return;
      }
      setConflict(null);
      if (result.rebuild?.queued) {
        ctx.toast(mode === "reset" ? "已对齐远端，正在自动重建" : "已拉取代码，正在自动重建，页面会自己更新");
        startPolling();
      } else if (result.changed) {
        ctx.toast(`已拉取 ${result.before} → ${result.after}`);
      } else {
        ctx.toast("已经是最新版本");
      }
      await readStatus();
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const rebuildNow = async () => {
    if (!window.confirm("会备份数据库、重建镜像并重建容器，期间站点短暂重启，失败自动回滚。继续？")) return;
    setBusy("rebuild");
    try {
      const result = await api.post<{ queued: boolean; reason?: string; rebuild?: { queued: boolean; reason?: string } }>(
        "/update/rebuild",
      );
      const queued = result.queued ?? result.rebuild?.queued;
      if (queued) {
        ctx.toast("已排队重建，页面会自己更新");
        startPolling();
      } else {
        ctx.toast(result.reason === "already_running" ? "运行版本已经是仓库最新提交" : "没有开始重建");
      }
      await readStatus();
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const restart = async () => {
    if (!window.confirm("会请求服务退出，依赖容器的 restart 策略自动拉起。确定继续？")) return;
    setBusy("restart");
    try {
      await api.post("/update/restart");
      ctx.toast("服务即将重启，稍后刷新页面");
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading && !status) {
    return (
      <div className="stack">
        <div className="skeleton row-skeleton" />
        <div className="skeleton row-skeleton" />
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="panel empty">
        <b>读取更新状态失败</b>
        <p>{error}</p>
        <button type="button" className="primary" onClick={() => void readStatus()}>重试</button>
      </div>
    );
  }

  if (!status) return null;

  const repo = status.repo;
  const rebuild = status.rebuild;
  const behind = repo.sync?.behind ?? 0;
  const outdated = status.hint === "running_commit_differs";
  const rebuilding = polling || rebuild.state === "queued" || rebuild.state === "running";
  const failed =
    !rebuilding &&
    rebuild.state === "failed" &&
    Boolean(rebuild.to) &&
    !rebuild.to.startsWith(status.running.commit_short || "\u0000") &&
    recentIso(rebuild.finished_at);
  const finished = !rebuilding && rebuild.state === "success" && settled === "success";
  const aheadCount = conflict?.ahead || repo.sync?.ahead || 0;
  const aheadCommits = (conflict?.commits?.length ? conflict.commits : repo.local_commits || []).slice(0, 6);
  const behindCount = conflict?.behind || behind;
  const diverged = Boolean(conflict) || Boolean(repo.diverged) || (aheadCount > 0 && behindCount > 0);
  const canResolve = Boolean(repo.available) && status.capabilities.pull && !rebuilding;
  const state = rebuilding
    ? { text: "正在重建", tone: "warn" }
    : !repo.available
      ? { text: "未挂载仓库", tone: "muted" }
      : diverged
        ? { text: `本地 ${aheadCount} 个提交未推送`, tone: "warn" }
        : outdated
          ? { text: "仓库已更新，待重建", tone: "warn" }
          : behind > 0
            ? { text: `落后 ${behind} 个提交`, tone: "warn" }
            : { text: "已是最新", tone: "ok" };
  const deployment = status.running.deployment === "docker" ? "Docker 容器" : "主机进程";
  const runningShort = status.running.commit_short || "—";
  const pullLabel = busy === "pull" ? "拉取中…" : status.capabilities.rebuild ? "拉取并重建" : "拉取更新";

  return (
    <div className="upd">
      <section className="upd-hero">
        <div className="upd-hero-main">
          <div className="upd-eyebrow">运行版本</div>
          <div className="upd-version">
            <button
              type="button"
              className="upd-hash"
              title="复制运行提交"
              onClick={() => void copy(status.running.commit || runningShort, "运行提交")}
            >
              {runningShort}
            </button>
            <span className={`pill ${state.tone}`}>{state.text}</span>
          </div>
          <div className="upd-sub">
            <span>{deployment}</span>
            {repo.available ? (
              <>
                <i />
                <span>{repo.branch}{repo.detached ? "（分离 HEAD）" : ""}</span>
                <i />
                <span>工作区 {repo.dirty ? `${repo.dirty_files} 个改动` : "干净"}</span>
                {repo.date ? (
                  <>
                    <i />
                    <span>{repo.date} · {repo.author}</span>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        <div className="upd-actions">
          <button
            type="button"
            className="primary"
            disabled={!status.capabilities.pull || busy !== null || rebuilding}
            onClick={() => void pull("ff")}
          >
            {pullLabel}
          </button>
          <button type="button" disabled={!status.capabilities.fetch || busy !== null || rebuilding} onClick={() => void checkRemote()}>
            {busy === "fetch" ? "检查中…" : "检查远端"}
          </button>
          <button type="button" onClick={() => void copy(status.commands.update, "更新命令")}>复制更新命令</button>
          <button
            type="button"
            className="ghost danger-text"
            disabled={!status.capabilities.restart || busy !== null}
            title={status.capabilities.restart ? "重启服务进程" : "需要 UPDATE_ALLOW_RESTART=true"}
            onClick={() => void restart()}
          >
            {busy === "restart" ? "重启中…" : "重启服务"}
          </button>
          <button type="button" className="ghost" disabled={loading} onClick={() => void readStatus()}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </section>

      {repo.available && aheadCount > 0 ? (
        <div className="note">
          <b>{diverged ? "本地提交和远端分叉了" : "部署机上有未推送的提交"}</b>
          ：{aheadCount} 个提交只存在于这台机器
          {aheadCommits.length ? `（${aheadCommits.map((item) => item.short).join("、")}）` : null}，
          {behindCount > 0
            ? `远端同时还有 ${behindCount} 个新提交，快进拉取会直接失败。`
            : "远端暂时没有新提交，但先推回仓库再更新更稳。"}
          {aheadCommits.length ? (
            <>
              <button type="button" className="ghost" onClick={() => setDivergedOpen((open) => !open)}>
                {divergedOpen ? "收起提交" : "看看这些提交"}
              </button>
              {divergedOpen ? (
                <ul className="upd-commit-list">
                  {aheadCommits.map((item) => (
                    <li key={item.hash}>
                      <code>{item.short}</code>
                      <span>{item.subject}</span>
                      <em>{item.date} · {item.author}</em>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          ) : null}
          {behindCount > 0 ? (
            <div className="upd-resolve">
              <button type="button" disabled={!canResolve || busy !== null} onClick={() => void pull("rebase")}>
                变基保留本地提交
              </button>
              <button
                type="button"
                className="ghost danger-text"
                disabled={!canResolve || busy !== null}
                onClick={() => void pull("reset")}
              >
                以远端为准并重建
              </button>
              <span>变基会改写这几笔提交的 hash；以远端为准会把它们从部署机上丢掉（先 push 才不丢）。</span>
            </div>
          ) : null}
          {conflict?.output ? <pre className="upd-log">{conflict.output}</pre> : null}
        </div>
      ) : null}

      {!repo.available ? (
        <div className="note">
          {REASON_TEXT[repo.reason || ""] || "容器里没有可用的 Git 仓库。"}
          {repo.output ? `（${repo.output}）` : ""}
          {" "}在 <code>docker-compose.yml</code> 挂载仓库并设置 <code>UPDATE_REPO_DIR</code> 后可查看分支与提交。
        </div>
      ) : null}

      {rebuilding ? (
        <div className="note">
          <b>正在安全重建</b>
          ：「拉取并重建」已交给宿主机执行器，顺序是备份数据库 → 构建镜像（写入提交号 {rebuild.to || "…"}）→ 重建容器 → 健康检查，
          任一步失败会自动回滚上一镜像。容器重建时本站会短暂断开，本页会自己恢复。
        </div>
      ) : null}

      {failed ? (
        <div className="note">
          <b>上次重建失败</b>
          {rebuild.error ? `（${rebuild.error}）` : null}
          ：脚本已按自身流程回滚，站点还在 {runningShort} 上运行。日志末尾可直接查看。
          <button type="button" className="ghost" onClick={() => setLogOpen((open) => !open)}>
            {logOpen ? "收起日志" : "查看日志"}
          </button>
          {logOpen && rebuild.log_tail ? <pre className="upd-log">{rebuild.log_tail}</pre> : null}
        </div>
      ) : null}

      {finished ? (
        <div className="note">
          <b>已更新到 {rebuild.to || runningShort}</b>
          {rebuild.duration_s ? `，用时 ${secondsText(rebuild.duration_s)}` : null}
          。备份与镜像都留在服务器上，需要回退时可用上一镜像。
        </div>
      ) : null}

      {!rebuilding && !failed && outdated ? (
        <div className="note">
          仓库 HEAD 与运行版本不一致：代码已经更新到 {repo.commit_short || "新提交"}，但镜像还是 {runningShort}。
          {status.capabilities.rebuild ? (
            <>
              {" "}
              <button type="button" className="ghost" disabled={busy !== null} onClick={() => void rebuildNow()}>
                {busy === "rebuild" ? "排队中…" : "重建并上线"}
              </button>
            </>
          ) : (
            <> 这台服务器还没安装重建执行器：<code>{status.commands.install_runner}</code>，装好后页面就能一键完成。</>
          )}
        </div>
      ) : null}

      {!status.capabilities.rebuild && repo.available && !outdated ? (
        <div className="note">
          当前没有宿主机重建执行器，页面只能拉取代码、不能自动生效。在服务器上执行
          {" "}<code>{status.commands.install_runner}</code> 安装后，「拉取更新」会自动完成备份、重建与健康检查。
        </div>
      ) : null}

      {status.hint === "repo_readonly" ? (
        <div className="note">仓库是只读挂载：可以看提交记录，但无法发「检查远端 / 拉取更新」。需要拉取时把挂载改成 <code>:rw</code>。</div>
      ) : null}

      <div className="upd-grid">
        <div className="upd-col">
          <section className="upd-card">
            <div className="upd-card-head">
              <div>
                <h3>最近提交</h3>
                <p>{repo.available ? `${repo.upstream || "origin"} · 最多 15 条` : "未挂载仓库"}</p>
              </div>
              <button type="button" className="ghost" disabled={!repo.available || loading} onClick={() => void readStatus()}>
                刷新
              </button>
            </div>
            {!repo.available ? (
              <div className="upd-empty">
                <b>只能看到构建时的版本</b>
                <p>挂载仓库后，这里会按时间列出远端最近的提交，并标出当前部署的那条。</p>
              </div>
            ) : commits.length === 0 ? (
              <div className="upd-empty">
                <b>还没有提交记录</b>
                <p>点「检查远端」拉取一次远端引用后再看。</p>
              </div>
            ) : (
              <div className="commit-list">
                {commits.map((commit) => {
                  const runningHere =
                    Boolean(status.running.commit) && commit.hash.startsWith(status.running.commit);
                  return (
                    <div className={`commit-row ${commit.current ? "is-current" : ""}`} key={commit.hash}>
                      <code className="commit-hash">{commit.short}</code>
                      <div className="commit-body">
                        <div className="commit-subject" title={commit.subject}>{commit.subject}</div>
                        <div className="commit-meta">
                          <span>{commit.author}</span>
                          <span>·</span>
                          <span>{commit.date}</span>
                          {runningHere ? (
                            <span className="pill ok">运行中</span>
                          ) : commit.current ? (
                            <span className="pill muted">仓库 HEAD</span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <aside className="upd-side">
          <section className="upd-card">
            <div className="upd-card-head">
              <div>
                <h3>仓库</h3>
                <p>{repo.available ? "当前挂载的 Git 仓库" : "未挂载"}</p>
              </div>
            </div>
            <dl className="upd-kv">
              <div>
                <dt>分支</dt>
                <dd>{repo.available ? `${repo.branch}${repo.detached ? "（分离）" : ""}` : "—"}</dd>
              </div>
              <div>
                <dt>同步</dt>
                <dd>{repo.available ? syncText(repo) : "—"}</dd>
              </div>
              <div>
                <dt>工作区</dt>
                <dd className={repo.dirty ? "bad" : "good"}>{repo.available ? (repo.dirty ? `${repo.dirty_files} 个未提交改动` : "干净") : "—"}</dd>
              </div>
              <div>
                <dt>执行器</dt>
                <dd className={rebuild.available ? "good" : "bad"}>
                  {rebuild.runner.installed ? `已安装 · ${rebuild.runner.name || "宿主执行器"}` : "未安装"}
                </dd>
              </div>
              <div>
                <dt>远端</dt>
                <dd className="mono">{repo.remote || "—"}</dd>
              </div>
              <div>
                <dt>路径</dt>
                <dd className="mono">{repo.path || "—"}</dd>
              </div>
            </dl>
          </section>

          <section className="upd-card">
            <div className="upd-card-head">
              <div>
                <h3>更新流程</h3>
                <p>页面点一下，宿主机按这个顺序跑完</p>
              </div>
              <button type="button" className="ghost" onClick={() => void copy(status.commands.update, "更新命令")}>
                复制
              </button>
            </div>
            <ol className="upd-steps">
              <li><b>拉取代码</b><code>git pull --ff-only</code></li>
              <li><b>备份数据库</b><code>pg_dump</code>，保留最近 10 份</li>
              <li><b>构建镜像</b>写入提交号 <code>GIT_COMMIT</code></li>
              <li><b>重建容器</b>并等待健康检查</li>
              <li><b>失败回滚</b>到上一个镜像</li>
            </ol>
            <div className="upd-note">
              {status.capabilities.rebuild
                ? "「拉取并重建」只更新仓库并落一个唤醒文件，真正的构建在宿主机上执行（应用容器不持有 docker 权限）；进度与日志回写到数据目录，所以这一页刷新后仍能看到结果。"
                : `重建目前还没接上宿主机执行器：先执行 ${status.commands.install_runner}，页面才能一键完成；在那之前用 ${status.commands.update} 手动更新。`}
            </div>
          </section>

          {!status.capabilities.restart ? (
            <p className="upd-hint">「重启服务」默认关闭：需要 <code>UPDATE_ALLOW_RESTART=true</code>，并保证容器有 restart 策略。</p>
          ) : null}
          {!status.capabilities.fetch ? (
            <p className="upd-hint">未挂载仓库时，「检查远端 / 拉取更新」不可用。</p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
