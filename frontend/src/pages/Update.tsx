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
};

type UpdateStatus = {
  running: { commit: string; commit_short: string; deployment: string };
  repo: RepoState;
  hint: string | null;
  capabilities: { fetch: boolean; pull: boolean; restart: boolean };
  commands: { update: string; health: string; enable_repo: string };
  checked_at: string;
};

type Commit = { hash: string; short: string; date: string; author: string; subject: string; current: boolean };

const REASON_TEXT: Record<string, string> = {
  repo_not_mounted: "容器里没有挂载 Git 仓库，只能显示构建时写入的版本号。",
  repo_path_invalid: "UPDATE_REPO_DIR 指向的目录没有 .git，检查挂载路径。",
  not_a_git_repository: "UPDATE_REPO_DIR 不是 Git 仓库。",
};

function syncText(repo: RepoState): string {
  if (!repo.available) return "—";
  if (!repo.sync) return "未比较远端";
  if (repo.sync.behind === 0 && repo.sync.ahead === 0) return "与远端一致";
  const parts: string[] = [];
  if (repo.sync.behind) parts.push(`落后 ${repo.sync.behind} 个提交`);
  if (repo.sync.ahead) parts.push(`领先 ${repo.sync.ahead} 个提交`);
  return parts.join(" · ");
}

export function Update({ ctx }: { ctx: AppContextValue }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"fetch" | "pull" | "restart" | null>(null);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await api.get<UpdateStatus>("/update/status");
      setStatus(payload);
      if (payload.repo.available) {
        try {
          const log = await api.get<{ items: Commit[] }>("/update/commits?limit=15");
          setCommits(log.items);
        } catch {
          setCommits([]);
        }
      } else {
        setCommits([]);
      }
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
      await load();
    } catch (err) {
      ctx.toast(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const pull = async () => {
    if (!window.confirm("会用 git pull --ff-only 更新仓库；之后还需要在服务器执行 bash scripts/update.sh 重建镜像。继续？")) return;
    setBusy("pull");
    try {
      const result = await api.post<{ changed: boolean; before: string; after: string }>("/update/pull");
      ctx.toast(result.changed ? `已拉取 ${result.before} → ${result.after}，请执行 update.sh 重建镜像` : "已经是最新版本");
      await load();
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
        <button type="button" className="primary" onClick={() => void load()}>重试</button>
      </div>
    );
  }

  if (!status) return null;
  const repo = status.repo;

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>运行版本</h3>
            <div className="sub">镜像构建时写入的提交号；更新后需要重建镜像才会变化</div>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading}>刷新</button>
        </div>
        <div className="panel-body">
          <div className="perm-grid">
            <div>
              <label>运行提交</label>
              <div className="tags outline">
                <span>{status.running.commit_short || "未记录（旧镜像）"}</span>
                <span>{status.running.deployment === "docker" ? "Docker 容器" : "主机进程"}</span>
              </div>
            </div>
            <div>
              <label>仓库状态</label>
              <div className="tags outline">
                <span>{repo.available ? `${repo.branch}${repo.detached ? "（分离 HEAD）" : ""}` : "未挂载仓库"}</span>
                <span>{repo.available ? syncText(repo) : "仅版本号"}</span>
              </div>
            </div>
          </div>
          {repo.available ? (
            <>
              <div className="fin-row">
                <span className="acct">当前提交</span>
                <b>{repo.commit_short} · {repo.subject || "—"}</b>
              </div>
              <div className="fin-row">
                <span className="acct">提交时间 / 作者</span>
                <b className="muted">{repo.date || "—"} · {repo.author || "—"}</b>
              </div>
              <div className="fin-row">
                <span className="acct">工作区</span>
                <b className={repo.dirty ? "down" : "up"}>{repo.dirty ? `有 ${repo.dirty_files} 个未提交改动` : "干净"}</b>
              </div>
              <div className="fin-row">
                <span className="acct">远端</span>
                <b className="muted">{repo.remote || "未配置 origin"}</b>
              </div>
            </>
          ) : (
            <div className="note">
              {REASON_TEXT[repo.reason || ""] || "容器里没有可用的 Git 仓库。"}
              {repo.output ? `（${repo.output}）` : ""}
              <br />
              需要在线检查 / 拉取时，在 <code>docker-compose.yml</code> 里挂载仓库并设置 <code>UPDATE_REPO_DIR</code>：
              <br />
              <code>{status.commands.enable_repo}</code>
            </div>
          )}
          {status.hint === "running_commit_differs" ? (
            <div className="note">
              仓库 HEAD 与运行版本不一致：代码已经更新，但镜像还是旧的。执行 <code>{status.commands.update}</code> 重建。
            </div>
          ) : null}
          {status.hint === "repo_readonly" ? (
            <div className="note">
              仓库是只读挂载：可以看提交记录，但无法发「检查远端 / 拉取更新」。需要拉取时把挂载改成 <code>:rw</code>。
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>检查与更新</h3>
            <div className="sub">只做 git 操作；重建镜像与健康检查交给 scripts/update.sh</div>
          </div>
        </div>
        <div className="panel-body">
          <div className="btn-row">
            <button type="button" disabled={!status.capabilities.fetch || busy !== null} onClick={() => void checkRemote()}>
              {busy === "fetch" ? "检查中…" : "检查远端"}
            </button>
            <button type="button" className="primary" disabled={!status.capabilities.pull || busy !== null} onClick={() => void pull()}>
              {busy === "pull" ? "拉取中…" : "拉取更新"}
            </button>
            <button type="button" disabled={!status.capabilities.restart || busy !== null} onClick={() => void restart()}>
              {busy === "restart" ? "重启中…" : "重启服务"}
            </button>
            <button type="button" onClick={() => void copy(status.commands.update, "更新命令")}>复制更新命令</button>
          </div>
          <div className="note">
            生产更新流程：<code>{status.commands.update}</code> 会依次执行「git pull → pg_dump 备份 → 构建镜像 → 重建容器 →
            健康检查（<code>{status.commands.health}</code>）→ 失败回滚」，备份保留最近 10 份。
          </div>
          {!status.capabilities.fetch ? (
            <div className="field-hint">未挂载仓库时，「检查远端 / 拉取更新」不可用。</div>
          ) : null}
          {!status.capabilities.restart ? (
            <div className="field-hint">「重启服务」默认关闭：需要设置 UPDATE_ALLOW_RESTART=true，并保证容器有 restart 策略。</div>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>最近提交</h3>
            <div className="sub">{repo.available ? `来自 ${repo.upstream || "origin"}` : "未挂载仓库"}</div>
          </div>
        </div>
        <div className="panel-body">
          {!repo.available ? (
            <div className="empty small">
              <b>只能看到构建时的版本</b>
              <p>挂载仓库后，这里会列出远端最近的提交，并标出当前运行的那一条。</p>
            </div>
          ) : commits.length === 0 ? (
            <div className="empty small">
              <b>还没有提交记录</b>
              <p>检查远端后再看一次。</p>
            </div>
          ) : (
            commits.map((commit) => (
              <div className="fin-row" key={commit.hash}>
                <span className="acct">
                  <i>{commit.current ? "●" : ""}</i>
                  {commit.subject}
                </span>
                <b className="muted">{commit.short} · {commit.date}</b>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
