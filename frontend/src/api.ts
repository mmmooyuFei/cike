export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function csrf(): string {
  const match = document.cookie.match(/(?:^|;\s*)cike_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("X-CSRF-Token", csrf());
  }
  const response = await fetch(`/api${path}`, {
    ...options,
    method,
    headers,
    credentials: "include",
  });
  if (!response.ok) {
    let detail = "request_failed";
    try {
      const body = await response.json();
      detail = typeof body?.detail === "string" ? body.detail : JSON.stringify(body?.detail ?? body);
    } catch {
      detail = response.statusText;
    }
    throw new ApiError(response.status, detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return request<T>(path, { method: "POST", body });
  },
};

const ERROR_TEXT: Record<string, string> = {
  authentication_required: "登录已过期，请重新登录",
  account_unavailable: "账号不可用，请联系站点管理员",
  session_expired: "登录已过期，请重新登录",
  csrf_validation_failed: "页面已失效，请刷新后重试",
  admin_required: "只有管理员可以执行这个操作",
  module_forbidden: "没有这个模块的权限",
  record_not_found: "记录不存在或已被删除",
  record_conflict: "同一天（或同月同账户）已经有记录，请直接改那一条",
  restore_conflict: "恢复失败：同一日期已有记录，先删掉现有的那条",
  invalid_date: "日期格式不正确",
  invalid_time: "时间格式不正确，应为 24 小时制 HH:MM",
  invalid_number: "请填写数字",
  invalid_json: "数据格式不正确",
  missing_title: "请填写标题",
  missing_item: "请填写事项",
  unknown_module: "未知模块",
  invalid_display_name: "显示名称不能为空，且不超过 40 个字",
  invalid_gender: "性别取值不正确",
  invalid_birthday: "生日不能晚于今天",
  invalid_brand_name: "站点名称不能为空，且不超过 12 个字",
  invalid_brand_subtitle: "副标题不超过 24 个字",
  invalid_image: "图片格式不支持，请用 PNG / JPG / WebP",
  avatar_too_large: "图片超过 5MB",
  logo_too_large: "图片超过 2MB",
  avatar_not_found: "还没有上传头像",
  logo_not_found: "还没有上传 LOGO",
  reauthorize_required: "统一认证会话已过期，请重新登录后再试",
  invalid_password: "新密码至少 12 位",
  dev_mode: "本地开发模式不支持修改密码",
  invalid_rules: "权限规则格式不正确",
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return ERROR_TEXT[error.message] || error.message;
  if (error instanceof Error) return error.message;
  return "请求失败";
}
