import { tr } from "../i18n";

export type ApiErrorCode =
  | "AUTH_401"
  | `HTTP_${number}`
  | "NET_TIMEOUT"
  | "NET_DNS"
  | "NET_PROXY"
  | "NET_TLS"
  | "NET_CONN"
  | "NET_REDIRECT"
  | "SEC_POLICY"
  | "SRC_TIMEOUT"
  | "SRC_UNSUPPORTED"
  | "SRC_PARSE"
  | "SRC_RUNTIME"
  | "APP_ERROR";

export type ClassifiedApiError = {
  code: ApiErrorCode;
  message: string;
  networkish: boolean;
  status: string | null;
  logSummary: string;
};

const JS_STACK_TAIL = /\s+at\s+[^\n]*(?:\([^)]*\)|eval_script[^\n]*)[\s\S]*$/i;
const ANY_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"<>]+/gi;

const HTTP_STATUS_RE = /^(?:视频源执行失败：\s*)?(?:Error:\s*)?HTTP\s+(\d{3})\b/i;
const PROXY_FAIL_RE = /\b(?:proxy|tunnel|socks5?h?|InvalidContentType|corrupt message)\b/i;
const TIMEOUT_FAIL_RE = /\b(?:timed?\s*out|timeout|deadline has elapsed)\b|请求超时|连接超时/i;
const DNS_FAIL_RE = /\b(?:dns error|failed to lookup|name or service not known|nodename nor servname|no such host|temporary failure in name resolution)\b|没有可用的\s*DNS|备用\s*DNS|DNS\s*解析/i;
const TLS_FAIL_RE = /\b(?:tls|ssl|handshake|certificate|webpki|unknown issuer|unexpected eof while reading)\b|证书/i;
const CONN_FAIL_RE = /\b(?:error sending request|error decoding response body|request or response body error|connection refused|connection reset|connection closed|broken pipe|network is unreachable|host is unreachable|channel closed|incomplete message|unexpected end of file|tcp connect error|client error \(connect\)|hyper::Error)\b/i;
const SEC_POLICY_RE = /严格模式下仅允许|禁止访问普通内网|禁止访问本机|禁止访问应用内部协议|禁止\s*HTTPS\s*降级|目标域名未在视频源|重定向目标不在|目标地址含控制字符|目标只允许不带认证信息的/i;
const REDIRECT_FAIL_RE = /重定向次数超|重定向已拒绝|重定向缺少|重定向异常终止/i;
const SRC_TIMEOUT_RE = /视频源脚本执行超时/i;
const SRC_UNSUPPORTED_RE = /当前视频源未实现该方法/i;
const SRC_PARSE_RE = /视频源返回\s*JSON\s*无效|JSON\.parse|Unexpected token|响应体超出上限|HTML\s*文本超出解析上限/i;
const SRC_RUNTIME_RE = /视频源执行失败|加载视频源脚本失败|初始化\s*QuickJS|视频源沙箱线程异常|视频源未导出有效对象|eval_script|\b(?:TypeError|ReferenceError|SyntaxError|RangeError):/i;

/** Append a unified error code to a user-facing reason using locale punctuation. */
export function formatErrorWithCode(reason: string, code: string): string {
  return tr("{0}（{1}）", reason, code);
}

/** Strip JS stacks and embedded URLs so diagnostic logs stay readable and URL-free. */
export function sanitizeErrorForLog(raw: string): string {
  const withoutStack = raw.replace(JS_STACK_TAIL, "").split(/\r?\n/)[0] ?? raw;
  const withoutUrls = withoutStack.replace(ANY_URL, "[url]").replace(/\s+/g, " ").trim();
  return withoutUrls.length > 140 ? `${withoutUrls.slice(0, 140)}…` : withoutUrls;
}

/** Classify any Tauri IPC / source sandbox error into a unified code + user-facing reason. */
export function classifyApiError(rawError: unknown): ClassifiedApiError {
  const raw = (
    typeof rawError === "string"
      ? rawError
      : rawError instanceof Error
        ? rawError.message
        : ""
  ).trim();

  if (!raw) {
    return {
      code: "NET_CONN",
      message: formatErrorWithCode(tr("请求失败，请检查网络"), "NET_CONN"),
      networkish: true,
      status: null,
      logSummary: "empty error",
    };
  }

  const logSummary = sanitizeErrorForLog(raw);

  if (raw === "401") {
    return { code: "AUTH_401", message: "401", networkish: false, status: "401", logSummary: "401" };
  }

  const httpMatch = HTTP_STATUS_RE.exec(raw);
  if (httpMatch) {
    const status = httpMatch[1];
    if (status === "401") {
      return { code: "AUTH_401", message: "401", networkish: false, status: "401", logSummary: "HTTP 401" };
    }
    const code = `HTTP_${Number(status)}` as ApiErrorCode;
    const message = status === "429"
      ? tr("请求过于频繁（HTTP 429），请稍后再试")
      : tr("服务器请求失败（HTTP {0}），请稍后重试或在设置中切换线路", status);
    return { code, message, networkish: false, status, logSummary };
  }

  if (SRC_TIMEOUT_RE.test(raw)) {
    return {
      code: "SRC_TIMEOUT",
      message: formatErrorWithCode(tr("视频源脚本执行超时，请稍后重试"), "SRC_TIMEOUT"),
      networkish: false,
      status: null,
      logSummary,
    };
  }

  if (PROXY_FAIL_RE.test(raw)) {
    return {
      code: "NET_PROXY",
      message: formatErrorWithCode(tr("代理连接异常，请检查设置中的代理配置"), "NET_PROXY"),
      networkish: true,
      status: null,
      logSummary,
    };
  }

  if (TIMEOUT_FAIL_RE.test(raw)) {
    return {
      code: "NET_TIMEOUT",
      message: formatErrorWithCode(tr("请求超时，请检查网络或切换线路"), "NET_TIMEOUT"),
      networkish: true,
      status: null,
      logSummary,
    };
  }

  if (DNS_FAIL_RE.test(raw)) {
    return {
      code: "NET_DNS",
      message: formatErrorWithCode(tr("域名解析失败，请检查网络或切换线路"), "NET_DNS"),
      networkish: true,
      status: null,
      logSummary,
    };
  }

  if (TLS_FAIL_RE.test(raw)) {
    return {
      code: "NET_TLS",
      message: formatErrorWithCode(tr("安全连接握手失败，请检查代理、系统时间或切换线路"), "NET_TLS"),
      networkish: true,
      status: null,
      logSummary,
    };
  }

  if (CONN_FAIL_RE.test(raw)) {
    return {
      code: "NET_CONN",
      message: formatErrorWithCode(tr("网络连接失败，请检查网络或切换线路"), "NET_CONN"),
      networkish: true,
      status: null,
      logSummary,
    };
  }

  if (SEC_POLICY_RE.test(raw)) {
    return {
      code: "SEC_POLICY",
      message: formatErrorWithCode(tr("请求被安全策略拦截，请检查线路、代理或视频源配置"), "SEC_POLICY"),
      networkish: false,
      status: null,
      logSummary,
    };
  }

  if (REDIRECT_FAIL_RE.test(raw)) {
    return {
      code: "NET_REDIRECT",
      message: formatErrorWithCode(tr("请求重定向异常，请切换线路或稍后重试"), "NET_REDIRECT"),
      networkish: false,
      status: null,
      logSummary,
    };
  }

  if (SRC_UNSUPPORTED_RE.test(raw)) {
    return {
      code: "SRC_UNSUPPORTED",
      message: formatErrorWithCode(tr("当前视频源不支持该功能"), "SRC_UNSUPPORTED"),
      networkish: false,
      status: null,
      logSummary,
    };
  }

  if (SRC_PARSE_RE.test(raw)) {
    return {
      code: "SRC_PARSE",
      message: formatErrorWithCode(tr("视频源返回数据异常，请重试或更新视频源"), "SRC_PARSE"),
      networkish: false,
      status: null,
      logSummary,
    };
  }

  if (SRC_RUNTIME_RE.test(raw)) {
    return {
      code: "SRC_RUNTIME",
      message: formatErrorWithCode(tr("视频源执行异常，请重试或更新视频源"), "SRC_RUNTIME"),
      networkish: false,
      status: null,
      logSummary,
    };
  }

  // Pass through explicit Chinese/business messages (e.g. wrong password, all lines down) intact.
  const clean = logSummary || tr("请求失败，请检查网络");
  return {
    code: "APP_ERROR",
    message: clean,
    networkish: false,
    status: null,
    logSummary: clean,
  };
}
