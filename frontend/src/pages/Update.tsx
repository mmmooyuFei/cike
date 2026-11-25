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
  const behind = repo.sync?.behind ?? 0;
  const outdated = status.hint === "running_commit_differs";
  const state = !repo.available
    ? { text: "未挂载仓库", tone: "muted" }
    : outdated
      ? { text: "仓库已更新，待重建", tone: "warn" }
      : behind > 0
        ? { text: `落后 ${behind} 个提交`, tone: "warn" }
        : { text: "已是最新", tone: "ok" };
  const deployment = status.running.deployment === "docker" ? "Docker 容器" : "主机进程";
  const runningShort = status.running.commit_short || "—";

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
          <button type="button" className="primary" disabled={!status.capabilities.pull || busy !== null} onClick={() => void pull()}>
            {busy === "pull" ? "拉取中…" : "拉取更新"}
          </button>
          <button type="button" disabled={!status.capabilities.fetch || busy !== null} onClick={() => void checkRemote()}>
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
          <button type="button" className="ghost" disabled={loading} onClick={() => void load()}>
            {loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </section>

      {!repo.available ? (
        <div className="note">
          {REASON_TEXT[repo.reason || ""] || "容器里没有可用的 Git 仓库。"}
          {repo.output ? `（${repo.output}）` : ""}
          {" "}在 <code>docker-compose.yml</code> 挂载仓库并设置 <code>UPDATE_REPO_DIR</code> 后可查看分支与提交。
        </div>
      ) : null}
      {outdated ? <div className="note">仓库 HEAD 与运行版本不一致：代码已经更新，但镜像还是旧的。执行 <code>{status.commands.update}</code> 重建。</div> : null}
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
              <button type="button" className="ghost" disabled={!repo.available || loading} onClick={() => void load()}>
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
                <p>重建镜像仍走服务器脚本</p>
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
              页面上的「拉取更新」只更新仓库；重建镜像与健康检查请执行
              <code>{status.commands.update}</code>。
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
