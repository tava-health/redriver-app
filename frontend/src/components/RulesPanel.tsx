import { useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  conditionSummary,
  exportAllRules,
  importAllRules,
  nextId,
  type Rule,
  type RuleCondition,
  type RuleAction,
} from "@/lib/rules";

type Props = {
  rules: Rule[];
  onRulesChange: (rules: Rule[]) => void;
  onImport: () => void;
  queueName?: string;
};

const CONDITION_TYPES: { value: RuleCondition["type"]; label: string }[] = [
  { value: "bodyContains", label: "Body contains" },
  { value: "bodyJson", label: "Body JSON path" },
  { value: "attribute", label: "Attribute" },
];

const ACTIONS: { value: RuleAction; label: string }[] = [
  { value: "auto-retry", label: "Auto-retry" },
  { value: "auto-delete", label: "Auto-delete" },
];

function emptyCondition(type: RuleCondition["type"]): RuleCondition {
  switch (type) {
    case "bodyContains":
      return { type: "bodyContains", value: "" };
    case "bodyJson":
      return { type: "bodyJson", path: "", op: "equals", value: "" };
    case "attribute":
      return { type: "attribute", name: "", value: "" };
  }
}

export function RulesPanel({ rules, onRulesChange, onImport, queueName }: Props) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newConditionType, setNewConditionType] = useState<RuleCondition["type"]>("bodyContains");
  const [newCondition, setNewCondition] = useState<RuleCondition>(emptyCondition("bodyContains"));
  const [newAction, setNewAction] = useState<RuleAction>("auto-retry");
  const [newRequiredPreviews, setNewRequiredPreviews] = useState(2);

  const importRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const data = exportAllRules();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "redriver-rules.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        importAllRules(data);
        onImport();
        toast.success("Rules imported successfully");
      } catch {
        toast.error("Invalid rules file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const startAdd = () => {
    setAdding(true);
    setNewName("");
    setNewConditionType("bodyContains");
    setNewCondition(emptyCondition("bodyContains"));
    setNewAction("auto-retry");
    setNewRequiredPreviews(2);
  };

  const cancelAdd = () => {
    setAdding(false);
  };

  const saveAdd = () => {
    if (!newCondition) return;
    if (newCondition.type === "bodyContains" && !newCondition.value.trim()) return;
    if (newCondition.type === "bodyJson" && (!newCondition.path.trim() || !newCondition.value.trim())) return;
    if (newCondition.type === "attribute" && (!newCondition.name.trim() || !newCondition.value.trim())) return;
    const rule: Rule = {
      id: nextId(),
      name: newName.trim() || "Unnamed rule",
      condition: { ...newCondition },
      action: newAction,
      requiredPreviews: Math.max(1, newRequiredPreviews),
      previewCount: 0,
    };
    onRulesChange([...rules, rule]);
    setAdding(false);
  };

  const removeRule = (id: string) => {
    onRulesChange(rules.filter((r) => r.id !== id));
  };

  const updateConditionType = (type: RuleCondition["type"]) => {
    setNewConditionType(type);
    setNewCondition(emptyCondition(type));
  };

  return (
    <TooltipProvider delayDuration={300}>
    <Card className="h-fit">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Rules</CardTitle>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={handleExport}>
                  <Download className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Export all rules</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => importRef.current?.click()}>
                  <Upload className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Import rules</TooltipContent>
            </Tooltip>
            <input ref={importRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
          </div>
        </div>
        {!queueName && (
          <p className="text-xs text-muted-foreground">Select a dead-letter queue to configure its rules.</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {queueName && rules.length === 0 && !adding && (
          <p className="text-sm text-foreground">No rules for <span className="font-medium text-muted-foreground">{queueName}</span>.<br /><br />Add one to auto-delete or auto-retry by message data.</p>
        )}
        {rules.map((r) => (
          <div
            key={r.id}
            className="rounded-md border border-border bg-muted/20 p-3 text-sm space-y-1"
          >
            <div className="font-medium">{r.name || "Unnamed"}</div>
            <div className="text-muted-foreground">{conditionSummary(r)}</div>
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs">
                {r.action === "auto-retry" ? "Retry" : "Delete"} ·{" "}
                {r.previewCount >= r.requiredPreviews ? (
                  <span className="text-green-600 dark:text-green-400">Live</span>
                ) : (
                  <span>Preview {r.previewCount} / {r.requiredPreviews}</span>
                )}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => removeRule(r.id)}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Delete rule</TooltipContent>
              </Tooltip>
            </div>
          </div>
        ))}

        {adding ? (
          <div className="rounded-md border border-border bg-muted/20 p-3 space-y-3">
            <Input
              placeholder="Rule name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="text-sm"
            />
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Condition</label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={newConditionType}
                onChange={(e) => updateConditionType(e.target.value as RuleCondition["type"])}
              >
                {CONDITION_TYPES.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              {newCondition.type === "bodyContains" && (
                <Input
                  placeholder="Substring to match in body"
                  value={newCondition.value}
                  onChange={(e) => setNewCondition({ ...newCondition, value: e.target.value })}
                  className="mt-2 text-sm"
                />
              )}
              {newCondition.type === "bodyJson" && (
                <div className="mt-2 space-y-2">
                  <Input
                    placeholder="JSON path (e.g. eventType or payload.reason)"
                    value={newCondition.path}
                    onChange={(e) => setNewCondition({ ...newCondition, path: e.target.value })}
                    className="text-sm"
                  />
                  <select
                    className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                    value={newCondition.op}
                    onChange={(e) => setNewCondition({ ...newCondition, op: e.target.value as "equals" | "contains" })}
                  >
                    <option value="equals">equals</option>
                    <option value="contains">contains</option>
                  </select>
                  <Input
                    placeholder="Value"
                    value={newCondition.value}
                    onChange={(e) => setNewCondition({ ...newCondition, value: e.target.value })}
                    className="text-sm"
                  />
                </div>
              )}
              {newCondition.type === "attribute" && (
                <div className="mt-2 space-y-2">
                  <Input
                    placeholder="Attribute name (e.g. MessageGroupId)"
                    value={newCondition.name}
                    onChange={(e) => setNewCondition({ ...newCondition, name: e.target.value })}
                    className="text-sm"
                  />
                  <Input
                    placeholder="Value"
                    value={newCondition.value}
                    onChange={(e) => setNewCondition({ ...newCondition, value: e.target.value })}
                    className="text-sm"
                  />
                </div>
              )}
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Action</label>
              <select
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                value={newAction}
                onChange={(e) => setNewAction(e.target.value as RuleAction)}
              >
                {ACTIONS.map((a) => (
                  <option key={a.value} value={a.value}>{a.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Require previews before auto-apply</label>
              <Input
                type="number"
                min={1}
                max={10}
                value={newRequiredPreviews}
                onChange={(e) => setNewRequiredPreviews(parseInt(e.target.value, 10) || 1)}
                className="text-sm"
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={saveAdd}>Add rule</Button>
              <Button size="sm" variant="outline" onClick={cancelAdd}>Cancel</Button>
            </div>
          </div>
        ) : null}

        {!adding && queueName && (
          <Button type="button" variant="outline" size="sm" className="w-full" onClick={startAdd}>
            Add rule
          </Button>
        )}

      </CardContent>
    </Card>
    </TooltipProvider>
  );
}
