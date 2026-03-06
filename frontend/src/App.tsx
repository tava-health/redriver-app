import { useState, useCallback, useRef, useEffect } from "react";
import { Toaster } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ShipWheel } from "lucide-react";
import { QueueSelector, type QueueOption } from "@/components/QueueSelector";
import { RulesPanel } from "@/components/RulesPanel";
import { loadRules, saveRules, evaluateRule, type Rule } from "@/lib/rules";

const API = "/api";

type QueueUrls = { dlqUrl: string; targetUrl: string; sessionId?: string };

export type SqsMessage = {
  MessageId?: string;
  ReceiptHandle?: string;
  Body?: string;
  Attributes?: Record<string, string>;
  MessageAttributes?: Record<
    string,
    { DataType?: string; StringValue?: string }
  >;
};

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

type TabId = "rabbitmq" | "aws";

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>("rabbitmq");
  const [queues, setQueues] = useState<QueueOption[]>([]);
  const [queuesLoading, setQueuesLoading] = useState(false);
  const [queuesError, setQueuesError] = useState<string | null>(null);
  const [selectedDlq, setSelectedDlq] = useState<QueueOption | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<QueueOption | null>(
    null
  );
  const [dryRun, setDryRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [urls, setUrls] = useState<QueueUrls | null>(null);
  const [currentMessage, setCurrentMessage] = useState<SqsMessage | null>(null);
  const [pendingMessages, setPendingMessages] = useState<SqsMessage[]>([]);
  const [status, setStatus] = useState<
    "idle" | "connecting" | "polling" | "ready"
  >("idle");
  const [rules, setRules] = useState<Rule[]>([]);
  const [previewRule, setPreviewRule] = useState<Rule | null>(null);
  const [processing, setProcessing] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<SqsMessage[]>([]);

  // Load rules for the selected DLQ whenever it changes
  useEffect(() => {
    setRules(selectedDlq ? loadRules(selectedDlq.name) : []);
  }, [selectedDlq?.name]);

  // Save rules scoped to the selected DLQ
  useEffect(() => {
    if (selectedDlq) saveRules(rules, selectedDlq.name);
  }, [rules, selectedDlq?.name]);

  pendingRef.current = pendingMessages; // keep ref in sync so processPendingQueue can read latest

  useEffect(() => {
    setQueuesLoading(true);
    setQueuesError(null);
    const endpoint =
      activeTab === "aws" ? `${API}/queues` : `${API}/rabbitmq/queues`;
    let cancelled = false;
    fetch(endpoint)
      .then(async (res) => {
        const data = await res.json();
        if (cancelled) return;
        setQueues(data.queues ?? []);
        setQueuesError(!res.ok ? data.error || "Failed to list queues" : null);
      })
      .catch((e) => {
        if (!cancelled) {
          setQueuesError(
            e instanceof Error ? e.message : "Failed to list queues"
          );
          setQueues([]);
        }
      })
      .finally(() => {
        if (!cancelled) setQueuesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  const start = useCallback(async () => {
    if (!selectedDlq?.url || !selectedTarget?.url) {
      setError("Select both a dead-letter queue and a target queue.");
      return;
    }
    setError(null);
    if (activeTab === "rabbitmq") {
      try {
        const res = await fetch(`${API}/rabbitmq/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            dlqName: selectedDlq.name,
            targetName: selectedTarget.name,
          }),
        });
        const data = await res.json();
        if (!res.ok)
          throw new Error(data.error || "Failed to start RabbitMQ session");
        setUrls({
          dlqUrl: selectedDlq.name,
          targetUrl: selectedTarget.name,
          sessionId: data.sessionId,
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to start");
        return;
      }
    } else {
      setUrls({ dlqUrl: selectedDlq.url, targetUrl: selectedTarget.url });
    }
    setStatus("polling");
    setCurrentMessage(null);
    setPendingMessages([]);
    setPreviewRule(null);
  }, [activeTab, selectedDlq, selectedTarget]);

  const applyResend = useCallback(
    async (msg: SqsMessage): Promise<boolean> => {
      if (!urls) return false;
      const isRabbit = Boolean(urls.sessionId);
      const body = isRabbit
        ? {
            sessionId: urls.sessionId,
            dlqName: urls.dlqUrl,
            targetName: urls.targetUrl,
            body: msg.Body ?? "",
            receiptHandle: msg.ReceiptHandle,
            dryRun: false,
          }
        : {
            dlqUrl: urls.dlqUrl,
            targetUrl: urls.targetUrl,
            body: msg.Body ?? "",
            receiptHandle: msg.ReceiptHandle,
            messageGroupId: msg.Attributes?.MessageGroupId,
            messageDeduplicationId: msg.Attributes?.MessageDeduplicationId,
            messageAttributes: msg.MessageAttributes,
            dryRun: false,
          };
      const res = await fetch(`${API}${isRabbit ? "/rabbitmq" : ""}/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    },
    [urls]
  );

  const applyDelete = useCallback(
    async (msg: SqsMessage): Promise<boolean> => {
      if (!urls) return false;
      const isRabbit = Boolean(urls.sessionId);
      const body = isRabbit
        ? {
            sessionId: urls.sessionId,
            dlqName: urls.dlqUrl,
            receiptHandle: msg.ReceiptHandle,
            dryRun: false,
          }
        : {
            dlqUrl: urls.dlqUrl,
            receiptHandle: msg.ReceiptHandle,
            dryRun: false,
          };
      const res = await fetch(`${API}${isRabbit ? "/rabbitmq" : ""}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok;
    },
    [urls]
  );

  const poll = useCallback(async () => {
    if (!urls?.dlqUrl) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const isRabbit = Boolean(urls.sessionId);
    try {
      const url = isRabbit
        ? `${API}/rabbitmq/receive?sessionId=${encodeURIComponent(
            urls.sessionId!
          )}`
        : `${API}/receive?dlqUrl=${encodeURIComponent(urls.dlqUrl)}`;
      const res = await fetch(url, { signal: ctrl.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Receive failed");
      const messages: SqsMessage[] = data.messages ?? [];
      if (messages.length > 0) {
        setPendingMessages((prev) => [...prev, ...messages]);
        setCurrentMessage(null);
        setStatus("ready");
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof Error ? e.message : "Receive failed");
    } finally {
      abortRef.current = null;
    }
  }, [urls]);

  useEffect(() => {
    if (!urls || status !== "polling") return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const run = () => {
      poll().then(() => {
        if (cancelled) return;
        timeoutId = setTimeout(run, 2000);
      });
    };
    run();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      if (abortRef.current) abortRef.current.abort();
    };
  }, [urls, status, poll]);

  const processPendingQueue = useCallback(() => {
    const pending = pendingRef.current;
    if (pending.length === 0) return;
    const first = pending[0];
    const matchedRule = rules.find((r) => evaluateRule(r, first));
    if (
      matchedRule &&
      matchedRule.previewCount >= matchedRule.requiredPreviews
    ) {
      setProcessing(true);
      const apply =
        matchedRule.action === "auto-retry"
          ? applyResend(first)
          : applyDelete(first);
      apply.then((ok) => {
        setProcessing(false);
        if (ok) {
          setPendingMessages((p) => p.slice(1));
          setCurrentMessage(null);
        } else {
          setCurrentMessage(first);
          setPreviewRule(null);
        }
      });
      return;
    }
    if (matchedRule) {
      setRules((prev) =>
        prev.map((r) =>
          r.id === matchedRule.id
            ? { ...r, previewCount: r.previewCount + 1 }
            : r
        )
      );
      setCurrentMessage(first);
      setPreviewRule(matchedRule);
    } else {
      setCurrentMessage(first);
      setPreviewRule(null);
    }
  }, [rules, applyResend, applyDelete]);

  useEffect(() => {
    if (
      status !== "ready" ||
      pendingMessages.length === 0 ||
      currentMessage !== null ||
      processing
    ) {
      return;
    }
    processPendingQueue();
  }, [
    status,
    pendingMessages.length,
    currentMessage,
    processing,
    processPendingQueue,
  ]);

  // When queue is drained (e.g. after rule auto-apply), resume polling
  useEffect(() => {
    if (
      urls &&
      status === "ready" &&
      pendingMessages.length === 0 &&
      !processing
    ) {
      setStatus("polling");
    }
  }, [urls, status, pendingMessages.length, processing]);

  const showNext = useCallback(() => {
    setPendingMessages((prev) => {
      const rest = prev.slice(1);
      setCurrentMessage(null);
      setPreviewRule(null);
      if (rest.length === 0) setStatus("polling");
      return rest;
    });
  }, []);

  const resend = useCallback(async () => {
    if (!urls || !currentMessage?.ReceiptHandle) return;
    setError(null);
    const isRabbit = Boolean(urls.sessionId);
    const body = isRabbit
      ? {
          sessionId: urls.sessionId,
          dlqName: urls.dlqUrl,
          targetName: urls.targetUrl,
          body: currentMessage.Body ?? "",
          receiptHandle: currentMessage.ReceiptHandle,
          dryRun,
        }
      : {
          dlqUrl: urls.dlqUrl,
          targetUrl: urls.targetUrl,
          body: currentMessage.Body ?? "",
          receiptHandle: currentMessage.ReceiptHandle,
          messageGroupId: currentMessage.Attributes?.MessageGroupId,
          messageDeduplicationId:
            currentMessage.Attributes?.MessageDeduplicationId,
          messageAttributes: currentMessage.MessageAttributes,
          dryRun,
        };
    try {
      const res = await fetch(`${API}${isRabbit ? "/rabbitmq" : ""}/resend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Resend failed");
      showNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Resend failed");
    }
  }, [urls, currentMessage, dryRun, showNext]);

  const deleteOnly = useCallback(async () => {
    if (!urls || !currentMessage?.ReceiptHandle) return;
    setError(null);
    const isRabbit = Boolean(urls.sessionId);
    const body = isRabbit
      ? {
          sessionId: urls.sessionId,
          dlqName: urls.dlqUrl,
          receiptHandle: currentMessage.ReceiptHandle,
          dryRun,
        }
      : {
          dlqUrl: urls.dlqUrl,
          receiptHandle: currentMessage.ReceiptHandle,
          dryRun,
        };
    try {
      const res = await fetch(`${API}${isRabbit ? "/rabbitmq" : ""}/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Delete failed");
      showNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }, [urls, currentMessage, dryRun, showNext]);

  const skip = useCallback(async () => {
    if (!urls || !currentMessage?.ReceiptHandle) return;
    if (urls.sessionId) {
      setError(null);
      try {
        const res = await fetch(`${API}/rabbitmq/skip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: urls.sessionId,
            receiptHandle: currentMessage.ReceiptHandle,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Skip failed");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Skip failed");
        return;
      }
    }
    showNext();
  }, [urls, currentMessage, showNext]);

  const quit = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    if (urls?.sessionId) {
      try {
        await fetch(`${API}/rabbitmq/quit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: urls.sessionId }),
        });
      } catch (_) {}
    }
    setUrls(null);
    setCurrentMessage(null);
    setPendingMessages([]);
    setPreviewRule(null);
    setStatus("idle");
  }, [urls]);

  const handleRulesChange = useCallback((next: Rule[]) => {
    setRules(next);
  }, []);

  const handleImport = useCallback(() => {
    setRules(selectedDlq ? loadRules(selectedDlq.name) : []);
  }, [selectedDlq?.name]);

  const isConfigDisabled = status !== "idle";

  // Blur before action so when the message block unmounts the button didn't have focus (avoids scroll-to-top)
  const blurThen =
    (fn: () => void) => (e: React.MouseEvent<HTMLButtonElement>) => {
      (e.currentTarget as HTMLElement).blur();
      fn();
    };

  return (
    <div className="min-h-screen p-6 flex flex-col items-center">
      <Toaster position="bottom-center" richColors />
      <div className="w-full max-w-5xl space-y-6">
        <h1 className="text-2xl font-semibold text-foreground flex items-center gap-2">
          <ShipWheel className="w-7 h-7 animate-spin [animation-duration:4s]" />
          Redriver — Revenge of the Queue
        </h1>

        <Tabs
          value={activeTab}
          onValueChange={(v) => {
            setActiveTab(v as TabId);
            setSelectedDlq(null);
            setSelectedTarget(null);
            quit();
          }}
        >
          <TabsList>
            <TabsTrigger value="rabbitmq">RabbitMQ</TabsTrigger>
            <TabsTrigger value="aws">AWS SQS</TabsTrigger>
          </TabsList>

          <TabsContent value="rabbitmq">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
              <div className="flex-1 min-w-0 space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Configuration</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {queuesError && (
                      <p className="text-sm text-destructive">{queuesError}</p>
                    )}
                    {queuesLoading ? (
                      <p className="text-sm text-muted-foreground">
                        Loading queues…
                      </p>
                    ) : (
                      <>
                        <QueueSelector
                          label="Dead-letter queue"
                          options={queues}
                          value={selectedDlq}
                          onChange={setSelectedDlq}
                          placeholder="Type to search queues…"
                          disabled={isConfigDisabled}
                        />
                        <QueueSelector
                          label="Target queue"
                          options={queues}
                          value={selectedTarget}
                          onChange={setSelectedTarget}
                          placeholder="Type to search queues…"
                          disabled={isConfigDisabled}
                        />
                      </>
                    )}

                    {error && (
                      <p className="text-sm text-destructive">{error}</p>
                    )}
                    <div className="flex gap-2 pt-2">
                      <Button
                        onClick={() => start()}
                        disabled={isConfigDisabled}
                      >
                        Start
                      </Button>
                      {urls && (
                        <Button variant="outline" onClick={quit}>
                          Quit
                        </Button>
                      )}
                      <span className="flex-1"></span>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="dry-run-rmq"
                          checked={dryRun}
                          onCheckedChange={(c) => setDryRun(c === true)}
                          disabled={isConfigDisabled}
                        />
                        <label
                          htmlFor="dry-run-rmq"
                          className="text-sm font-medium text-foreground cursor-pointer"
                        >
                          Dry run (no send/delete)
                        </label>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {urls &&
                  urls.sessionId &&
                  (status === "polling" || status === "ready") && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">
                          {status === "polling"
                            ? "Polling for messages…"
                            : `Current message${
                                pendingMessages.length > 1
                                  ? ` (${pendingMessages.length} in buffer)`
                                  : ""
                              }`}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {processing && (
                          <p className="text-sm text-muted-foreground">
                            Applying rule…
                          </p>
                        )}
                        {currentMessage ? (
                          <>
                            {previewRule && (
                              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                                <strong>
                                  Rule &quot;{previewRule.name}&quot;
                                </strong>{" "}
                                would{" "}
                                {previewRule.action === "auto-retry"
                                  ? "auto-retry"
                                  : "auto-delete"}{" "}
                                (preview {previewRule.previewCount}/
                                {previewRule.requiredPreviews}). After{" "}
                                {previewRule.requiredPreviews} matches this rule
                                runs automatically.
                              </div>
                            )}
                            <div className="rounded-md border border-border bg-muted/30 p-4 font-mono text-sm overflow-x-auto space-y-1">
                              <p>
                                <span className="text-muted-foreground">
                                  MessageId:
                                </span>{" "}
                                {currentMessage.MessageId}
                              </p>
                              <p>
                                <span className="text-muted-foreground">
                                  DeliveryTag:
                                </span>{" "}
                                {currentMessage.Attributes?.deliveryTag}
                              </p>
                              <p>
                                <span className="text-muted-foreground">
                                  Redelivered:
                                </span>{" "}
                                {currentMessage.Attributes?.redelivered}
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button onClick={blurThen(resend)}>Resend</Button>
                              <Button
                                variant="secondary"
                                onClick={blurThen(skip)}
                              >
                                Skip
                              </Button>
                              <Button
                                variant="destructive"
                                onClick={blurThen(deleteOnly)}
                              >
                                Delete only
                              </Button>
                              <Button
                                variant="outline"
                                onClick={blurThen(quit)}
                              >
                                Quit
                              </Button>
                            </div>
                            <pre className="rounded-md border border-border bg-muted/30 p-4 text-sm overflow-x-auto whitespace-pre-wrap break-words">
                              {prettyBody(currentMessage.Body ?? "")}
                            </pre>
                          </>
                        ) : !processing ? (
                          <p className="text-muted-foreground">
                            No messages in queue. Polling…
                          </p>
                        ) : null}
                      </CardContent>
                    </Card>
                  )}
              </div>

              <div className="w-full lg:w-80 lg:shrink-0 lg:sticky lg:top-6">
                <RulesPanel
                  rules={rules}
                  onRulesChange={handleRulesChange}
                  onImport={handleImport}
                  queueName={selectedDlq?.name}
                />
              </div>
            </div>
          </TabsContent>

          <TabsContent value="aws">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
              <div className="flex-1 min-w-0 space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Configuration</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {queuesError && (
                      <p className="text-sm text-destructive">{queuesError}</p>
                    )}
                    {queuesLoading ? (
                      <p className="text-sm text-muted-foreground">
                        Loading queues…
                      </p>
                    ) : (
                      <>
                        <QueueSelector
                          label="Dead-letter queue"
                          options={queues}
                          value={selectedDlq}
                          onChange={setSelectedDlq}
                          placeholder="Type to search queues…"
                          disabled={isConfigDisabled}
                        />
                        <QueueSelector
                          label="Target queue"
                          options={queues}
                          value={selectedTarget}
                          onChange={setSelectedTarget}
                          placeholder="Type to search queues…"
                          disabled={isConfigDisabled}
                        />
                      </>
                    )}

                    {error && (
                      <p className="text-sm text-destructive">{error}</p>
                    )}
                    <div className="flex gap-2 pt-2">
                      <Button onClick={start} disabled={isConfigDisabled}>
                        Start
                      </Button>
                      {urls && (
                        <Button variant="outline" onClick={quit}>
                          Quit
                        </Button>
                      )}
                      <span className="flex-1"></span>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="dry-run"
                          checked={dryRun}
                          onCheckedChange={(c) => setDryRun(c === true)}
                          disabled={isConfigDisabled}
                        />
                        <label
                          htmlFor="dry-run"
                          className="text-sm font-medium text-foreground cursor-pointer"
                        >
                          Dry run (no send/delete)
                        </label>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {urls &&
                  !urls.sessionId &&
                  (status === "polling" || status === "ready") && (
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-lg">
                          {status === "polling"
                            ? "Polling for messages…"
                            : `Current message${
                                pendingMessages.length > 1
                                  ? ` (${pendingMessages.length} in buffer)`
                                  : ""
                              }`}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        {processing && (
                          <p className="text-sm text-muted-foreground">
                            Applying rule…
                          </p>
                        )}
                        {currentMessage ? (
                          <>
                            {previewRule && (
                              <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                                <strong>
                                  Rule &quot;{previewRule.name}&quot;
                                </strong>{" "}
                                would{" "}
                                {previewRule.action === "auto-retry"
                                  ? "auto-retry"
                                  : "auto-delete"}{" "}
                                (preview {previewRule.previewCount}/
                                {previewRule.requiredPreviews}). After{" "}
                                {previewRule.requiredPreviews} matches this rule
                                runs automatically.
                              </div>
                            )}
                            <div className="rounded-md border border-border bg-muted/30 p-4 font-mono text-sm overflow-x-auto space-y-1">
                              <p>
                                <span className="text-muted-foreground">
                                  MessageId:
                                </span>{" "}
                                {currentMessage.MessageId}
                              </p>
                              <p>
                                <span className="text-muted-foreground">
                                  ReceiveCount:
                                </span>{" "}
                                {
                                  currentMessage.Attributes
                                    ?.ApproximateReceiveCount
                                }
                              </p>
                              <p>
                                <span className="text-muted-foreground">
                                  GroupId:
                                </span>{" "}
                                {currentMessage.Attributes?.MessageGroupId}
                              </p>
                              <p>
                                <span className="text-muted-foreground">
                                  DedupId:
                                </span>{" "}
                                {
                                  currentMessage.Attributes
                                    ?.MessageDeduplicationId
                                }
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Button onClick={blurThen(resend)}>Resend</Button>
                              <Button
                                variant="secondary"
                                onClick={blurThen(skip)}
                              >
                                Skip
                              </Button>
                              <Button
                                variant="destructive"
                                onClick={blurThen(deleteOnly)}
                              >
                                Delete only
                              </Button>
                              <Button
                                variant="outline"
                                onClick={blurThen(quit)}
                              >
                                Quit
                              </Button>
                            </div>
                            <pre className="rounded-md border border-border bg-muted/30 p-4 text-sm overflow-x-auto whitespace-pre-wrap break-words">
                              {prettyBody(currentMessage.Body ?? "")}
                            </pre>
                          </>
                        ) : !processing ? (
                          <p className="text-muted-foreground">
                            No messages in queue. Polling…
                          </p>
                        ) : null}
                      </CardContent>
                    </Card>
                  )}
              </div>

              <div className="w-full lg:w-80 lg:shrink-0 lg:sticky lg:top-6">
                <RulesPanel
                  rules={rules}
                  onRulesChange={handleRulesChange}
                  onImport={handleImport}
                  queueName={selectedDlq?.name}
                />
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
