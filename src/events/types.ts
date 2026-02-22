export type TaskEvent =
  | { type: "task_start"; repoUrl: string; context: string; agent: string }
  | { type: "vm_acquired"; vmId: string; provider: string; ip: string }
  | { type: "phase"; name: string }
  | { type: "output"; stream: "stdout" | "stderr"; text: string }
  | { type: "task_end"; status: "completed" | "failed"; exitCode: number | null; error?: string; prUrl?: string };

export interface EventEnvelope {
  taskId: string;
  timestamp: string;
  seq: number;
  event: TaskEvent;
}
