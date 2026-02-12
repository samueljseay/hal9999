export type VmStatus =
  | "provisioning"
  | "ready"
  | "assigned"
  | "destroying"
  | "destroyed"
  | "error";

export interface VmRow {
  id: string;
  label: string;
  ip: string | null;
  status: VmStatus;
  task_id: string | null;
  snapshot_id: string;
  region: string;
  plan: string;
  created_at: string;
  updated_at: string;
  error: string | null;
}

export type TaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "completed"
  | "failed";

export interface TaskRow {
  id: string;
  repo_url: string;
  context: string;
  status: TaskStatus;
  vm_id: string | null;
  result: string | null;
  exit_code: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}
