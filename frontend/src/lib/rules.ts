export type MessageForRule = {
  Body?: string;
  Attributes?: Record<string, string>;
};

export type RuleCondition =
  | { type: "bodyContains"; value: string }
  | { type: "bodyJson"; path: string; op: "equals" | "contains"; value: string }
  | { type: "attribute"; name: string; value: string };

export type RuleAction = "auto-delete" | "auto-retry";

export type Rule = {
  id: string;
  name: string;
  condition: RuleCondition;
  action: RuleAction;
  requiredPreviews: number;
  previewCount: number;
};

const STORAGE_PREFIX = "dlq-redrive-rules";

function storageKey(queueName?: string): string {
  return queueName ? `${STORAGE_PREFIX}:${queueName}` : STORAGE_PREFIX;
}

function getAtPath(obj: unknown, path: string): unknown {
  const raw = path.trim().replace(/^\$\.?/, "");
  const parts = raw ? raw.split(".") : [];
  let current: unknown = obj;
  for (const p of parts) {
    if (p === "" || current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[p];
  }
  return current;
}

export function evaluateRule(rule: Rule, message: MessageForRule): boolean {
  const body = message.Body ?? "";
  const attrs = message.Attributes ?? {};

  switch (rule.condition.type) {
    case "bodyContains":
      return body.includes(rule.condition.value);
    case "bodyJson": {
      try {
        const parsed = JSON.parse(body) as unknown;
        const v = getAtPath(parsed, rule.condition.path);
        const pathStr = String(v != null ? v : "");
        const compareStr = String(rule.condition.value ?? "");
        if (rule.condition.op === "equals") return pathStr === compareStr;
        return pathStr.toLowerCase().includes(compareStr.toLowerCase());
      } catch {
        return false;
      }
    }
    case "attribute": {
      const attrVal = attrs[rule.condition.name];
      return attrVal != null && String(attrVal) === rule.condition.value;
    }
    default:
      return false;
  }
}

export function conditionSummary(rule: Rule): string {
  switch (rule.condition.type) {
    case "bodyContains":
      return `body contains "${rule.condition.value.slice(0, 30)}${rule.condition.value.length > 30 ? "…" : ""}"`;
    case "bodyJson":
      return `${rule.condition.path} ${rule.condition.op} "${rule.condition.value}"`;
    case "attribute":
      return `${rule.condition.name} = "${rule.condition.value}"`;
    default:
      return "—";
  }
}

export function loadRules(queueName?: string): Rule[] {
  try {
    const raw = localStorage.getItem(storageKey(queueName));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Rule[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRules(rules: Rule[], queueName?: string): void {
  localStorage.setItem(storageKey(queueName), JSON.stringify(rules));
}

export function nextId(): string {
  return crypto.randomUUID?.() ?? `rule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function exportAllRules(): Record<string, Rule[]> {
  const result: Record<string, Rule[]> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(STORAGE_PREFIX)) continue;
    try {
      const rules = JSON.parse(localStorage.getItem(key) ?? "[]") as Rule[];
      const queueName = key.slice(STORAGE_PREFIX.length + 1) || "__global__";
      if (Array.isArray(rules) && rules.length > 0) result[queueName] = rules;
    } catch {}
  }
  return result;
}

export function importAllRules(data: Record<string, Rule[]>): void {
  for (const [queueName, rules] of Object.entries(data)) {
    if (Array.isArray(rules)) {
      saveRules(rules, queueName === "__global__" ? undefined : queueName);
    }
  }
}
